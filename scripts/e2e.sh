#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# Boot the stack (if it isn't already up), run the mock-sensors end-to-end suite
# against it, then tear down only what this script started. Set E2E_KEEP=1 to
# leave the stack running afterwards (fast iteration).
#
# The suite runs on the HOST and reaches the stack over its published ports, so
# every address it uses is derived from the same .env compose reads (see
# "resolve configuration" below) rather than from the harness's built-in
# localhost/default-port fallbacks. Getting that wrong is expensive to diagnose:
# a REGION mismatch, for instance, transmits us915_0 frequencies at a us915_1
# stack and every uplink is silently dropped at the network server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── resolve configuration (shell env > .env > .env.example > built-in default) ──
# Same precedence and the same file compose uses, so `docker compose up` and the
# host-side suite cannot disagree. .env.example is the last file consulted because
# its values are exactly the compose `${VAR:-default}` defaults, so an unedited
# bench needs no .env at all.

# Print KEY's value from a dotenv-style file, or nothing. Deliberately NOT
# `source`: a .env is data, and sourcing it would execute any $(...) or backtick a
# stray line happens to contain. Mirrors compose's parsing for this file's shapes —
# last assignment wins, an `export ` prefix is tolerated, matching quotes are
# stripped, and an unquoted value's trailing ` # comment` is dropped (that is how
# .env.example annotates its port defaults).
dotenv_get() {
  local file="$1" key="$2" line value=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    case "$line" in
      "$key="*) value="${line#"$key"=}" ;;
      "export $key="*) value="${line#export "$key"=}" ;;
      *) continue ;;
    esac
  done < "$file"
  case "$value" in
    '"'*'"')
      value="${value#\"}"
      value="${value%\"}"
      ;;
    "'"*"'")
      value="${value#\'}"
      value="${value%\'}"
      ;;
    *)
      value="${value%%[[:space:]]#*}"                  # strip ` # comment`
      value="${value%"${value##*[![:space:]]}"}"       # rtrim
      ;;
  esac
  printf '%s' "$value"
}

# cfg VAR DEFAULT — set VAR unless it already has a value in the environment.
cfg() {
  local var="$1" def="$2"
  # Separate statement on purpose: in bash 3.2 (still the /bin/bash on macOS) the
  # names in a single `local` are all declared before any of its assignments are
  # expanded, so `local var="$1" val="${!var-}"` reads an unset `var` and silently
  # ignores an env override.
  local val="${!var-}"
  [ -z "$val" ] || return 0
  val="$(dotenv_get "$ROOT_DIR/.env" "$var")"
  [ -n "$val" ] || val="$(dotenv_get "$ROOT_DIR/.env.example" "$var")"
  [ -n "$val" ] || val="$def"
  printf -v "$var" '%s' "$val"
}

# Percent-encode one DSN component, so a password containing @ : / or ? cannot
# silently rewrite the connection string it is pasted into.
urlenc() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

cfg REGION us915_0
cfg MOSQUITTO_MQTT_PORT 1883
cfg CHIRPSTACK_REST_HOST_PORT 8090
cfg GATEWAY_BRIDGE_UDP_PORT 1700
cfg EVENTS_POSTGRES_USER events
cfg EVENTS_POSTGRES_PASSWORD changeme
cfg EVENTS_POSTGRES_DB chirpstack_events
cfg EVENTS_POSTGRES_HOST_PORT 5434

# Derived harness endpoints. Each is still overridable directly (in .env or the
# shell) for a stack that isn't on this host.
cfg MOCK_UDP_HOST localhost
cfg MOCK_UDP_PORT "$GATEWAY_BRIDGE_UDP_PORT"
cfg CHIRPSTACK_REST_URL "http://localhost:${CHIRPSTACK_REST_HOST_PORT}"
cfg MOCK_MQTT_URL "mqtt://localhost:${MOSQUITTO_MQTT_PORT}"
cfg MOCK_EVENTS_PG_URL "postgres://$(urlenc "$EVENTS_POSTGRES_USER"):$(urlenc "$EVENTS_POSTGRES_PASSWORD")@localhost:${EVENTS_POSTGRES_HOST_PORT}/$(urlenc "$EVENTS_POSTGRES_DB")"
# Carried through as well so a customised .env doesn't leave the suite provisioning
# a second virtual gateway alongside the demo service's.
cfg MOCK_GATEWAY_EUI da7a9a7e00000001
export REGION MOCK_UDP_HOST MOCK_UDP_PORT CHIRPSTACK_REST_URL MOCK_MQTT_URL MOCK_EVENTS_PG_URL MOCK_GATEWAY_EUI

# Credentials stay out of the log — the PG URL carries a password.
echo "[e2e] region ${REGION} · rest ${CHIRPSTACK_REST_URL} · mqtt ${MOCK_MQTT_URL}"
echo "[e2e] udp ${MOCK_UDP_HOST}:${MOCK_UDP_PORT} · events db localhost:${EVENTS_POSTGRES_HOST_PORT}/${EVENTS_POSTGRES_DB}"

# ── host-side build of the harness (before anything slow) ──────────────────────
# TEMPORARY: build the codec tarball mock-sensors depends on from the sibling
# checkout, because lorawan-codec-normalization 0.2.0 is not on npm yet. Delete
# this step (and mock-sensors/vendor/) once it is published — see
# mock-sensors/scripts/pack-codec.sh. Deliberately ahead of the compose boot: a
# missing sibling checkout then fails in seconds instead of after a full stack
# start that would immediately be torn down again.
echo "[e2e] packing the codec dependency from the sibling checkout…"
bash "$ROOT_DIR/mock-sensors/scripts/pack-codec.sh"

# Always reinstall: the pack step above rewrites vendor/*.tgz on every run, and npm
# will happily keep an already-extracted copy of a `file:` dependency otherwise —
# which is how you end up testing yesterday's codec.
echo "[e2e] installing mock-sensors deps…"
(cd "$ROOT_DIR/mock-sensors" && npm install --no-audit --no-fund)

# Long-running services the data path needs — deliberately excludes `leftenant`
# (its image is built out-of-band from git and isn't needed here). The one-shot
# services (provisioner, events-schema-wait) are NOT listed: `--wait` aborts if a
# targeted service exits, so provisioner is run separately below and
# events-schema-wait is pulled in as events-api's completed-successfully dep.
SERVICES="chirpstack-postgres redis mosquitto events-postgres chirpstack chirpstack-rest-api chirpstack-gateway-bridge events-api"

started=0
cleanup() {
  local code=$?
  if [ "$started" = "1" ] && [ "${E2E_KEEP:-0}" != "1" ]; then
    echo "[e2e] tearing down (set E2E_KEEP=1 to keep the stack running)"
    docker compose down
  fi
  exit "$code"
}
trap cleanup EXIT

if [ -z "$(docker compose ps -q chirpstack 2>/dev/null)" ]; then
  echo "[e2e] bringing up the stack (excluding leftenant)…"
  # shellcheck disable=SC2086
  docker compose up -d --build --wait $SERVICES
  started=1
else
  echo "[e2e] stack already running — reusing it"
fi

# The compose demo generator emits from the same six DevEUIs on a loop, so if it is
# up (e.g. from `npm run stack:up`) the suite can end up asserting against a
# demo-loop event instead of the frame it just sent. Stop it for the duration; it
# is opt-in and stays stopped afterwards — restart with `npm run mock:up`.
echo "[e2e] stopping the mock-sensors demo generator so its loop can't race the assertions…"
docker compose --profile mock stop mock-sensors || true

# Mint the tenant + API key (idempotent). Run explicitly rather than via --wait,
# so its clean exit doesn't abort the up.
echo "[e2e] provisioning tenant + API key…"
docker compose run --rm --no-deps -T provisioner

echo "[e2e] reading tenant credentials from the shared volume…"
config_json="$(docker compose run --rm --no-deps -T --entrypoint cat provisioner /shared/config.json)"
read_field() {
  printf '%s' "$config_json" | node -e "process.stdout.write((JSON.parse(require('fs').readFileSync(0,'utf8')).$1)||'')"
}
CHIRPSTACK_API_KEY="$(read_field apiKey)"
CHIRPSTACK_TENANT_ID="$(read_field tenantId)"
export CHIRPSTACK_API_KEY CHIRPSTACK_TENANT_ID

if [ -z "$CHIRPSTACK_API_KEY" ] || [ -z "$CHIRPSTACK_TENANT_ID" ]; then
  echo "[e2e] ERROR: could not read apiKey / tenantId from /shared/config.json" >&2
  exit 1
fi
echo "[e2e] tenant ${CHIRPSTACK_TENANT_ID}"

cd "$ROOT_DIR/mock-sensors"
echo "[e2e] running e2e suite…"
npm run test:e2e
