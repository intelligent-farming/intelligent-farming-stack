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
 * Every step is list-then-create-or-update, so re-running is safe. "Idempotent"
 * here means converging on the desired state, not "skip if a row exists":
 * ChirpStack's Postgres volume outlives `docker compose down`, so anything we
 * only ever create would be pinned to whatever the first run wrote.
 */

import type { Config } from './config';
import { rest } from './rest';
import { SENSORS, sensorCodec, type MockSensor } from './sensors';

const APP_NAME = 'Mock Sensors';

interface ListResult<T> {
  // protojson serialises int64 as a *string*, so this arrives as e.g. "137",
  // not 137. Typed as both so the coercion in listAll() has to be deliberate.
  totalCount?: string | number;
  // Optional on purpose: protojson omits empty repeated fields, so an empty
  // tenant can come back as bare {"totalCount":"0"} with no `result` key. Making
  // it optional forces every read site to spell out the `?? []` fallback rather
  // than throwing "Cannot read properties of undefined".
  result?: T[];
}

const PAGE_SIZE = 100;
/** Refuse to page forever if the server ignores `offset` (100 pages = 10k rows). */
const MAX_PAGES = 100;

/**
 * Every row from a ChirpStack list endpoint, following `offset` to the end.
 *
 * A single `limit=100` request is not an existence check. This bench shares its
 * tenant with Leftenant, whose whole purpose is batch-provisioning devices — once
 * the tenant holds more than 100 of them, an unpaginated list stops returning the
 * mock's own rows, `ensureDevice` concludes they're absent, and the POST fails
 * with "object already exists", crash-looping the container. The application list
 * fails worse: it would create a duplicate 'Mock Sensors' app on every run.
 *
 * `path` must already carry its own query params (tenantId/applicationId); the
 * paging params are appended.
 */
async function listAll<T>(cfg: Config, path: string): Promise<T[]> {
  const sep = path.includes('?') ? '&' : '?';
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await rest.get<ListResult<T>>(
      cfg,
      `${path}${sep}limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    );
    const rows = res.result ?? [];
    out.push(...rows);
    const total = Number(res.totalCount ?? 0);
    if (rows.length < PAGE_SIZE || (Number.isFinite(total) && out.length >= total)) {
      return out;
    }
  }
  throw new Error(`${path}: still returning full pages after ${MAX_PAGES} — refusing to page further`);
}

async function ensureGateway(cfg: Config): Promise<void> {
  const gateways = await listAll<{ gatewayId: string }>(
    cfg,
    `/api/gateways?tenantId=${cfg.tenantId}`,
  );
  if (gateways.some((g) => g.gatewayId.toLowerCase() === cfg.gatewayEui)) {
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
  const apps = await listAll<{ id: string; name: string }>(
    cfg,
    `/api/applications?tenantId=${cfg.tenantId}`,
  );
  const found = apps.find((a) => a.name === APP_NAME);
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

/**
 * The complete device-profile object, shared verbatim by the create and update
 * paths. ChirpStack's update is a full replace, so both need the identical body
 * — building it in one place is what stops the two from drifting (an update that
 * quietly dropped, say, `abpRx2Dr` would break downlinks on existing benches
 * only, which is the worst kind of bug to reproduce).
 */
function deviceProfileBody(
  cfg: Config,
  sensor: MockSensor,
  name: string,
): Record<string, unknown> {
  return {
    name,
    tenantId: cfg.tenantId,
    // Safe to hardcode: cfg.region is US915-only by construction — anything that
    // isn't us915_0/us915_1 throws in rxParamsForRegion() (src/semtech-udp.ts)
    // before provisioning ever runs.
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
  };
}

/** Every device profile in the tenant, keyed by profile name. */
async function listDeviceProfiles(cfg: Config): Promise<Map<string, string>> {
  const profiles = await listAll<{ id: string; name: string }>(
    cfg,
    `/api/device-profiles?tenantId=${cfg.tenantId}`,
  );
  return new Map(profiles.map((p): [string, string] => [p.name, p.id]));
}

async function ensureDeviceProfile(
  cfg: Config,
  sensor: MockSensor,
  profilesByName: Map<string, string>,
): Promise<string> {
  const name = `mock-${sensor.id}`;
  const existingId = profilesByName.get(name);

  // Push the profile even when it already exists, rather than short-circuiting
  // on the name match. The codec text is regenerated whenever the codec package
  // is rebuilt (see README, "Local codec tarball"), but ChirpStack persists
  // device profiles in a Postgres volume that survives `docker compose down` —
  // so on any bench that has provisioned once, a create-only path would pin the
  // profile to the first codec it ever saw. The failure mode is silent: uplinks
  // still decode, just with stale logic, and the e2e suite reports an opaque
  // decoded-object diff that looks like a codec bug.
  if (existingId) {
    // ChirpStack wants the id both in the path and in the body.
    await rest.put(cfg, `/api/device-profiles/${existingId}`, {
      deviceProfile: { ...deviceProfileBody(cfg, sensor, name), id: existingId },
    });
    console.log(`[provision] updated device profile '${name}': ${existingId}`);
    return existingId;
  }

  const created = await rest.post<{ id: string }>(cfg, '/api/device-profiles', {
    deviceProfile: deviceProfileBody(cfg, sensor, name),
  });
  console.log(`[provision] created device profile '${name}': ${created.id}`);
  return created.id;
}

/** The complete device object, shared by the create and update paths. */
function deviceBody(
  sensor: MockSensor,
  applicationId: string,
  deviceProfileId: string,
): Record<string, unknown> {
  return {
    devEui: sensor.devEui,
    name: sensor.id,
    description: `${sensor.vendor}/${sensor.device} (mock)`,
    applicationId,
    deviceProfileId,
    // Insecure, but lets us replay fixed payloads across restarts without the
    // frame-counter check dropping them as retransmission/reset.
    skipFcntCheck: true,
  };
}

interface DeviceListItem {
  devEui: string;
  deviceProfileId?: string;
}

/**
 * Every device in the application, keyed by lower-cased DevEUI. Listing is the
 * only cheap existence check available: a GET on a missing device returns 401
 * (not 404) in ChirpStack, so a per-device probe can't tell "absent" from "your
 * API key is wrong".
 */
async function listDevices(
  cfg: Config,
  applicationId: string,
): Promise<Map<string, DeviceListItem>> {
  const devices = await listAll<DeviceListItem>(
    cfg,
    `/api/devices?applicationId=${applicationId}`,
  );
  return new Map(
    devices.map((d): [string, DeviceListItem] => [d.devEui.toLowerCase(), d]),
  );
}

async function ensureDevice(
  cfg: Config,
  sensor: MockSensor,
  applicationId: string,
  deviceProfileId: string,
  devicesByEui: Map<string, DeviceListItem>,
): Promise<void> {
  const existing = devicesByEui.get(sensor.devEui);

  if (!existing) {
    await rest.post(cfg, '/api/devices', {
      device: deviceBody(sensor, applicationId, deviceProfileId),
    });
    console.log(`[provision] created device ${sensor.devEui} (${sensor.id})`);
  } else if (existing.deviceProfileId !== deviceProfileId) {
    // The device row can outlive the profile it was created against — e.g. the
    // profiles were deleted and recreated (new UUIDs) while the devices stayed.
    // Left alone the device keeps decoding with the old profile's codec, so
    // re-point it. PUT is a full replace here too, hence the shared builder.
    await rest.put(cfg, `/api/devices/${sensor.devEui}`, {
      device: deviceBody(sensor, applicationId, deviceProfileId),
    });
    console.log(
      `[provision] re-pointed device ${sensor.devEui} (${sensor.id}) ` +
        `at device profile ${deviceProfileId}`,
    );
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

  // Both lists are tenant-/application-wide, so they're fetched once here and
  // handed to the per-sensor helpers. Listing inside the loop instead would fire
  // one identical request per sensor per list — on every container start and
  // every e2e beforeAll.
  const profilesByName = await listDeviceProfiles(cfg);
  const devicesByEui = await listDevices(cfg, applicationId);

  for (const sensor of SENSORS) {
    const deviceProfileId = await ensureDeviceProfile(cfg, sensor, profilesByName);
    await ensureDevice(cfg, sensor, applicationId, deviceProfileId, devicesByEui);
  }
  console.log(`[provision] done — ${SENSORS.length} mock devices ready`);
}
