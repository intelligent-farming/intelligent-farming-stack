# intelligent-farming-stack

Docker Compose bench that runs ChirpStack (US915), Leftenant, and a standalone device-event store
as one stack. On `up`, a one-shot provisioner creates an "Intelligent Farming" ChirpStack tenant,
mints a tenant API key, and writes it where Leftenant and the codec tooling read it. Leftenant
starts already configured.

Device events are stored by **ChirpStack's built-in PostgreSQL integration**: ChirpStack writes
every event (uplinks, joins, acks, status, …) straight into a standalone Postgres (`events-postgres`),
auto-creating its `event_*` tables on first boot. **`events-api`** (PostGraphile) serves a read-only
GraphQL/GraphiQL endpoint over them. There is no separate collector, and nothing here depends on the
`intelligent-farming-hub` repo.

## Prerequisites

- Docker + Docker Compose v2 (with network access on first build — Leftenant is built from its
  public repo, and the other images are pulled from Docker Hub). No sibling repos need to be cloned.

## Usage

```sh
cp .env.example .env        # defaults work for a localhost bench
docker compose up -d --build
```

Then:

- Leftenant (pre-configured): http://localhost:4173
- ChirpStack admin UI: http://localhost:8080 (default login `admin` / `admin`)
- ChirpStack REST API: http://localhost:8090
- Device-event GraphQL (PostGraphile): http://localhost:5050/graphql — GraphiQL IDE at http://localhost:5050/graphiql

The provisioner runs once and exits; check it with `docker compose logs provisioner`.

## What gets provisioned

The `provisioner` service (`provisioning/provision.py`) logs in to the ChirpStack REST API,
ensures the tenant named by `TENANT_NAME` exists, mints an API key named `API_KEY_NAME`, and
writes to the shared `shared` volume:

| File | Consumer |
|------|----------|
| `config.json` | Leftenant reads it at startup and seeds its settings (skips the first-run wizard) |
| `leftenant.env` | same values as an env file |
| `leftenant-connection.txt` | the codec attach step (`attach-codecs.py`) — REST URL / API key / Tenant UUID |

Re-running `docker compose up` is idempotent: the existing tenant is reused, and the API key is
reused from `config.json` rather than re-minted. Resetting the `shared` volume forces a new key.

## Data flow

```
gateway --(Semtech UDP :1700)--> gateway-bridge --> mosquitto(:1883) --> chirpstack
                                                                             |
                              ChirpStack integrations (both enabled) ────────┤
                                                                             |
   PostgreSQL integration (durable store) ───────┐        MQTT integration ──┘
                                                  v                          v
                              events-postgres <--(writes event_* rows)   mosquitto
                                     |                                        |
                        events-api (PostGraphile, GraphQL :5050)     (Leftenant join monitor, ws :9001)

Leftenant (browser :4173) --(REST :8090, CORS)--> chirpstack-rest-api --> chirpstack
```

ChirpStack keeps its MQTT integration (Leftenant's browser join monitor subscribes to it) **and**
adds the PostgreSQL integration, which is the durable store `events-api` reads from.

## Ports

| Port | Service | Notes |
|------|---------|-------|
| 4173 | leftenant | provisioning UI (pre-configured) |
| 8080 | chirpstack | admin UI + gRPC |
| 8090 | chirpstack-rest-api | REST API (Leftenant); CORS allow-origin = `LEFTENANT_ORIGIN` |
| 1883 | mosquitto | native MQTT |
| 9001 | mosquitto | MQTT over websockets |
| 1700/udp | chirpstack-gateway-bridge | Semtech UDP packet forwarder |
| 5050 | events-api | GraphQL (loopback by default; 5000 avoided — macOS AirPlay) |
| 5434 | events-postgres | host-side psql/export; loopback by default — `EVENTS_POSTGRES_HOST_BIND` to expose (see below) |

## Device event store & GraphQL

ChirpStack's PostgreSQL integration (configured in `chirpstack/chirpstack.toml`) connects to
`events-postgres` as the owner role and, on first boot, runs its own migrations to create these
tables in the `public` schema of the `chirpstack_events` database:

| Table | Event |
|-------|-------|
| `event_up` | uplinks — decoded payload in `object` (jsonb), plus `rx_info` / `tx_info`, `dev_eui`, `f_cnt`, `f_port`, `dr`, … |
| `event_join` | OTAA joins (`dev_addr` assigned) |
| `event_ack` | downlink acknowledgements |
| `event_tx_ack` | downlink transmission acks (per gateway) |
| `event_status` | device status (battery, margin) |
| `event_location` | resolved device location |
| `event_log` | device-level log events |
| `event_integration` | events emitted by other integrations |

`events-api` (PostGraphile) introspects that schema and exposes it as GraphQL. It connects as the
read-only `events_api` role (`SELECT` on `public` only — created by
`postgresql/events-initdb/010_events_roles.sh`), with default mutations disabled, so the endpoint is
read-only by construction and enforced at the DB.

```graphql
# most recent uplinks with their decoded payload
{
  allEventUps(orderBy: TIME_DESC, first: 20) {
    nodes { devEui deviceName time fCnt fPort object }
  }
}
```

`POST http://localhost:5050/graphql` for queries; the GraphiQL IDE is at
`http://localhost:5050/graphiql` (`EVENTS_API_GRAPHIQL=false` disables it).

ChirpStack's `event_*` tables ship only a primary-key index, so `events-api` runs with
`ignoreIndexes: true` — that's what makes `orderBy: TIME_DESC` and `condition: { devEui: … }`
available on every column. At bench volumes the unindexed scans are fine; add indexes on
`event_up (time)` / `event_up (dev_eui)` (etc.) before relying on those filters at scale.

> First boot ordering is handled for you: a one-shot `events-schema-wait` blocks `events-api` until
> ChirpStack has created `event_up`, so the GraphQL schema is populated on the first `up` (no manual
> restart). Send one device uplink (or trigger a join) to see rows.

## Region

Defaults to US915 (sub-bands 0 and 1). To change region, swap the `chirpstack/region_*.toml`
file(s) for the target region and update `network.enabled_regions` in `chirpstack/chirpstack.toml`
(region files for every band are available in the upstream chirpstack-docker project).

## Codecs (optional)

If codec `.js` files are present at `CODECS_DIR` (default `./codecs`), the provisioner runs
`attach-codecs.py` against the new tenant key, so ChirpStack decodes payloads into the `object`
column of `event_up`. Point `CODECS_DIR` at another folder (e.g. `../intelligent-farming-hub/codecs`)
to reuse a codec set from elsewhere; an empty/missing dir just makes this a no-op. Device profiles
must already exist for codecs to bind, so on a first boot (before Leftenant creates profiles) this is
typically a no-op — re-run `docker compose up` (or `docker compose run --rm provisioner`) after
provisioning profiles. The codec `.js` files are Makerfabs-derived and git-ignored.

## LAN access

The defaults assume the browser reaches the bench at `localhost`. To reach it by IP, set
`LEFTENANT_ORIGIN`, `LEFTENANT_CHIRPSTACK_URL`, and `LEFTENANT_MQTT_URL` in `.env` to the device's
address (e.g. `http://192.168.1.50:4173`, `http://192.168.1.50:8090`, `ws://192.168.1.50:9001`),
then recreate: `docker compose up -d`.

## Fivetran / off-device sync

`events-postgres` holds the device events (the `event_*` tables in the `public` schema of the
`chirpstack_events` DB). By default it binds to `127.0.0.1` and runs `wal_level=replica`, so nothing
off the edge device can reach it. To let Fivetran (or any log-based CDC / logical-replication
consumer) pull from it, do the following. All of it is opt-in through `.env` — leaving the values at
their defaults keeps the loopback-only bench posture.

Sync as the read-only replication role below, not `events` (the owner). The `chirpstack-postgres` DB
is LoRaWAN network state, not device events — don't sync it.

### 1. Expose the Postgres port

```sh
# .env
EVENTS_POSTGRES_HOST_BIND=0.0.0.0     # or a specific LAN/VPN address the connector uses
```

Bind to the narrowest address that works (a VPN or private-LAN IP over `0.0.0.0`), and
put a firewall in front scoped to the consumer's source addresses. Fivetran Cloud
connects from a fixed set of published IPs; a **Fivetran Hybrid Deployment / local
agent** is preferable on a farm edge box — the agent dials out, so Postgres never has
to listen on a public interface (bind it to the agent's network only).

### 2. Enable logical WAL (for log-based CDC)

Fivetran's log-based connector reads the write-ahead log, which requires
`wal_level=logical`. Skip this step if you use Fivetran's key-based sync instead
(the `event_*` tables have monotonic keys / a `time` column to poll on).

```sh
# .env
EVENTS_POSTGRES_WAL_LEVEL=logical
```

`wal_level` is a startup parameter, so recreate the container to apply it:

```sh
docker compose up -d events-postgres
docker compose exec events-postgres psql -U events -d chirpstack_events -c "SHOW wal_level;"   # -> logical
```

`max_wal_senders` / `max_replication_slots` default to 10 (PG16), which is enough for
one Fivetran slot; raise `EVENTS_POSTGRES_MAX_*` in `.env` only if you add more consumers.

### 3. Create the read-only replication role + publication

Set both credentials in `.env` (a blank user or password skips role creation entirely):

```sh
# .env
EVENTS_POSTGRES_FIVETRAN_USER=fivetran
EVENTS_POSTGRES_FIVETRAN_PASSWORD=$(openssl rand -base64 24)   # paste the generated value
EVENTS_POSTGRES_FIVETRAN_PUBLICATION=fivetran_pub              # default
```

`postgresql/events-initdb/010_events_roles.sh` creates a `LOGIN REPLICATION` role with `SELECT` on
`public` (nothing else) and a publication scoped to the `public` schema — which auto-includes the
`event_*` tables ChirpStack creates. It runs automatically on a **fresh** `eventsdata` volume. On an
**existing** volume, run it by hand after setting the env (idempotent — safe to re-run, and re-syncs
the password after a rotation):

```sh
docker compose up -d events-postgres    # so the container has the new POSTGRES_FIVETRAN_* env
docker compose exec events-postgres bash /docker-entrypoint-initdb.d/010_events_roles.sh
```

Verify:

```sh
docker compose exec events-postgres psql -U events -d chirpstack_events \
  -c "\du fivetran" -c "SELECT pubname FROM pg_publication;"
```

### 4. Configure the Fivetran connector

Point Fivetran's **PostgreSQL** source at the device:

| Field | Value |
|-------|-------|
| Host / Port | the device address / `5434` (or your `EVENTS_POSTGRES_HOST_PORT`) |
| Database | `chirpstack_events` (`EVENTS_POSTGRES_DB`) |
| User / Password | `EVENTS_POSTGRES_FIVETRAN_USER` / `EVENTS_POSTGRES_FIVETRAN_PASSWORD` |
| Update method | Logical replication (WAL) |
| Publication | `fivetran_pub` (`EVENTS_POSTGRES_FIVETRAN_PUBLICATION`) |
| Replication slot | Fivetran creates it (the role has `REPLICATION`); e.g. `fivetran_slot` |
| Schema | `public` |

Notes:
- **TLS.** The bench Postgres has no TLS. Terminate it in front (VPN, an `stunnel`/proxy
  sidecar, or the Fivetran local agent's tunnel) before any non-loopback exposure.
- **Deletes/updates.** Events are append-only, so inserts replicate cleanly. Each `event_*` table
  has a primary key (default replica identity), so any update/delete would replicate too.
- **Slot disk use.** An offline/paused connector leaves its replication slot holding WAL,
  which grows `eventsdata`. If you retire the connector, drop the slot:
  `SELECT pg_drop_replication_slot('fivetran_slot');`.
- **Extra table.** The schema-scoped publication also includes ChirpStack's
  `__diesel_schema_migrations` bookkeeping table, so it will appear at the destination.
  Harmless — exclude it in Fivetran's table selector if you don't want it synced.

## Security posture

Bench defaults only: anonymous MQTT, ChirpStack `admin`/`admin`, placeholder `CHIRPSTACK_API_SECRET`,
loopback-bound event API/DB. Rotate the secret, add MQTT auth + TLS, and lock down origins/binds
before exposing any of this beyond a trusted private network.
