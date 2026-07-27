#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# Boot the stack (if it isn't already up), run the mock-sensors end-to-end suite
# against it, then tear down only what this script started. Set E2E_KEEP=1 to
# leave the stack running afterwards (fast iteration).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

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
if [ ! -d node_modules ]; then
  echo "[e2e] installing mock-sensors deps…"
  npm install --no-audit --no-fund
fi
echo "[e2e] running e2e suite…"
npm run test:e2e
