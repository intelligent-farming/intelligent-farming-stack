# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# One-command setup for the intelligent-farming-stack bench (Windows / PowerShell
# equivalent of setup.sh). Verifies prerequisites, creates .env if missing, builds
# + starts the whole stack, waits for the one-shot provisioner (tenant + API key)
# to finish, then prints where to reach everything.
#
# Usage (PowerShell):
#   .\setup.ps1            # build (if needed) + start + provision
#   .\setup.ps1 -Rebuild   # force a clean image rebuild
#   .\setup.ps1 -Down      # stop and remove the stack (keeps data volumes)
#   .\setup.ps1 -Reset     # stop and remove the stack AND its data volumes
#
# If scripts are blocked, run once:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1

[CmdletBinding()]
param(
    [switch]$Rebuild,
    [switch]$Down,
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# ── helpers ──────────────────────────────────────────────────────────────────
function Write-Log  { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Warn { param([string]$Msg) Write-Host "warning: $Msg" -ForegroundColor Yellow }
function Die        { param([string]$Msg) Write-Host "error: $Msg" -ForegroundColor Red; exit 1 }

# Read a KEY=value from .env (after it exists), falling back to a default.
# Strips inline "# comments" and surrounding whitespace.
function Get-EnvVal {
    param([string]$Key, [string]$Default)
    if (-not (Test-Path .env)) { return $Default }
    $line = (Select-String -Path .env -Pattern "^$Key=" -ErrorAction SilentlyContinue | Select-Object -Last 1)
    if (-not $line) { return $Default }
    $val = $line.Line -replace "^$Key=", ''
    $val = $val -replace '\s+#.*$', ''
    return $val.Trim()
}

# True if a local TCP port is already being listened on.
function Test-PortInUse {
    param([int]$Port)
    try {
        return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    } catch {
        return $false
    }
}

# ── teardown modes ───────────────────────────────────────────────────────────
if ($Down) {
    Write-Log "Stopping stack (data volumes preserved)..."
    docker compose down
    exit $LASTEXITCODE
}
if ($Reset) {
    Write-Log "Stopping stack and REMOVING data volumes..."
    docker compose down -v
    exit $LASTEXITCODE
}

# ── prerequisites ────────────────────────────────────────────────────────────
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "docker is not installed or not on PATH."
}
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Die "docker compose v2 is required (got none)." }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Die "the Docker daemon is not running - start Docker Desktop and retry." }

# Leftenant and the Hub build from their sibling repos in this workspace.
foreach ($repo in @('../leftenant', '../intelligent-farming-hub')) {
    if (-not (Test-Path $repo)) {
        Die "missing sibling repo '$repo' - clone it alongside this one (see README)."
    }
}

# Heads-up if the default ports are already taken (e.g. a separate
# chirpstack-docker stack). Only one stack can hold these at a time.
foreach ($p in 1883, 8080, 8090) {
    if (Test-PortInUse -Port $p) {
        Write-Warn "TCP port $p is already in use - if this is another ChirpStack/Mosquitto, stop it first or change the *_PORT vars in .env."
    }
}

# ── .env ─────────────────────────────────────────────────────────────────────
if (-not (Test-Path .env)) {
    Write-Log "Creating .env from .env.example (defaults work for a localhost bench)."
    Copy-Item .env.example .env
} else {
    Write-Log "Using existing .env."
}

# ── build + up ───────────────────────────────────────────────────────────────
if ($Rebuild) {
    Write-Log "Forcing a clean rebuild of locally-built images..."
    docker compose build --no-cache
    if ($LASTEXITCODE -ne 0) { Die "image rebuild failed." }
}

Write-Log "Starting the stack (this also runs the provisioner)..."
# `up` blocks until the provisioner exits, because leftenant depends on it with
# condition: service_completed_successfully.
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Die "docker compose up failed." }

# ── verify the provisioner succeeded ─────────────────────────────────────────
$provId = (docker compose ps -aq provisioner | Select-Object -Last 1)
$provRc = "unknown"
if ($provId) { $provRc = (docker inspect -f '{{.State.ExitCode}}' $provId) }
if ($provRc -ne "0") {
    Write-Warn "provisioner exit code = $provRc. Recent logs:"
    docker compose logs --tail 20 provisioner
    Die "provisioning did not complete cleanly - see the logs above."
}
Write-Log "Provisioner completed successfully."

# ── report ───────────────────────────────────────────────────────────────────
$leftPort  = Get-EnvVal 'LEFTENANT_HOST_PORT' '4173'
$csPort    = Get-EnvVal 'CHIRPSTACK_HOST_PORT' '8080'
$csRest    = Get-EnvVal 'CHIRPSTACK_REST_HOST_PORT' '8090'
$eventsPort = Get-EnvVal 'EVENTS_API_HOST_PORT' '5050'
$adminUser = Get-EnvVal 'CHIRPSTACK_ADMIN_EMAIL' 'admin'
$adminPass = Get-EnvVal 'CHIRPSTACK_ADMIN_PASSWORD' 'admin'
$tenantNm  = Get-EnvVal 'TENANT_NAME' 'Intelligent Farming'

Write-Host ""
Write-Log "Stack is up. Service status:"
docker compose ps --format '  {{.Service}}\t{{.Status}}'

# Tenant id from the config Leftenant now serves (best-effort).
$tenantId = $null
try {
    $cfg = Invoke-RestMethod -Uri "http://localhost:$leftPort/config.json" -TimeoutSec 5
    $tenantId = $cfg.tenantId
} catch { }

Write-Host ""
Write-Log "Open in your browser:"
Write-Host ("  {0,-22} http://localhost:{1}" -f 'Leftenant (configured)', $leftPort)
Write-Host ("  {0,-22} http://localhost:{1}  (login {2} / {3})" -f 'ChirpStack admin', $csPort, $adminUser, $adminPass)
Write-Host ("  {0,-22} http://localhost:{1}" -f 'ChirpStack REST API', $csRest)
Write-Host ("  {0,-22} http://localhost:{1}/graphiql" -f 'Event GraphQL IDE', $eventsPort)
if ($tenantId) {
    Write-Host ""
    Write-Host ("  Provisioned tenant: ""{0}"" (id {1})" -f $tenantNm, $tenantId)
}
Write-Host ""
Write-Log "Done. Tail logs with: docker compose logs -f"
