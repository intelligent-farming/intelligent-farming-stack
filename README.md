# intelligent-farming-stack

Docker Compose bench that runs ChirpStack (US915), Leftenant, and the Intelligent Farming Hub
as one stack. On `up`, a one-shot provisioner creates an "Intelligent Farming" ChirpStack tenant,
mints a tenant API key, and writes it where Leftenant and the codec tooling read it. Leftenant
starts already configured; the Hub starts subscribed to every device uplink.

## Prerequisites

- Docker + Docker Compose v2.
- The sibling repos cloned alongside this one (the standard org workspace layout), since Leftenant
  and the Hub build from their source:
  - `../leftenant`
  - `../intelligent-farming-hub`

## Usage

```sh
cp .env.example .env        # defaults work for a localhost bench
docker compose up -d --build
```

Then:

- Leftenant (pre-configured): http://localhost:4173
- ChirpStack admin UI: http://localhost:8080 (default login `admin` / `admin`)
- ChirpStack REST API: http://localhost:8090
- Hub GraphQL (PostGraphile): http://localhost:5050/graphql

The provisioner runs once and exits; check it with `docker compose logs provisioner`.

## What gets provisioned

The `provisioner` service (`provisioning/provision.py`) logs in to the ChirpStack REST API,
ensures the tenant named by `TENANT_NAME` exists, mints an API key named `API_KEY_NAME`, and
writes to the shared `shared` volume:

| File | Consumer |
|------|----------|
| `config.json` | Leftenant reads it at startup and seeds its settings (skips the first-run wizard) |
| `leftenant.env` | same values as an env file |
| `leftenant-connection.txt` | `intelligent-farming-hub/codecs/attach-codecs.py` (REST URL / API key / Tenant UUID) |

Re-running `docker compose up` is idempotent: the existing tenant is reused, and the API key is
reused from `config.json` rather than re-minted. Resetting the `shared` volume forces a new key.

## Data flow

```
gateway --(Semtech UDP :1700)--> gateway-bridge --> mosquitto(:1883) --> chirpstack
                                                              |
                                              decoded uplink (application/+/device/+/event/up)
                                                              v
                                                       hub-collector --> hub-postgres --> hub-api (GraphQL)

Leftenant (browser :4173) --(REST :8090, CORS)--> chirpstack-rest-api --> chirpstack
                          --(MQTT/ws :9001)------> mosquitto   (join monitor)
```

## Ports

| Port | Service | Notes |
|------|---------|-------|
| 4173 | leftenant | provisioning UI (pre-configured) |
| 8080 | chirpstack | admin UI + gRPC |
| 8090 | chirpstack-rest-api | REST API (Leftenant); CORS allow-origin = `LEFTENANT_ORIGIN` |
| 1883 | mosquitto | native MQTT |
| 9001 | mosquitto | MQTT over websockets |
| 1700/udp | chirpstack-gateway-bridge | Semtech UDP packet forwarder |
| 5050 | hub-api | GraphQL (loopback by default; 5000 avoided — macOS AirPlay) |
| 5434 | hub-postgres | host-side psql/export; loopback by default — `HUB_POSTGRES_HOST_BIND` to expose (see below) |

## Region

Defaults to US915 (sub-bands 0 and 1). To change region, swap the `chirpstack/region_*.toml`
file(s) for the target region and update `network.enabled_regions` in `chirpstack/chirpstack.toml`
(region files for every band are available in the upstream chirpstack-docker project).

## Codecs (optional)

If the Hub's bench codecs are present at `../intelligent-farming-hub/codecs/*.js`, the provisioner
runs `attach-codecs.py` against the new tenant key. Device profiles must already exist for codecs
to bind, so on a first boot (before Leftenant creates profiles) this is typically a no-op; re-run
`docker compose up` (or `docker compose run --rm provisioner`) after provisioning profiles. The
codec `.js` files are Makerfabs-derived and git-ignored — see the Hub repo.

## LAN access

The defaults assume the browser reaches the bench at `localhost`. To reach it by IP, set
`LEFTENANT_ORIGIN`, `LEFTENANT_CHIRPSTACK_URL`, and `LEFTENANT_MQTT_URL` in `.env` to the device's
address (e.g. `http://192.168.1.50:4173`, `http://192.168.1.50:8090`, `ws://192.168.1.50:9001`),
then recreate: `docker compose up -d`.

## Fivetran / off-device sync

`hub-postgres` holds the durable telemetry (the `telemetry` schema). By default it
binds to `127.0.0.1` and runs `wal_level=replica`, so nothing off the edge device can
reach it. To let Fivetran (or any log-based CDC / logical-replication consumer) pull
from it, do the following. All of it is opt-in through `.env` — leaving the values at
their defaults keeps the loopback-only bench posture.

Sync the telemetry as the read-only `farm_api` role, not `hub` (the superuser). The
`chirpstack-postgres` DB is LoRaWAN network state, not farm telemetry — don't sync it.

### 1. Expose the Postgres port

```sh
# .env
HUB_POSTGRES_HOST_BIND=0.0.0.0     # or a specific LAN/VPN address the connector uses
```

Bind to the narrowest address that works (a VPN or private-LAN IP over `0.0.0.0`), and
put a firewall in front scoped to the consumer's source addresses. Fivetran Cloud
connects from a fixed set of published IPs; a **Fivetran Hybrid Deployment / local
agent** is preferable on a farm edge box — the agent dials out, so Postgres never has
to listen on a public interface (bind it to the agent's network only).

### 2. Enable logical WAL (for log-based CDC)

Fivetran's log-based connector reads the write-ahead log, which requires
`wal_level=logical`. Skip this step if you use Fivetran's key-based / `updated_at`
sync instead.

```sh
# .env
HUB_POSTGRES_WAL_LEVEL=logical
```

`wal_level` is a startup parameter, so recreate the container to apply it:

```sh
docker compose up -d hub-postgres
docker compose exec hub-postgres psql -U hub -d farm -c "SHOW wal_level;"   # -> logical
```

`max_wal_senders` / `max_replication_slots` default to 10 (PG16), which is enough for
one Fivetran slot; raise `HUB_POSTGRES_MAX_*` in `.env` only if you add more consumers.

### 3. Create the read-only replication role + publication

Set both credentials in `.env` (a blank user or password skips role creation entirely):

```sh
# .env
HUB_POSTGRES_FIVETRAN_USER=fivetran
HUB_POSTGRES_FIVETRAN_PASSWORD=$(openssl rand -base64 24)   # paste the generated value
HUB_POSTGRES_FIVETRAN_PUBLICATION=fivetran_pub              # default
```

The Hub's `db/migrations/004_fivetran_replication.sh` creates a `LOGIN REPLICATION`
role with `SELECT` on `telemetry` (nothing else) and a publication scoped to the
`telemetry` schema. It runs automatically on a **fresh** `hubdata` volume. On an
**existing** database, run it by hand after setting the env (idempotent — safe to
re-run, and re-syncs the password after a rotation):

```sh
docker compose up -d hub-postgres    # so the container has the new POSTGRES_FIVETRAN_* env
docker compose exec hub-postgres bash /docker-entrypoint-initdb.d/004_fivetran_replication.sh
```

Verify:

```sh
docker compose exec hub-postgres psql -U hub -d farm \
  -c "\du fivetran" -c "SELECT pubname FROM pg_publication;"
```

### 4. Configure the Fivetran connector

Point Fivetran's **PostgreSQL** source at the device:

| Field | Value |
|-------|-------|
| Host / Port | the device address / `5434` (or your `HUB_POSTGRES_HOST_PORT`) |
| Database | `farm` (`HUB_POSTGRES_DB`) |
| User / Password | `HUB_POSTGRES_FIVETRAN_USER` / `HUB_POSTGRES_FIVETRAN_PASSWORD` |
| Update method | Logical replication (WAL) |
| Publication | `fivetran_pub` (`HUB_POSTGRES_FIVETRAN_PUBLICATION`) |
| Replication slot | Fivetran creates it (the role has `REPLICATION`); e.g. `fivetran_slot` |
| Schema | `telemetry` |

Notes:
- **TLS.** The bench Postgres has no TLS. Terminate it in front (VPN, an `stunnel`/proxy
  sidecar, or the Fivetran local agent's tunnel) before any non-loopback exposure.
- **Deletes/updates.** Telemetry is append-only, so inserts replicate cleanly. Any table
  you expect to update/delete must have a primary key (default replica identity) for
  those changes to appear downstream — the telemetry tables have PKs.
- **Slot disk use.** An offline/paused connector leaves its replication slot holding WAL,
  which grows `pgdata`. If you retire the connector, drop the slot:
  `SELECT pg_drop_replication_slot('fivetran_slot');`.

## Security posture

Bench defaults only: anonymous MQTT, ChirpStack `admin`/`admin`, placeholder `CHIRPSTACK_API_SECRET`,
loopback-bound Hub API/DB. Rotate the secret, add MQTT auth + TLS, and lock down origins/binds
before exposing any of this beyond a trusted private network.
