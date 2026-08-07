<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Intelligent Farming Foundation
-->

# mock-sensors

Mock LoRaWAN ag sensors for the `intelligent-farming-stack` bench. It simulates a
handful of real, different sensors, emits **valid** LoRaWAN uplinks (correct MIC +
encrypted payload) via the Semtech UDP gateway bridge — exactly like a real
packet-forwarder gateway — and lets you watch mocked data flow all the way through
ChirpStack into the Postgres event store and the MQTT application stream.

It exists both as a **continuous demo generator** (a docker-compose service) and as
the engine behind an **end-to-end test** that asserts mocked readings land, decoded,
in both sinks.

## The mocked sensors

Six sensors spanning three payload wire-formats, each backed by a real normalized
codec from [`@intelligent-farming/lorawan-codec-normalization`](https://github.com/intelligent-farming/lorawan-codec-normalization):

| Sensor | Category | fPort | Notes |
|--------|----------|-------|-------|
| `dragino/lse01` | soil-monitor | 2 | |
| `milesight-iot/em500-smtc` | soil-monitor | 85 | |
| `decentlab/dl-trs12` | soil-monitor | 1 | |
| `dragino/llms01` | leaf-wetness | 2 | |
| `decentlab/dl-atm41` | weather-station | 1 | |
| `decentlab/dl-smtp` | soil-monitor | 1 | multilayer probe — emits `channels[]` |

`decentlab/dl-smtp` is an 8-depth soil moisture/temperature profile probe. Its
readings decode into the reserved **`channels[]`** array (one measurement object per
depth, each with a `channel` label), so it is the fleet's coverage for nested arrays
surviving ChirpStack's protobuf `Struct` conversion and the PostgreSQL integration.
Its three data vectors cover a full 8-depth profile, a partial probe with
disconnected depths, and a battery-only uplink that carries no `channels` key at all.

The raw payloads and expected decoded values are the codecs' own decode-verified
test vectors (pulled from the package at runtime), so the mocked data is guaranteed
to decode and the tests compare against the codec's authored output.

### Local codec tarball (temporary)

`channels[]` ships in `lorawan-codec-normalization` **0.2.0**, which is not yet on
npm, so the dependency currently points at a locally-built tarball under `vendor/`
(git-ignored) rather than a published range. Regenerate it from a checkout of the
codec repo whenever the codec changes:

```sh
cd ../../lorawan-codec-normalization   # on the branch carrying 0.2.0
npm run build
npm pack --pack-destination ../intelligent-farming-stack/mock-sensors/vendor/
```

Then `npm install` here (or rebuild the image). Once 0.2.0 is published, drop
`vendor/` and set the dependency back to a `^0.2.0` range.

## How it works

1. **Provision** (idempotent): the stack's provisioner only mints a tenant + API key,
   so this creates the rest via ChirpStack's REST API (`:8090`) — a virtual gateway,
   an application, one ABP device profile per sensor (with the normalized `codec.js`
   attached), and one ABP-activated device per sensor with deterministic session keys.
2. **Emit**: for each sensor it builds an unconfirmed data-up PHYPayload with
   [`lora-packet`](https://github.com/anthonykirby/lora-packet) (MIC + FRMPayload
   encryption) and sends it as a Semtech `PUSH_DATA` datagram to the gateway bridge.
3. ChirpStack decodes it with the attached codec and fans out to both integrations:
   a row in `event_up` (Postgres) and a JSON event on `application/+/device/+/event/up`
   (MQTT).

Devices are created with `skipFcntCheck: true` so replays survive restarts.
Activation is ABP for now; the frame builder is structured so OTAA joins can be added.

## Commands (npm scripts)

Run these from this `mock-sensors/` directory (they wrap the repo-root compose file, so you don't
have to remember the flags). From elsewhere, prefix with `npm --prefix mock-sensors`.

| Command | What it does |
|---------|--------------|
| `npm run stack:up` | Bring up the whole data path **and** the mock generator (excludes Leftenant, so no git build needed). Idempotent. |
| `npm run stack:down` | Stop & remove all containers, **keep** data volumes. |
| `npm run stack:reset` | Stop & remove all containers **and wipe** data (full reset). |
| `npm run stack:ps` | Show container status. |
| `npm run mock:up` | (Re)build & start just the mock generator against an already-running stack. |
| `npm run mock:stop` | Stop the mock generator (leaves the rest of the stack up). |
| `npm run mock:logs` | Follow the emitter log (one line per uplink sent). |
| `npm run watch:mqtt` | Live-tail ChirpStack's decoded uplink app events (MQTT). Ctrl-C to stop. |
| `npm run watch:db` | Print the 20 most recent `event_up` rows (decoded `object`) from Postgres. |
| `npm run watch:db:count` | Print the total `event_up` row count. |
| `npm run watch:graphql` | Query the 10 most recent uplinks via the GraphQL API. |
| `npm run test:e2e` | Run the e2e suite (needs a running stack + creds; `../scripts/e2e.sh` wires those up). |

> The event store is **Postgres** (`event_up`), served as GraphQL by `events-api` — there is no
> ClickHouse in this stack. GraphiQL is in the browser at http://localhost:5050/graphiql.

## Continuous emission

The `mock` profile runs the emitter **continuously**: it loops over all 5 sensors every
`MOCK_INTERVAL_SECONDS` (default 15) forever, so fresh decoded readings keep arriving in Postgres and
on the MQTT stream until you stop it. The container is `restart: unless-stopped`, so it survives
restarts too. Use a faster cadence with, e.g., `MOCK_INTERVAL_SECONDS=5 npm run stack:up`.

## Running the demo (via the stack)

```sh
# from the stack repo root, with the stack already up (bash setup.sh)
docker compose --profile mock up -d mock-sensors
docker compose logs -f mock-sensors
```

Then watch it populate GraphiQL (http://localhost:5050/graphiql), the ChirpStack UI,
or Leftenant. Tune the cadence with `MOCK_INTERVAL_SECONDS` (default 15).

## Running it standalone (host → localhost)

```sh
cd mock-sensors
npm install
# point at a running stack; get the key/tenant from the shared volume (see scripts/e2e.sh)
export CHIRPSTACK_API_KEY=... CHIRPSTACK_TENANT_ID=...
npm run provision      # one-shot: create gateway/app/profiles/devices
npm run run            # continuous emit loop
```

## End-to-end test

```sh
# from the stack repo root — boots the stack if needed, runs the suite, and
# tears down only what it started:
bash scripts/e2e.sh
```

The suite (`test/e2e.test.ts`) provisions, sends one known payload per sensor, and
asserts the decoded `object` shows up on MQTT **and** in `event_up`.

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `CHIRPSTACK_REST_URL` | `http://localhost:8090` | ChirpStack REST base URL |
| `CHIRPSTACK_API_KEY` | (from `/shared/config.json`) | tenant API key |
| `CHIRPSTACK_TENANT_ID` | (from `/shared/config.json`) | tenant UUID |
| `GATEWAY_BRIDGE_UDP_HOST` / `_PORT` | `localhost` / `1700` | Semtech UDP target |
| `REGION` | `us915_0` | sub-band → uplink RF params |
| `MOCK_GATEWAY_EUI` | `da7a9a7e00000001` | gateway EUI the mock publishes under |
| `MOCK_MQTT_URL` | `mqtt://localhost:1883` | broker for the e2e MQTT assertions |
| `MOCK_EVENTS_PG_URL` | `postgres://events:changeme@localhost:5434/chirpstack_events` | event store for the e2e assertions |
| `MOCK_INTERVAL_SECONDS` | `15` | demo-loop cadence |

## License

AGPL-3.0-or-later — see the repository `LICENSE`.
