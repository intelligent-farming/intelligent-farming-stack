#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# Sets up the least-privilege roles on the standalone device-event store.
#
# ChirpStack's PostgreSQL integration connects as POSTGRES_USER (the DB owner) and
# creates the event_* tables in the public schema on first boot. This script runs
# BEFORE ChirpStack ever connects (the postgres image runs *.sh in
# /docker-entrypoint-initdb.d during init), so the tables do not exist yet. The
# trick is ALTER DEFAULT PRIVILEGES: it pre-authorizes SELECT on whatever tables
# POSTGRES_USER creates LATER, so the read-only API role (and the opt-in Fivetran
# role) can read every event_* table ChirpStack adds without re-granting.
#
# Roles created:
#   - POSTGRES_API_USER   : read-only (SELECT on public) — PostGraphile connects as this
#   - POSTGRES_FIVETRAN_USER (opt-in): read-only + REPLICATION + a publication, for
#                                       Fivetran log-based CDC (see the stack README)
#
# Runs automatically only on a FRESH volume. To apply to an EXISTING volume, run by
# hand (env is already in the container from docker-compose):
#   docker compose exec events-postgres bash /docker-entrypoint-initdb.d/010_events_roles.sh

set -euo pipefail

# ── read-only API role (PostGraphile) ────────────────────────────────────────
if [ -n "${POSTGRES_API_USER:-}" ] && [ -n "${POSTGRES_API_PASSWORD:-}" ]; then
  role_exists="$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_API_USER}'" \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB")"
  if [ "$role_exists" != "1" ]; then
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -c "CREATE ROLE \"${POSTGRES_API_USER}\" LOGIN"
  fi

  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOSQL
ALTER ROLE "${POSTGRES_API_USER}" WITH LOGIN PASSWORD '${POSTGRES_API_PASSWORD}';

GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO "${POSTGRES_API_USER}";
GRANT USAGE   ON SCHEMA public              TO "${POSTGRES_API_USER}";

-- anything already in public (none yet on a fresh boot), plus everything
-- POSTGRES_USER (ChirpStack) creates later — the event_* tables.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${POSTGRES_API_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO "${POSTGRES_API_USER}";
EOSQL
  echo "010_events_roles: read-only role '${POSTGRES_API_USER}' ready (SELECT on public / future event_* tables)"
else
  echo "010_events_roles: POSTGRES_API_USER / POSTGRES_API_PASSWORD not set — skipping API role"
fi

# ── opt-in Fivetran replication role ──────────────────────────────────────────
if [ -n "${POSTGRES_FIVETRAN_USER:-}" ] && [ -n "${POSTGRES_FIVETRAN_PASSWORD:-}" ]; then
  PUBLICATION="${POSTGRES_FIVETRAN_PUBLICATION:-fivetran_pub}"

  role_exists="$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_FIVETRAN_USER}'" \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB")"
  if [ "$role_exists" != "1" ]; then
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -c "CREATE ROLE \"${POSTGRES_FIVETRAN_USER}\" LOGIN"
  fi

  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOSQL
-- LOGIN so Fivetran can connect; REPLICATION so it can open a logical
-- replication slot. No SUPERUSER, no CREATEDB, no CREATEROLE.
ALTER ROLE "${POSTGRES_FIVETRAN_USER}" WITH LOGIN REPLICATION PASSWORD '${POSTGRES_FIVETRAN_PASSWORD}';

GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO "${POSTGRES_FIVETRAN_USER}";
GRANT USAGE   ON SCHEMA public              TO "${POSTGRES_FIVETRAN_USER}";

-- initial sync (table copy) reads via SELECT; grant for current + future tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${POSTGRES_FIVETRAN_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO "${POSTGRES_FIVETRAN_USER}";

-- Publication scoped to the public schema (PG15+). Auto-includes the event_*
-- tables ChirpStack creates later. Point Fivetran's connector at this name.
DROP PUBLICATION IF EXISTS "${PUBLICATION}";
CREATE PUBLICATION "${PUBLICATION}" FOR TABLES IN SCHEMA public;
EOSQL
  echo "010_events_roles: replication role '${POSTGRES_FIVETRAN_USER}' + publication '${PUBLICATION}' ready"
  echo "010_events_roles: ensure the server runs with wal_level=logical (EVENTS_POSTGRES_WAL_LEVEL=logical) before Fivetran connects"
else
  echo "010_events_roles: POSTGRES_FIVETRAN_USER / POSTGRES_FIVETRAN_PASSWORD not set — skipping replication role"
fi
