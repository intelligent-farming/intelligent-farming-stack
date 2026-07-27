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
import { SENSORS, dataVectors } from './sensors';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function runLoop(): Promise<void> {
  const cfg = loadConfig();
  await provisionAll(cfg);

  const emitter = new Emitter(cfg);
  const cursors = new Map<string, number>();
  let stopping = false;
  const shutdown = (): void => {
    stopping = true;
    emitter.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(
    `[mock] emitting from ${SENSORS.length} sensors every ${cfg.intervalSeconds}s ` +
      `via ${cfg.udpHost}:${cfg.udpPort} (gw ${cfg.gatewayEui}, region ${cfg.region})`,
  );

  while (!stopping) {
    for (const sensor of SENSORS) {
      const vecs = dataVectors(sensor);
      const i = (cursors.get(sensor.id) ?? 0) % vecs.length;
      cursors.set(sensor.id, i + 1);
      const vector = vecs[i];
      try {
        const fCnt = await emitter.emit(sensor, vector);
        console.log(
          `[mock] ${sensor.id} devEui=${sensor.devEui} fPort=${vector.fPort} ` +
            `fCnt=${fCnt} — ${vector.description}`,
        );
      } catch (err) {
        console.error(`[mock] ${sensor.id} send failed:`, (err as Error).message);
      }
    }
    await sleep(cfg.intervalSeconds * 1000);
  }
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
