#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# One-command setup for the intelligent-farming-stack bench. Verifies
# prerequisites, creates .env if missing, builds + starts the whole stack, and
# waits for the one-shot provisioner (tenant + API key) to finish, then prints
# where to reach everything.
#
# Usage:
#   ./setup.sh            # build (if needed) + start + provision
#   ./setup.sh --update   # refresh images + rebuild (latest Leftenant main), keep data
#   ./setup.sh --rebuild  # force a clean image rebuild
#   ./setup.sh --down     # stop and remove the stack (keeps data volumes)
#   ./setup.sh --reset    # stop and remove the stack AND its data volumes
#
# --update refreshes the running stack from the files already on disk. To also pull
# the latest repo itself, re-run the one-line installer from the README (it re-downloads
# then updates); data volumes survive because the compose project name is pinned.
set -euo pipefail

cd "$(dirname "$0")"

# ── helpers ──────────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Read a KEY=value from .env (after it exists), falling back to a default.
# Strips inline "# comments" and surrounding whitespace.
env_val() {
  local key="$1" default="$2" line val
  line=$(grep -E "^${key}=" .env 2>/dev/null | tail -1 || true)
  if [ -z "$line" ]; then printf '%s' "$default"; return; fi
  val=${line#*=}
  val=$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')
  printf '%s' "$val"
}

COMPOSE="docker compose"

# ── teardown modes ───────────────────────────────────────────────────────────
case "${1:-}" in
  --down)
    log "Stopping stack (data volumes preserved)…"
    $COMPOSE down
    exit 0
    ;;
  --reset)
    log "Stopping stack and REMOVING data volumes…"
    $COMPOSE down -v
    exit 0
    ;;
esac

# ── prerequisites ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required (got none)."
docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop and retry."

# No sibling repos needed: Leftenant builds from its public git repo, everything
# else uses published images or builds in-repo (events-api, provisioning).

# Heads-up if the default ports are already taken (e.g. a separate
# chirpstack-docker stack). Only one stack can hold these at a time.
for p in 1883 8080 8090; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "TCP port $p is already in use — if this is another ChirpStack/Mosquitto, stop it first or change the *_PORT vars in .env."
  fi
done

# ── .env ─────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  log "Creating .env from .env.example (defaults work for a localhost bench)."
  cp .env.example .env
else
  log "Using existing .env."
fi

# ── Gateway Bridge host (for physical gateways) ──────────────────────────────
# A physical gateway forwards LoRaWAN packets to the Gateway Bridge at the HOST's
# LAN IP (a gateway can't reach `localhost`, and a bridged container can't see
# the host's LAN IP). We detect it HERE — on the host, where it's actually
# visible — and pass it to the provisioner, which writes `gatewayBridgeHost` into
# Leftenant's config.json so the Add-Gateway wizard defaults to it. An explicit
# LEFTENANT_GATEWAY_BRIDGE_HOST in .env wins.
detect_host_ip() {
  _ip=""
  if command -v ip >/dev/null 2>&1; then
    _ip=$(ip -4 route get 1.1.1.1 2>/dev/null \
      | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  fi
  if [ -z "$_ip" ] && command -v ipconfig >/dev/null 2>&1; then   # macOS
    _if=$(route -n get default 2>/dev/null | awk '/interface:/{ print $2 }')
    [ -n "$_if" ] && _ip=$(ipconfig getifaddr "$_if" 2>/dev/null)
    [ -z "$_ip" ] && _ip=$(ipconfig getifaddr en0 2>/dev/null)
  fi
  if [ -z "$_ip" ] && command -v hostname >/dev/null 2>&1; then    # Linux fallback
    _ip=$(hostname -I 2>/dev/null | awk '{ print $1 }')
  fi
  printf '%s' "$_ip"
}

LEFTENANT_GATEWAY_BRIDGE_HOST=$(env_val LEFTENANT_GATEWAY_BRIDGE_HOST "")
[ -z "$LEFTENANT_GATEWAY_BRIDGE_HOST" ] && LEFTENANT_GATEWAY_BRIDGE_HOST=$(detect_host_ip)
if [ -n "$LEFTENANT_GATEWAY_BRIDGE_HOST" ]; then
  export LEFTENANT_GATEWAY_BRIDGE_HOST
  log "Gateway Bridge host for gateways: $LEFTENANT_GATEWAY_BRIDGE_HOST"
else
  warn "Could not detect the host LAN IP — gateways will fall back to the ChirpStack URL host. Set LEFTENANT_GATEWAY_BRIDGE_HOST in .env to override."
fi

# ── Leftenant image ────────────────────────────────────────────────────────
# Built from the public repo with `docker build <giturl>` (the buildx CLI clones
# the repo server-side), NOT compose's build.context — compose mis-resolves a
# remote git context as a local path on Windows (docker/compose#13815).
LEFTENANT_IMAGE=$(env_val LEFTENANT_IMAGE "intelligent-farming-stack/leftenant:local")
LEFTENANT_GIT=$(env_val LEFTENANT_GIT "https://github.com/intelligent-farming/leftenant.git#main")
build_leftenant() {  # $1 = extra docker build flags (e.g. --pull / --no-cache)
  log "Building Leftenant image ($LEFTENANT_IMAGE) from $LEFTENANT_GIT …"
  docker build ${1:-} -t "$LEFTENANT_IMAGE" "$LEFTENANT_GIT" || die "Leftenant image build failed."
}

# ── build + up ───────────────────────────────────────────────────────────────
BUILD_FLAG="--build"
if [ "${1:-}" = "--rebuild" ]; then
  log "Forcing a clean rebuild of all images…"
  build_leftenant --no-cache
  $COMPOSE build --no-cache
elif [ "${1:-}" = "--update" ]; then
  log "Updating: pulling newer published images…"
  # --ignore-pull-failures: the Leftenant image is local-only (built below), so
  # compose can't pull it — that expected failure must not abort the update.
  $COMPOSE pull --ignore-pull-failures
  log "Rebuilding images and re-fetching Leftenant's latest main…"
  build_leftenant --pull
  $COMPOSE build --pull
else
  build_leftenant
fi

log "Starting the stack (this also runs the provisioner)…"
# `up` blocks until the provisioner exits, because leftenant depends on it with
# condition: service_completed_successfully.
$COMPOSE up -d $BUILD_FLAG

# ── verify the provisioner succeeded ─────────────────────────────────────────
PROV_RC=$(docker inspect -f '{{.State.ExitCode}}' \
  "$($COMPOSE ps -aq provisioner | tail -1)" 2>/dev/null || echo "unknown")
if [ "$PROV_RC" != "0" ]; then
  warn "provisioner exit code = $PROV_RC. Recent logs:"
  $COMPOSE logs --tail 20 provisioner || true
  die "provisioning did not complete cleanly — see the logs above."
fi
log "Provisioner completed successfully."

# ── report ───────────────────────────────────────────────────────────────────
LEFT_PORT=$(env_val LEFTENANT_HOST_PORT 4173)
CS_PORT=$(env_val CHIRPSTACK_HOST_PORT 8080)
CS_REST_PORT=$(env_val CHIRPSTACK_REST_HOST_PORT 8090)
EVENTS_PORT=$(env_val EVENTS_API_HOST_PORT 5050)
ADMIN_USER=$(env_val CHIRPSTACK_ADMIN_EMAIL admin)
ADMIN_PASS=$(env_val CHIRPSTACK_ADMIN_PASSWORD admin)

echo
log "Stack is up. Service status:"
$COMPOSE ps --format '  {{.Service}}\t{{.Status}}'

# Tenant id from the config Leftenant now serves (best-effort).
TENANT_ID=$(curl -fsS "http://localhost:${LEFT_PORT}/config.json" 2>/dev/null \
  | sed -n 's/.*"tenantId": *"\([^"]*\)".*/\1/p' || true)

echo
log "Open in your browser:"
printf '  %-22s %s\n' "Leftenant (configured)" "http://localhost:${LEFT_PORT}"
printf '  %-22s %s  (login %s / %s)\n' "ChirpStack admin" "http://localhost:${CS_PORT}" "$ADMIN_USER" "$ADMIN_PASS"
printf '  %-22s %s\n' "ChirpStack REST API" "http://localhost:${CS_REST_PORT}"
printf '  %-22s %s\n' "Event GraphQL IDE" "http://localhost:${EVENTS_PORT}/graphiql"
[ -n "$TENANT_ID" ] && printf '\n  Provisioned tenant: "%s" (id %s)\n' "$(env_val TENANT_NAME 'Intelligent Farming')" "$TENANT_ID"
echo
log "Done. Tail logs with: $COMPOSE logs -f"
