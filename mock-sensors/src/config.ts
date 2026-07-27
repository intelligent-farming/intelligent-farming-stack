// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Runtime configuration for the mock-sensor harness.
 *
 * The ChirpStack tenant API key + tenant id are minted by the stack's
 * provisioner and written to the shared volume as `/shared/config.json` (the
 * same file Leftenant reads). We read them from there by default, or from
 * explicit env vars when running the harness from the host against a stack whose
 * ports are published on localhost.
 */

import * as fs from 'node:fs';

export interface Config {
  /** ChirpStack REST gateway base URL, e.g. http://localhost:8090 (no trailing slash). */
  restUrl: string;
  /** Tenant-scoped API key. */
  apiKey: string;
  /** Tenant UUID the gateway/app/profiles/devices are created under. */
  tenantId: string;
  /** chirpstack-gateway-bridge Semtech-UDP host. */
  udpHost: string;
  /** chirpstack-gateway-bridge Semtech-UDP port (default 1700). */
  udpPort: number;
  /** Active region / sub-band, drives the uplink RF params (default us915_0). */
  region: string;
  /** Gateway EUI the mock publishes under (must be registered in ChirpStack). */
  gatewayEui: string;
  /** MQTT broker URL for the e2e app-event assertions. */
  mqttUrl: string;
  /** Postgres connection string for the e2e event_up assertions. */
  pgUrl: string;
  /** Seconds between demo-loop send rounds. */
  intervalSeconds: number;
}

function readSharedConfig(path: string): { apiKey?: string; tenantId?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as {
      apiKey?: string;
      tenantId?: string;
    };
    return { apiKey: parsed.apiKey, tenantId: parsed.tenantId };
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const shared = readSharedConfig(
    process.env.SHARED_CONFIG ?? '/shared/config.json',
  );
  const apiKey = process.env.CHIRPSTACK_API_KEY ?? shared.apiKey;
  const tenantId = process.env.CHIRPSTACK_TENANT_ID ?? shared.tenantId;
  if (!apiKey) {
    throw new Error(
      'no ChirpStack API key: set CHIRPSTACK_API_KEY or mount /shared/config.json',
    );
  }
  if (!tenantId) {
    throw new Error(
      'no tenant id: set CHIRPSTACK_TENANT_ID or mount /shared/config.json',
    );
  }

  return {
    restUrl: (process.env.CHIRPSTACK_REST_URL ?? 'http://localhost:8090').replace(
      /\/+$/,
      '',
    ),
    apiKey,
    tenantId,
    udpHost: process.env.GATEWAY_BRIDGE_UDP_HOST ?? 'localhost',
    udpPort: Number(process.env.GATEWAY_BRIDGE_UDP_PORT ?? '1700'),
    region: process.env.REGION ?? 'us915_0',
    gatewayEui: (process.env.MOCK_GATEWAY_EUI ?? 'da7a9a7e00000001').toLowerCase(),
    mqttUrl: process.env.MOCK_MQTT_URL ?? 'mqtt://localhost:1883',
    pgUrl:
      process.env.MOCK_EVENTS_PG_URL ??
      'postgres://events:changeme@localhost:5434/chirpstack_events',
    intervalSeconds: Number(process.env.MOCK_INTERVAL_SECONDS ?? '15'),
  };
}
