// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * End-to-end test: a mocked sensor uplink, injected via the Semtech UDP gateway
 * bridge, must be decoded by ChirpStack and land BOTH on the MQTT application
 * stream AND in the Postgres event store — with the decoded `object` matching the
 * codec's own authored expectation.
 *
 * Requires a running stack (see scripts/e2e.sh). Connection details come from the
 * environment / /shared/config.json via loadConfig().
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { loadConfig, type Config } from '../src/config';
import { Emitter } from '../src/emit';
import { provisionAll } from '../src/provision';
import { SENSORS, dataVectors } from '../src/sensors';
import { MqttCollector, waitForEventUp } from './helpers';

const cfg: Config = loadConfig();

let collector: MqttCollector;
let pool: Pool;
let emitter: Emitter;

beforeAll(async () => {
  await provisionAll(cfg);
  collector = new MqttCollector();
  await collector.connect(cfg.mqttUrl);
  pool = new Pool({ connectionString: cfg.pgUrl });
  emitter = new Emitter(cfg);
});

afterAll(async () => {
  emitter?.close();
  await collector?.end();
  await pool?.end();
});

describe('mocked sensor uplinks flow through ChirpStack end-to-end', () => {
  for (const sensor of SENSORS) {
    it(`${sensor.id}: decoded uplink reaches MQTT and event_up`, async () => {
      const vector = dataVectors(sensor)[0];

      // Register the MQTT waiter before sending so we can't miss the event.
      const mqttEvent = collector.waitFor(sensor.devEui, 15_000);
      await emitter.emit(sensor, vector);

      const evt = await mqttEvent;
      expect(evt.deviceInfo?.devEui?.toLowerCase()).toBe(sensor.devEui);
      expect(evt.fPort).toBe(vector.fPort);
      expect(evt.object).toEqual(vector.expected);

      const stored = await waitForEventUp(pool, sensor.devEui, 15_000);
      expect(stored).toEqual(vector.expected);
    });
  }
});
