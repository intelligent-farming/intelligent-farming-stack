// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * mock-sensors CLI.
 *
 *   provision   create the gateway/app/profiles/devices in ChirpStack (idempotent)
 *   run         provision, then continuously emit uplinks from every mock sensor
 */

import { loadConfig } from './config';
import { Emitter } from './emit';
import { provisionAll } from './provision';
import { SENSORS, dataVectors, type UplinkVector } from './sensors';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function runLoop(): Promise<void> {
  const cfg = loadConfig();
  await provisionAll(cfg);

  const emitter = new Emitter(cfg);

  // Resolve every sensor's vectors once, up front. `vectors()` in the codec
  // package re-reads and re-parses the on-disk vector JSON on every call (only
  // `device()` is cached), so calling it per sensor per tick was pure repeated
  // file I/O. Hoisting it also means a missing/empty vector set fails here, at
  // startup, instead of hours into a running loop.
  const vectorsBySensor = new Map<string, UplinkVector[]>(
    SENSORS.map((sensor): [string, UplinkVector[]] => [sensor.id, dataVectors(sensor)]),
  );

  const cursors = new Map<string, number>();
  let stopping = false;
  // Tracks the send currently awaiting the socket callback, so a signal can let
  // it settle rather than yanking the socket out from under it — closing a
  // socket with a send pending can itself throw, inside the signal handler.
  let inFlight: Promise<unknown> = Promise.resolve();
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      // A second signal means "stop waiting"; honour it immediately.
      process.exit(130);
    }
    shuttingDown = true;
    stopping = true;
    console.log(`[mock] ${signal} received — finishing in-flight send, then stopping`);
    void inFlight
      .catch(() => undefined)
      .then(() => {
        emitter.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(
    `[mock] emitting from ${SENSORS.length} sensors every ${cfg.intervalSeconds}s ` +
      `via ${cfg.udpHost}:${cfg.udpPort} (gw ${cfg.gatewayEui}, region ${cfg.region})`,
  );

  while (!stopping) {
    for (const sensor of SENSORS) {
      if (stopping) break;
      const vecs = vectorsBySensor.get(sensor.id) ?? [];
      if (vecs.length === 0) continue;
      const i = (cursors.get(sensor.id) ?? 0) % vecs.length;
      cursors.set(sensor.id, i + 1);
      const vector = vecs[i];
      try {
        const send = emitter.emit(sensor, vector);
        inFlight = send;
        const res = await send;
        // DR and frequency are logged because they are chosen per frame (from the
        // payload size and the sensor index) — without them the operator cannot
        // tell what the harness actually put on the air.
        console.log(
          `[mock] ${sensor.id} devEui=${sensor.devEui} fPort=${vector.fPort} ` +
            `fCnt=${res.fCnt} dr=${res.dr}/${res.datr} ch=${res.channel} ` +
            `freq=${(res.frequencyHz / 1_000_000).toFixed(1)}MHz — ${vector.description}`,
        );
      } catch (err) {
        console.error(`[mock] ${sensor.id} send failed:`, (err as Error).message);
      }
    }
    if (stopping) break;
    await sleep(cfg.intervalSeconds * 1000);
  }

  emitter.close();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'provision':
      await provisionAll(loadConfig());
      break;
    case 'run':
      await runLoop();
      break;
    default:
      console.error('usage: mock-sensors <provision|run>');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
