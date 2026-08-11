// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Turns a (sensor, vector) into a signed uplink and pushes it to the gateway
 * bridge. Holds one UDP socket and a per-device frame counter so a long-running
 * demo loop sends monotonically increasing FCnts (realistic), while the ABP
 * devices' `skipFcntCheck` still lets a fresh run start back at 0.
 *
 * RF parameters are chosen per frame rather than once per process: the data rate
 * has to be large enough for that vector's payload, and the channel is spread by
 * sensor, so both are a function of what is being sent (see semtech-udp.ts).
 */

import * as dgram from 'node:dgram';
import type { Config } from './config';
import { buildUplink } from './frame';
import {
  assertSupportedRegion,
  buildPushData,
  freqMhzToHz,
  rxParamsForRegion,
  sendDatagram,
} from './semtech-udp';
import type { MockSensor, UplinkVector } from './sensors';

/**
 * What one uplink actually went out as. The RF fields are returned (not just
 * logged) because the e2e suite asserts them against what ChirpStack recorded —
 * `frequencyHz` in particular lines up with `txInfo.frequency`, which ChirpStack
 * reports in Hz while the Semtech rxpk `freq` field is in MHz.
 */
export interface EmitResult {
  fCnt: number;
  /** US915 DR index actually used. */
  dr: number;
  /** LoRa data rate string, e.g. "SF7BW125". */
  datr: string;
  /** The `chan` value reported in the rxpk. */
  channel: number;
  /** Integer Hz, e.g. 902300000 — matches ChirpStack's `txInfo.frequency`. */
  frequencyHz: number;
}

export class Emitter {
  private readonly socket = dgram.createSocket('udp4');
  private readonly fcnt = new Map<string, number>();
  private token = 0;
  private closed = false;

  constructor(private readonly cfg: Config) {
    // Fail at construction, not on the first send: an unsupported region makes
    // every frame unroutable, and inside the demo loop that surfaces only as a
    // per-tick "send failed" line that is easy to mistake for a flaky bridge.
    assertSupportedRegion(cfg.region);
    // Without a listener, dgram re-emits socket errors (ICMP port-unreachable
    // from a bridge that isn't up yet, for one) as an unhandled 'error' event,
    // which takes the whole process down mid-run.
    this.socket.on('error', (err: Error) => {
      console.error('[mock] udp socket error:', err.message);
    });
  }

  /** Build + send one uplink for a sensor. */
  async emit(sensor: MockSensor, vector: UplinkVector): Promise<EmitResult> {
    const fCnt = this.fcnt.get(sensor.devEui) ?? 0;
    // The DR limits are stated against the application payload, so size the link
    // from the vector's bytes — not from the assembled PHYPayload, which carries
    // ~13 bytes of MAC header and MIC on top.
    const rx = rxParamsForRegion(this.cfg.region, vector.bytes.length, sensor.index);
    const phy = buildUplink(
      { devAddr: sensor.devAddr, nwkSKey: sensor.nwkSKey, appSKey: sensor.appSKey },
      vector.fPort,
      Buffer.from(vector.bytes),
      fCnt,
    );
    const packet = buildPushData(this.cfg.gatewayEui, phy, this.token++ & 0xffff, rx);
    await sendDatagram(this.socket, this.cfg.udpHost, this.cfg.udpPort, packet);
    this.fcnt.set(sensor.devEui, fCnt + 1);
    return {
      fCnt,
      dr: rx.dr,
      datr: rx.datr,
      channel: rx.chan,
      frequencyHz: freqMhzToHz(rx.freq),
    };
  }

  /**
   * Release the socket. Idempotent and non-throwing: this runs from a signal
   * handler and from test teardown, where an already-closed (or never-bound)
   * socket must not turn shutdown into a crash.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch (err) {
      console.error('[mock] udp socket close failed:', (err as Error).message);
    }
  }
}
