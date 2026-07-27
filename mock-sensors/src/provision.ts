// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Idempotently provisions everything the mock needs into ChirpStack, since the
 * stack's own provisioner only creates the tenant + API key:
 *
 *   - one gateway (the EUI the mock publishes under),
 *   - one application,
 *   - one ABP device profile per sensor (with its normalized codec attached),
 *   - one device per sensor, ABP-activated with the sensor's session keys.
 *
 * Every step is list-then-create (or GET-then-create), so re-running is safe.
 */

import type { Config } from './config';
import { rest } from './rest';
import { SENSORS, sensorCodec, type MockSensor } from './sensors';

const APP_NAME = 'Mock Sensors';

interface ListResult<T> {
  totalCount?: number;
  result: T[];
}

async function ensureGateway(cfg: Config): Promise<void> {
  const list = await rest.get<ListResult<{ gatewayId: string }>>(
    cfg,
    `/api/gateways?limit=100&tenantId=${cfg.tenantId}`,
  );
  if (list.result.some((g) => g.gatewayId.toLowerCase() === cfg.gatewayEui)) {
    console.log(`[provision] gateway ${cfg.gatewayEui} already exists`);
    return;
  }
  await rest.post(cfg, '/api/gateways', {
    gateway: {
      gatewayId: cfg.gatewayEui,
      name: 'mock-gateway',
      description: 'Virtual gateway for the mock-sensors harness.',
      tenantId: cfg.tenantId,
      statsInterval: 30,
      // ChirpStack 4.19+ validates this must be > 0.
      downlinkPriority: 1,
    },
  });
  console.log(`[provision] created gateway ${cfg.gatewayEui}`);
}

async function ensureApplication(cfg: Config): Promise<string> {
  const list = await rest.get<ListResult<{ id: string; name: string }>>(
    cfg,
    `/api/applications?limit=100&tenantId=${cfg.tenantId}`,
  );
  const found = list.result.find((a) => a.name === APP_NAME);
  if (found) {
    console.log(`[provision] application '${APP_NAME}' already exists: ${found.id}`);
    return found.id;
  }
  const created = await rest.post<{ id: string }>(cfg, '/api/applications', {
    application: { name: APP_NAME, tenantId: cfg.tenantId },
  });
  console.log(`[provision] created application '${APP_NAME}': ${created.id}`);
  return created.id;
}

async function ensureDeviceProfile(cfg: Config, sensor: MockSensor): Promise<string> {
  const name = `mock-${sensor.id}`;
  const list = await rest.get<ListResult<{ id: string; name: string }>>(
    cfg,
    `/api/device-profiles?limit=100&tenantId=${cfg.tenantId}`,
  );
  const found = list.result.find((p) => p.name === name);
  if (found) return found.id;

  const created = await rest.post<{ id: string }>(cfg, '/api/device-profiles', {
    deviceProfile: {
      name,
      tenantId: cfg.tenantId,
      region: 'US915',
      macVersion: 'LORAWAN_1_0_3',
      regParamsRevision: 'A',
      adrAlgorithmId: 'default',
      payloadCodecRuntime: 'JS',
      payloadCodecScript: sensorCodec(sensor),
      uplinkInterval: 3600,
      supportsOtaa: false,
      flushQueueOnActivate: true,
      // ABP downlink RX-window params. Unlike OTAA these aren't negotiated, so
      // they must be set explicitly — omitting abpRx2Dr defaults it to 0, which
      // is not a valid US915 downlink DR (8-13) and makes ChirpStack log
      // "Invalid data-rate" on every uplink's RX2 downlink build. US915 RX2 is
      // DR8 (SF12BW500) @ 923.3 MHz; RX1 delay 1s, offset 0.
      abpRx1Delay: 1,
      abpRx1DrOffset: 0,
      abpRx2Dr: 8,
      abpRx2Freq: 923300000,
    },
  });
  console.log(`[provision] created device profile '${name}': ${created.id}`);
  return created.id;
}

async function ensureDevice(
  cfg: Config,
  sensor: MockSensor,
  applicationId: string,
  deviceProfileId: string,
): Promise<void> {
  // A GET on a missing device returns 401 (not 404) in ChirpStack, so check
  // existence via the application's device list instead.
  const list = await rest.get<ListResult<{ devEui: string }>>(
    cfg,
    `/api/devices?limit=100&applicationId=${applicationId}`,
  );
  const exists = list.result.some((d) => d.devEui.toLowerCase() === sensor.devEui);
  if (!exists) {
    await rest.post(cfg, '/api/devices', {
      device: {
        devEui: sensor.devEui,
        name: sensor.id,
        description: `${sensor.vendor}/${sensor.device} (mock)`,
        applicationId,
        deviceProfileId,
        // Insecure, but lets us replay fixed payloads across restarts without the
        // frame-counter check dropping them as retransmission/reset.
        skipFcntCheck: true,
      },
    });
    console.log(`[provision] created device ${sensor.devEui} (${sensor.id})`);
  }

  // Activate is idempotent — it "(re)activates" ABP devices. For LoRaWAN 1.0.x
  // all three network session keys are the single NwkSKey.
  await rest.post(cfg, `/api/devices/${sensor.devEui}/activate`, {
    deviceActivation: {
      devEui: sensor.devEui,
      devAddr: sensor.devAddr,
      appSKey: sensor.appSKey,
      nwkSEncKey: sensor.nwkSKey,
      sNwkSIntKey: sensor.nwkSKey,
      fNwkSIntKey: sensor.nwkSKey,
      fCntUp: 0,
      nFCntDown: 0,
      aFCntDown: 0,
    },
  });
}

/** Provision the gateway, application, and every mock device. Idempotent. */
export async function provisionAll(cfg: Config): Promise<void> {
  console.log(`[provision] tenant ${cfg.tenantId} @ ${cfg.restUrl}`);
  await ensureGateway(cfg);
  const applicationId = await ensureApplication(cfg);
  for (const sensor of SENSORS) {
    const deviceProfileId = await ensureDeviceProfile(cfg, sensor);
    await ensureDevice(cfg, sensor, applicationId, deviceProfileId);
  }
  console.log(`[provision] done — ${SENSORS.length} mock devices ready`);
}
