#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# Creates the least-privilege role the Leadsman rule engine connects as.
#
# Same idiom as 010_events_roles.sh alongside it: the postgres image runs *.sh in
# /docker-entrypoint-initdb.d during init, which is BEFORE ChirpStack has ever
# connected and created any event_* tables. ALTER DEFAULT PRIVILEGES pre-authorizes
# SELECT on whatever tables the owner creates later, so the role can read every
# event_* table ChirpStack adds without re-granting.
#
# Numbered 020 so it runs after the read-only API / Fivetran roles. Order does not
# actually matter between them — they touch different roles — but keeping the
# numbering meaningful makes the init sequence readable.
#
# Privileges: SELECT on public (read telemetry) and INSERT/UPDATE/SELECT on the
# leadsman schema (write its own alerts). No DDL on public, no DELETE anywhere, no
# SUPERUSER/CREATEDB/CREATEROLE. It cannot alter or destroy ChirpStack's data.
#
# To apply to an EXISTING volume (upgrading a stack that predates Leadsman), run by
# hand — the env is already in the container from docker-compose.yml:
#   docker compose exec events-postgres bash /docker-entrypoint-initdb.d/020_leadsman_role.sh
#   docker compose up -d leadsman-migrate leadsman
#
# Required env (all supplied by events-postgres' `environment:` block):
#   POSTGRES_USER, POSTGRES_DB      — the owner role / database (set by the image)
#   POSTGRES_LEADSMAN_USER          — role to create (default `leadsman`)
#   POSTGRES_LEADSMAN_PASSWORD      — its password
#
# Blank/unset LEADSMAN vars disable this script, matching the Fivetran role's opt-in
# behaviour — so clearing them in .env is how you run the stack without Leadsman.

# Everything below runs in a SUBSHELL, deliberately.
#
# The postgres entrypoint executes a *.sh init file if it carries the executable bit and
# SOURCES it if it does not. The bit is set in git, but a GitHub .zip download does not
# preserve unix permissions, so on some machines this file arrives non-executable and gets
# sourced. Sourced at top level, `set -euo pipefail` would leak into the entrypoint for the
# rest of initdb, and an `exit` would abort initdb entirely — leaving Postgres stuck
# mid-initialisation and permanently unhealthy rather than simply skipping this script.
# A subshell contains both: `set -e` applies only in here, and `exit` ends only this block.
(
  set -euo pipefail

  if [ -z "${POSTGRES_LEADSMAN_USER:-}" ] || [ -z "${POSTGRES_LEADSMAN_PASSWORD:-}" ]; then
    echo "020_leadsman_role: POSTGRES_LEADSMAN_USER / POSTGRES_LEADSMAN_PASSWORD not set — skipping"
    exit 0
  fi

role_exists="$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_LEADSMAN_USER}'" \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB")"
if [ "$role_exists" != "1" ]; then
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "CREATE ROLE \"${POSTGRES_LEADSMAN_USER}\" LOGIN"
fi

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOSQL
ALTER ROLE "${POSTGRES_LEADSMAN_USER}" WITH LOGIN PASSWORD '${POSTGRES_LEADSMAN_PASSWORD}';

GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO "${POSTGRES_LEADSMAN_USER}";

-- Read side: the ChirpStack event_* tables in public. The tables do not exist yet
-- on a fresh boot, so ALTER DEFAULT PRIVILEGES covers the ones created later.
GRANT USAGE  ON SCHEMA public              TO "${POSTGRES_LEADSMAN_USER}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${POSTGRES_LEADSMAN_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO "${POSTGRES_LEADSMAN_USER}";
EOSQL

# Write side: only if 001_leadsman_schema.sql has already created the schema. On a
# fresh volume it has not, and 001's own DO block will apply these grants when it
# runs (the role exists by then). Either order works.
schema_exists="$(psql -tAc "SELECT 1 FROM pg_namespace WHERE nspname = 'leadsman'" \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB")"
if [ "$schema_exists" = "1" ]; then
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOSQL
GRANT USAGE ON SCHEMA leadsman TO "${POSTGRES_LEADSMAN_USER}";
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA leadsman TO "${POSTGRES_LEADSMAN_USER}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA leadsman TO "${POSTGRES_LEADSMAN_USER}";
EOSQL
    echo "020_leadsman_role: role '${POSTGRES_LEADSMAN_USER}' ready (read public / write leadsman)"
  else
    echo "020_leadsman_role: role '${POSTGRES_LEADSMAN_USER}' ready (read public; leadsman schema not created yet — run migration 001)"
  fi
) || {
  # A failure here must NOT take initdb down with it. Without Leadsman's role the engine
  # cannot connect — but ChirpStack, the event store, and events-api are all unaffected,
  # and setup.sh re-runs this script on every start, so it self-heals once the cause is
  # fixed. A half-initialised Postgres, by contrast, breaks the entire stack.
  echo "020_leadsman_role: FAILED — Leadsman will not be able to connect." >&2
  echo "020_leadsman_role: the rest of the stack is unaffected; re-run this script after fixing:" >&2
  echo "020_leadsman_role:   docker compose exec events-postgres bash /docker-entrypoint-initdb.d/020_leadsman_role.sh" >&2
}
