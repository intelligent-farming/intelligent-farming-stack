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

### Local codec tarball (temporary) — required prebuild step

> **This is scaffolding, not the intended end state.** It exists so a *draft* PR can
> show this repo and the codec repo working together. **The final PR must land only
> after `lorawan-codec-normalization` 0.2.0 is published to npm**, with the
> dependency changed to a `^0.2.0` range and `vendor/` + `scripts/pack-codec.sh`
> deleted. Nothing else here depends on the tarball path.

`channels[]` ships in `lorawan-codec-normalization` **0.2.0**, which is not yet on
npm, so the dependency points at a locally-built tarball under `vendor/`
(git-ignored, and *not* tracked — a fresh clone has no `vendor/` at all) rather
than a published range. Build it from a sibling checkout of the codec repo:

```sh
npm run pack-codec        # from mock-sensors/
```

That runs `npm run build` + `npm pack` in `../../lorawan-codec-normalization` and
drops the tarball into `vendor/`, removing any previous one first. It fails loudly —
it never falls back to a stale tarball — if the checkout is missing, is the wrong
version, or doesn't build. Point it elsewhere with
`CODEC_REPO_DIR=/path/to/lorawan-codec-normalization`.

**Run it before `npm install` and before any image build**, i.e. before
`docker compose --profile mock up -d --build mock-sensors`. The compose service
builds with context `./mock-sensors`, so the Dockerfile cannot reach a sibling repo
— the pack has to happen on the host. `npm run mock:up`, `npm run stack:up`, and
`../scripts/e2e.sh` all run it for you; a raw `docker compose ... --build` does not.

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

Devices are created with `skipFcntCheck: true` and deterministic (trivial) session
keys so replays survive restarts — bench conveniences, not a realistic device
posture. Activation is ABP for now; the frame builder is structured so OTAA joins
can be added.

### RF parameters

The harness is **US915-only**: `REGION` must be `us915_0` or `us915_1`, and anything
else throws at startup rather than transmitting on frequencies the stack has no
channel for (which drops every frame at the network server while the emitter log
still reads like a success).

Per frame, the **data rate** comes from the payload size and the **channel** from the
sensor index:

- **Data rate** — every DR whose limit clears the application payload is a legal
  choice; the sensor's index picks one from that set, so the fleet spreads over
  **DR0–DR3** (SF10 / SF9 / SF8 / SF7, all BW125) instead of pinning one. This is
  not cosmetic: US915 DR0 caps at **11 bytes** and four of the six sensors send
  13–41 bytes, so the old fixed DR0 was unmodulatable in the air and well past the
  FCC 400 ms dwell limit. ChirpStack does not police it — it stores the frame with
  `dr = 0`, which then poisons every downstream airtime and link-budget number.
- **Channel** — spread across the sub-band's eight 125 kHz channels: `us915_0` →
  ch 0–7 at 902.3 + 0.2·n MHz, `us915_1` → ch 8–15 at 903.9 + 0.2·n MHz. A
  single-channel bench never exercises the multi-channel path at all.

Both are deterministic (same sensor + same vector → same DR and channel), so the e2e
assertions stay stable while still covering more than one link budget. DR4
(SF8BW500) is deliberately unused: it lives on the 500 kHz channels at their own
frequencies, i.e. a second channel plan for no gain.

## Commands (npm scripts)

Run these from this `mock-sensors/` directory (they wrap the repo-root compose file, so you don't
have to remember the flags). From elsewhere, prefix with `npm --prefix mock-sensors`.

| Command | What it does |
|---------|--------------|
| `npm run pack-codec` | Build the codec tarball into `vendor/` from the sibling checkout (temporary — see above). Required before any `npm install` or image build. |
| `npm run stack:up` | Bring up the whole data path **and** the mock generator (excludes Leftenant, so no git build needed). Packs the codec first. Idempotent. |
| `npm run stack:down` | Stop & remove all containers, **keep** data volumes. |
| `npm run stack:reset` | Stop & remove all containers **and wipe** data (full reset). |
| `npm run stack:ps` | Show container status. |
| `npm run mock:up` | Pack the codec, then (re)build & start just the mock generator against an already-running stack. |
| `npm run mock:stop` | Stop the mock generator (leaves the rest of the stack up). |
| `npm run mock:logs` | Follow the emitter log (one line per uplink sent). |
| `npm run watch:mqtt` | Live-tail ChirpStack's decoded uplink app events (MQTT). Ctrl-C to stop. |
| `npm run watch:db` | Print the 20 most recent `event_up` rows (decoded `object`) from Postgres. |
| `npm run watch:db:count` | Print the total `event_up` row count. |
| `npm run watch:graphql` | Query the 10 most recent uplinks via the GraphQL API. |
| `npm run test:e2e` | Run the e2e suite directly (needs a running stack, creds, **and** the endpoint env below already exported; `../scripts/e2e.sh` wires all of that up for you). |

> The event store is **Postgres** (`event_up`), served as GraphQL by `events-api` — there is no
> ClickHouse in this stack. GraphiQL is in the browser at http://localhost:5050/graphiql.

## Continuous emission

The `mock` profile runs the emitter **continuously**: it loops over all six sensors every
`MOCK_INTERVAL_SECONDS` (default 15) forever, so fresh decoded readings keep arriving in Postgres and
on the MQTT stream until you stop it. The container is `restart: unless-stopped`, so it survives
restarts too. Use a faster cadence with, e.g., `MOCK_INTERVAL_SECONDS=5 npm run stack:up`.

## Running the demo (via the stack)

```sh
# from the stack repo root, with the stack already up (bash setup.sh)
npm --prefix mock-sensors run pack-codec   # temporary prebuild — see above
docker compose --profile mock up -d --build mock-sensors
docker compose --profile mock logs -f mock-sensors
```

`npm --prefix mock-sensors run mock:up` does both steps in one go.

Then watch it populate GraphiQL (http://localhost:5050/graphiql), the ChirpStack UI,
or Leftenant. Tune the cadence with `MOCK_INTERVAL_SECONDS` (default 15).

## Running it standalone (host → localhost)

```sh
cd mock-sensors
npm run pack-codec     # temporary prebuild — must precede npm install
npm install
# point at a running stack; get the key/tenant from the shared volume (see scripts/e2e.sh)
export CHIRPSTACK_API_KEY=... CHIRPSTACK_TENANT_ID=...
npm run provision      # one-shot: create gateway/app/profiles/devices
npm run run            # continuous emit loop
```

A host run reaches the stack over its **published** ports, so if you have remapped
any of them in `.env` (or changed `REGION`), export the matching values from the
[configuration table](#configuration) too — `scripts/e2e.sh` derives them from
`.env` for you, but `npm run provision` / `npm run run` do not.

## End-to-end test

```sh
# from the stack repo root — boots the stack if needed, runs the suite, and
# tears down only what it started:
bash scripts/e2e.sh
```

The suite (`test/e2e.test.ts`) provisions, sends one known payload per sensor, and
asserts the decoded `object` shows up on MQTT **and** in `event_up`.

`scripts/e2e.sh` handles the setup a bare `npm run test:e2e` cannot:

- reads the repo-root `.env` (falling back to `.env.example`'s defaults, which are
  compose's defaults) and exports `REGION`, `CHIRPSTACK_REST_URL`, `MOCK_MQTT_URL`,
  `MOCK_EVENTS_PG_URL`, `MOCK_UDP_HOST`/`_PORT` to match. Without this the suite
  uses the built-in localhost defaults and a remapped port, a changed
  `EVENTS_POSTGRES_PASSWORD`, or `REGION=us915_1` shows up as every assertion
  timing out — pointing at the wrong layer entirely.
- packs the codec tarball and reinstalls deps (temporary; see above).
- **stops the compose `mock-sensors` demo service** if it is running: its loop emits
  from the same six DevEUIs, so the suite could otherwise assert against a demo
  frame instead of the one it just sent. It stays stopped — restart it with
  `npm run mock:up`.

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `CHIRPSTACK_REST_URL` | `http://localhost:8090` | ChirpStack REST base URL |
| `CHIRPSTACK_API_KEY` | (from `/shared/config.json`) | tenant API key |
| `CHIRPSTACK_TENANT_ID` | (from `/shared/config.json`) | tenant UUID |
| `MOCK_UDP_HOST` / `MOCK_UDP_PORT` | `localhost` / `1700` | Semtech UDP **target** |
| `REGION` | `us915_0` | sub-band → uplink RF params; only `us915_0` / `us915_1` (anything else throws) |
| `MOCK_GATEWAY_EUI` | `da7a9a7e00000001` | gateway EUI the mock publishes under |
| `MOCK_MQTT_URL` | `mqtt://localhost:1883` | broker for the e2e MQTT assertions |
| `MOCK_EVENTS_PG_URL` | `postgres://events:changeme@localhost:5434/chirpstack_events` | event store for the e2e assertions |
| `MOCK_INTERVAL_SECONDS` | `15` | demo-loop cadence |
| `SHARED_CONFIG` | `/shared/config.json` | where to read the key/tenant from |

`MOCK_UDP_HOST`/`MOCK_UDP_PORT` are named `MOCK_*` on purpose. The stack root already
uses `GATEWAY_BRIDGE_UDP_PORT` for the **host port mapping**
(`"${GATEWAY_BRIDGE_UDP_PORT}:1700/udp"`); the harness needs the **target** address,
which on the compose network is always container port 1700 and on the host is
whatever that mapping publishes. Sharing one name meant a host run silently kept
sending to 1700 after the published port moved. (Renamed from
`GATEWAY_BRIDGE_UDP_HOST`/`_PORT`.)

Every value except the two credentials has a working localhost default, so a plain
bench needs none of them set. `scripts/e2e.sh` derives them from the repo-root `.env`
so a customised bench works without hand-exporting anything.

## License

AGPL-3.0-or-later — see the repository `LICENSE`.
