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
 *
 * Env reads go through the small helpers below rather than `process.env.X ?? d`:
 * `??` only fires on `undefined`, so a var that is *present but empty* — which is
 * what compose gives you for an unset name in an `env_file`, or for `-e FOO=` —
 * silently bypasses the documented default. Empty/whitespace-only is treated as
 * "not set"; a value that is set but malformed is a hard error naming the
 * variable, because every failure mode here is silent-and-expensive (a zero
 * interval floods the bridge, a zero port throws on every send, a blank gateway
 * EUI makes ChirpStack drop frames while the harness logs happy sends).
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

/** Default gateway EUI — matches the virtual gateway the harness provisions. */
const DEFAULT_GATEWAY_EUI = 'da7a9a7e00000001';

/** An 8-byte gateway EUI as bare hex — no separators, no 0x prefix. */
const EUI64_HEX = /^[0-9a-f]{16}$/;

/** A base-10 integer, so `15s`, `1e3` and `0x10` are rejected rather than coerced. */
const INTEGER = /^[+-]?\d+$/;

/**
 * Read `name`, treating unset **and** blank/whitespace-only as absent. Returns
 * the trimmed value, so a stray newline from a compose `env_file` doesn't end up
 * in a hostname or a URL.
 */
function envRaw(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Trimmed value of `name`, or `fallback` when the var is unset or blank. */
function envStr(name: string, fallback: string): string {
  return envRaw(name) ?? fallback;
}

/**
 * Integer value of `name`, or `fallback` when the var is unset or blank.
 *
 * A var that *is* set but isn't a base-10 integer inside `[min, max]` throws —
 * we deliberately do not fall back, because silently substituting the default
 * for a typo is how `MOCK_INTERVAL_SECONDS=15s` turns into a 1 ms send loop.
 */
function envInt(
  name: string,
  fallback: number,
  range: { min?: number; max?: number } = {},
): number {
  const raw = envRaw(name);
  if (raw === undefined) return fallback;

  const { min, max } = range;
  const bounds =
    min !== undefined && max !== undefined
      ? `an integer between ${min} and ${max}`
      : min !== undefined
        ? `an integer >= ${min}`
        : max !== undefined
          ? `an integer <= ${max}`
          : 'an integer';

  if (!INTEGER.test(raw)) {
    throw new Error(`${name} must be ${bounds}; got "${raw}"`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be ${bounds}; got "${raw}"`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`${name} must be ${bounds}; got ${parsed}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be ${bounds}; got ${parsed}`);
  }
  return parsed;
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
  const shared = readSharedConfig(envStr('SHARED_CONFIG', '/shared/config.json'));
  // Explicit env still wins over the shared file; a blank env var counts as unset
  // so an empty `-e CHIRPSTACK_API_KEY=` falls through to /shared/config.json
  // instead of failing with a confusing "no API key".
  const apiKey = envRaw('CHIRPSTACK_API_KEY') ?? shared.apiKey;
  const tenantId = envRaw('CHIRPSTACK_TENANT_ID') ?? shared.tenantId;
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

  // A blank or malformed EUI would copy zero bytes into the PUSH_DATA header, and
  // ChirpStack drops frames from an unknown gateway without telling anyone — so
  // this is validated loudly rather than defaulted quietly.
  const gatewayEuiRaw = envStr('MOCK_GATEWAY_EUI', DEFAULT_GATEWAY_EUI);
  const gatewayEui = gatewayEuiRaw.toLowerCase();
  if (!EUI64_HEX.test(gatewayEui)) {
    throw new Error(
      `MOCK_GATEWAY_EUI must be exactly 16 hex characters (an 8-byte gateway EUI, ` +
        `no separators or 0x prefix); got "${gatewayEuiRaw}"`,
    );
  }

  return {
    restUrl: envStr('CHIRPSTACK_REST_URL', 'http://localhost:8090').replace(/\/+$/, ''),
    apiKey,
    tenantId,
    // MOCK_UDP_HOST/PORT are the harness's *target* bridge address. They are
    // deliberately not named GATEWAY_BRIDGE_UDP_* — the stack already uses those
    // for the compose *host* port mapping ("${GATEWAY_BRIDGE_UDP_PORT}:1700/udp"),
    // and reusing them made a host-side run silently keep sending to 1700 after
    // the published port moved.
    udpHost: envStr('MOCK_UDP_HOST', 'localhost'),
    udpPort: envInt('MOCK_UDP_PORT', 1700, { min: 1, max: 65535 }),
    // Region is passed through unvalidated on purpose; semtech-udp.ts owns which
    // regions the RF params support.
    region: envStr('REGION', 'us915_0'),
    gatewayEui,
    mqttUrl: envStr('MOCK_MQTT_URL', 'mqtt://localhost:1883'),
    pgUrl: envStr(
      'MOCK_EVENTS_PG_URL',
      'postgres://events:changeme@localhost:5434/chirpstack_events',
    ),
    // Minimum 1s: `sleep(0)` (or a NaN-coerced 1 ms setTimeout) is an unthrottled
    // UDP flood at the bridge, not a fast demo.
    intervalSeconds: envInt('MOCK_INTERVAL_SECONDS', 15, { min: 1, max: 86400 }),
  };
}
