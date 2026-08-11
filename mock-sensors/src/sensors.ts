// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * The handful of mock ag sensors this harness simulates.
 *
 * Each entry maps to a real normalized codec in
 * `@intelligent-farming/lorawan-codec-normalization`. We pull the console-ready
 * `codec.js` (to attach to the ChirpStack device profile) and the decode-verified
 * test vectors (raw bytes in, expected decoded object out) straight from that
 * package, so the mocked payloads are guaranteed to decode and the e2e assertions
 * compare against the codec's own authored expectations.
 *
 * Credentials are derived deterministically from the 1-based index so provisioning
 * and tests are reproducible across runs.
 */

import { codecScript } from '@intelligent-farming/lorawan-codec-normalization';
// `vectors` is a public registry function but isn't re-exported from the package
// root (still true in 0.2.0); the dist/ module (and the codecs/ it reads) both
// ship in the npm tarball, so importing it from the subpath is safe.
import { vectors as codecVectors } from '@intelligent-farming/lorawan-codec-normalization/dist/registry';

export interface MockSensor {
  /** Stable id used in logs and as the ChirpStack device/profile name. */
  id: string;
  vendor: string;
  device: string;
  category: string;
  index: number;
  /** ABP session credentials (hex strings, no separators). */
  devEui: string;
  devAddr: string;
  nwkSKey: string;
  appSKey: string;
}

/** One decode-verified uplink test vector for a sensor. */
export interface UplinkVector {
  description: string;
  fPort: number;
  bytes: number[];
  /** The decoded object the codec produces (== ChirpStack's `object`). */
  expected: Record<string, unknown>;
}

const twoHex = (n: number): string => (n & 0xff).toString(16).padStart(2, '0');

/** Deterministic per-device ABP credentials from the sensor index. */
function creds(index: number): Pick<
  MockSensor,
  'devEui' | 'devAddr' | 'nwkSKey' | 'appSKey'
> {
  return {
    // 16 hex chars; a recognizable "mock" prefix.
    devEui: 'f0000000000000' + twoHex(index),
    // 8 hex chars; top byte 0x01 keeps NwkID 0 (matches net_id 000000).
    devAddr: '010000' + twoHex(index),
    // 32 hex chars each; distinct per device.
    nwkSKey: twoHex(index).repeat(16),
    appSKey: twoHex(0x80 + index).repeat(16),
  };
}

const CATALOG: Omit<MockSensor, 'devEui' | 'devAddr' | 'nwkSKey' | 'appSKey'>[] = [
  { id: 'dragino-lse01', vendor: 'dragino', device: 'lse01', category: 'soil-monitor', index: 1 },
  { id: 'milesight-em500-smtc', vendor: 'milesight-iot', device: 'em500-smtc', category: 'soil-monitor', index: 2 },
  { id: 'decentlab-dl-trs12', vendor: 'decentlab', device: 'dl-trs12', category: 'soil-monitor', index: 3 },
  { id: 'dragino-llms01', vendor: 'dragino', device: 'llms01', category: 'leaf-wetness', index: 4 },
  { id: 'decentlab-dl-atm41', vendor: 'decentlab', device: 'dl-atm41', category: 'weather-station', index: 5 },
  // Multilayer probe: its vectors decode to the reserved `channels[]` array (one
  // entry per depth), which exercises a nested array through ChirpStack's
  // protobuf Struct conversion and the PostgreSQL integration.
  { id: 'decentlab-dl-smtp', vendor: 'decentlab', device: 'dl-smtp', category: 'soil-monitor', index: 6 },
];

export const SENSORS: MockSensor[] = CATALOG.map((c) => ({ ...c, ...creds(c.index) }));

/** The `codec.js` text to install in this sensor's ChirpStack device profile. */
export function sensorCodec(sensor: MockSensor): string {
  return codecScript(sensor.vendor, sensor.device);
}

// The codec package's own `vectors()` reads and JSON-parses vectors.json on every
// call — only its `device()` lookup is cached. Both the demo loop and the e2e
// suite ask for the same vectors repeatedly, so memoize here, at the one place
// that resolves them, rather than making every caller hoist its own copy.
const vectorCache = new Map<string, UplinkVector[]>();

/**
 * The sensor's data-carrying uplink vectors (error vectors are filtered out).
 * These are the raw payloads the harness replays and the expected decoded
 * objects the e2e suite asserts against. Memoized per sensor id.
 */
export function dataVectors(sensor: MockSensor): UplinkVector[] {
  const cached = vectorCache.get(sensor.id);
  if (cached) return cached;
  const { uplink } = codecVectors(sensor.vendor, sensor.device);
  const out: UplinkVector[] = [];
  for (const raw of uplink as Array<{
    description?: string;
    input?: { fPort?: number; bytes?: number[] };
    expected?: { data?: Record<string, unknown> };
  }>) {
    if (raw?.expected?.data && raw.input?.bytes && typeof raw.input.fPort === 'number') {
      out.push({
        description: raw.description ?? '',
        fPort: raw.input.fPort,
        bytes: raw.input.bytes,
        expected: raw.expected.data,
      });
    }
  }
  if (out.length === 0) {
    throw new Error(`no data vectors for ${sensor.vendor}/${sensor.device}`);
  }
  vectorCache.set(sensor.id, out);
  return out;
}
