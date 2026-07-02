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

**Get started:** one command [installs & runs](#install--run) the whole stack (no Git, no config),
one command [updates](#updating) it, and the [command reference](#command-reference) covers day-to-day
operations. Jump to [Prerequisites](#prerequisites) first.

## Prerequisites

- Docker + Docker Compose v2 (with network access on first build — Leftenant is built from its
  public repo, and the other images are pulled from Docker Hub). No sibling repos need to be cloned.

## Install & run

The only prerequisite is a running Docker daemon (see [Prerequisites](#prerequisites)). The
one-command installers below download the repo and run the bundled setup script, which builds
Leftenant from its public repo, pulls the other images, and starts + provisions the whole stack — no
Git, and no `.env`, needed. Every setting has a built-in default; copy `.env.example` to `.env` only
if you want to change one.

### Windows — one command

Open **PowerShell** and paste this single line. It downloads the repo to
`%USERPROFILE%\ifs\intelligent-farming-stack-main` (no Git needed) and runs the setup script:

```powershell
$ErrorActionPreference='Stop'; iwr 'https://github.com/intelligent-farming/intelligent-farming-stack/archive/refs/heads/main.zip' -OutFile "$env:TEMP\ifs.zip"; Expand-Archive "$env:TEMP\ifs.zip" "$env:USERPROFILE\ifs" -Force; Set-Location "$env:USERPROFILE\ifs\intelligent-farming-stack-main"; powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

### macOS / Linux — one command

Paste this single line into a terminal. It downloads and extracts the repo into
`intelligent-farming-stack-main/` under your current directory (no Git needed — just `curl`) and runs
the setup script:

```sh
curl -fsSL https://github.com/intelligent-farming/intelligent-farming-stack/archive/refs/heads/main.tar.gz | tar -xz && cd intelligent-farming-stack-main && bash setup.sh
```

Prefer Git? `git clone https://github.com/intelligent-farming/intelligent-farming-stack.git && cd
intelligent-farming-stack && bash setup.sh` (or `.\setup.ps1`) does the same.

> **Why the setup script and not just `docker compose up`?** Leftenant is built from its public repo
> with `docker build <giturl>`, which the script runs before `docker compose up`. Compose's own
> git-URL build context is [broken on Windows](https://github.com/docker/compose/issues/13815) (it
> throws *"the filename, directory name, or volume label syntax is incorrect"*), so the build is done
> with the buildx CLI — which clones the repo server-side and works on every platform.

### Then open

- Leftenant (pre-configured): http://localhost:4173
- ChirpStack admin UI: http://localhost:8080 (default login `admin` / `admin`)
- ChirpStack REST API: http://localhost:8090
- Device-event GraphQL (PostGraphile): http://localhost:5050/graphql — GraphiQL IDE at http://localhost:5050/graphiql

The first run builds Leftenant from its public repo and pulls the ChirpStack/Postgres/etc. images, so
it needs network access and takes a few minutes. The setup script waits for the one-shot provisioner
and prints these URLs; you can also check it with `docker compose logs provisioner`.

## Updating

Pull the latest of everything — the repo files, the published images, and Leftenant's latest `main` —
then recreate the containers. **Your data is preserved**: the compose project name is pinned, so the
named volumes (`eventsdata`, `chirpstack-pgdata`, …) are reused across updates regardless of where the
repo lives. A `.env` you created is also left untouched (it isn't part of the download).

### Windows — one command

```powershell
$ErrorActionPreference='Stop'; iwr 'https://github.com/intelligent-farming/intelligent-farming-stack/archive/refs/heads/main.zip' -OutFile "$env:TEMP\ifs.zip"; Expand-Archive "$env:TEMP\ifs.zip" "$env:USERPROFILE\ifs" -Force; Set-Location "$env:USERPROFILE\ifs\intelligent-farming-stack-main"; powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Update
```

### macOS / Linux — one command

```sh
curl -fsSL https://github.com/intelligent-farming/intelligent-farming-stack/archive/refs/heads/main.tar.gz | tar -xz && cd intelligent-farming-stack-main && bash setup.sh --update
```

Already have the repo on disk? Just run the helper from the repo folder — `./setup.sh --update`
(or `powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Update`). It rebuilds Leftenant from the
latest `main` (`docker build --pull <giturl>`), pulls newer ChirpStack/Postgres images, and recreates
the containers. If you ever suspect a stale Leftenant build, force it with `./setup.sh --rebuild`
(`-Rebuild`), which adds `--no-cache`.

## Stopping and removing

Run these from the repo folder (`%USERPROFILE%\ifs\intelligent-farming-stack-main` on Windows, or
wherever you extracted/cloned it):

```sh
docker compose stop        # pause containers, keep everything
docker compose down        # stop + remove containers/network, KEEP data volumes
docker compose down -v     # stop + remove containers AND delete all data (full reset)
```

The helper scripts wrap the last two: `./setup.sh --down` / `-Down` (keep data) and
`./setup.sh --reset` / `-Reset` (wipe data). To uninstall completely, run `docker compose down -v`
and then delete the repo folder.

## Command reference

Once installed, all day-to-day commands run from the repo folder. **Prefer the helper scripts** —
they also build/refresh the Leftenant image, which Compose does not (see the note below). The raw
`docker compose` forms are equivalent *once the Leftenant image exists*.

| Task | Helper script | `docker compose` (Leftenant image must already exist) |
|------|---------------|--------------------------------------------------------|
| Start | `./setup.sh` · `.\setup.ps1` | `docker compose up -d --build` |
| Update (latest Leftenant + images, keep data) | `./setup.sh --update` · `.\setup.ps1 -Update` | rebuild Leftenant (see note), then `docker compose pull --ignore-pull-failures && docker compose build --pull && docker compose up -d` |
| Clean rebuild (no cache) | `./setup.sh --rebuild` · `.\setup.ps1 -Rebuild` | `docker compose build --no-cache && docker compose up -d` |
| Stop, keep data | `./setup.sh --down` · `.\setup.ps1 -Down` | `docker compose down` |
| Stop, wipe data | `./setup.sh --reset` · `.\setup.ps1 -Reset` | `docker compose down -v` |
| Follow logs | — | `docker compose logs -f` |

> **Leftenant image.** Leftenant has no `build:` section in compose — its image is built from the
> public repo with the buildx CLI (compose's git-URL build context is broken on Windows). The helper
> scripts do this automatically. If you use the raw `docker compose` commands, build/refresh the image
> yourself first:
> ```sh
> docker build --pull -t intelligent-farming-stack/leftenant:local https://github.com/intelligent-farming/leftenant.git#main
> ```

For the **first install** and for a **full update that also refreshes the repo files**, use the
one-command installers under [Install & run](#install--run) and [Updating](#updating).

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
