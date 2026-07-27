// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Downstream observers for the e2e suite: ChirpStack's MQTT application-event
 * stream and the Postgres event store.
 */

import mqtt, { type MqttClient } from 'mqtt';
import { Pool } from 'pg';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The decoded-uplink fields the e2e assertions read from an app event. */
export interface UplinkEvent {
  deviceInfo?: { devEui?: string };
  fPort?: number;
  fCnt?: number;
  object?: Record<string, unknown>;
}

/**
 * Subscribes to ChirpStack's uplink app events and lets a test await the next
 * event for a given DevEUI. Events that arrive before anyone waits are buffered.
 */
export class MqttCollector {
  private client!: MqttClient;
  private readonly buffered = new Map<string, UplinkEvent[]>();
  private readonly waiters = new Map<string, (e: UplinkEvent) => void>();

  async connect(url: string): Promise<void> {
    this.client = mqtt.connect(url);
    await new Promise<void>((resolve, reject) => {
      this.client.once('connect', () => resolve());
      this.client.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      this.client.subscribe('application/+/device/+/event/up', (err) =>
        err ? reject(err) : resolve(),
      );
    });
    this.client.on('message', (_topic, payload) => {
      let evt: UplinkEvent;
      try {
        evt = JSON.parse(payload.toString('utf8')) as UplinkEvent;
      } catch {
        return;
      }
      const eui = evt.deviceInfo?.devEui?.toLowerCase();
      if (!eui) return;
      const waiter = this.waiters.get(eui);
      if (waiter) {
        this.waiters.delete(eui);
        waiter(evt);
      } else {
        const arr = this.buffered.get(eui) ?? [];
        arr.push(evt);
        this.buffered.set(eui, arr);
      }
    });
  }

  /** Resolve with the next uplink event for `devEui`, or reject on timeout. */
  waitFor(devEui: string, timeoutMs: number): Promise<UplinkEvent> {
    const eui = devEui.toLowerCase();
    const queued = this.buffered.get(eui);
    if (queued && queued.length > 0) return Promise.resolve(queued.shift() as UplinkEvent);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(eui);
        reject(new Error(`no MQTT uplink for ${eui} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.set(eui, (e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
  }

  async end(): Promise<void> {
    if (this.client) await new Promise<void>((resolve) => this.client.end(false, {}, () => resolve()));
  }
}

/** Poll `event_up` until a row exists for `devEui`; return its decoded `object`. */
export async function waitForEventUp(
  pool: Pool,
  devEui: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const { rows } = await pool.query<{ object: Record<string, unknown> | null }>(
        'select object from event_up where lower(dev_eui) = lower($1) order by time desc limit 1',
        [devEui],
      );
      if (rows.length > 0 && rows[0].object) return rows[0].object;
    } catch (err) {
      lastErr = err as Error; // table may not exist yet on a brand-new stack
    }
    await sleep(500);
  }
  throw new Error(
    `no event_up row for ${devEui} within ${timeoutMs}ms` +
      (lastErr ? ` (last query error: ${lastErr.message})` : ''),
  );
}
