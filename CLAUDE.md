# CLAUDE.md — intelligent-farming-stack

Guidance for AI coding agents (Claude Code, Copilot, etc.) and human contributors. Read this before generating or committing code. Standard across all Intelligent Farming Foundation repositories.

## What this repo is
A one-command docker-compose bench that boots ChirpStack (US915), Leftenant, and the
Intelligent Farming Hub together, auto-provisions an "Intelligent Farming" tenant + API key, and
wires everything so a fresh device runs `docker compose up` and is ready. Leftenant and the Hub
build from their sibling repos (`../leftenant`, `../intelligent-farming-hub`).

## Project & licensing (non-negotiable)
- Licensed GNU AGPL-3.0-or-later. The full text is in LICENSE at the repo root — never modify, move, or remove it.
- Copyright holder is Intelligent Farming Foundation.
- Outbound = inbound: all contributions are made under AGPL-3.0-or-later. Do not relicense, dual-license, or add a different license. Commercial/dual licensing is handled only by counsel.

## Every source file: add this header (adjust comment syntax to the language)
```
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Intelligent Farming Foundation
```
Do not paste the full license into source files — the header points to LICENSE. Keep the copyright line as "Intelligent Farming Foundation" (not an individual).

## Every commit: sign off (DCO)
- Sign off every commit with `git commit -s`.
- CI rejects commits without the Signed-off-by line. Agents creating commits must include it.

## Dependencies (license compatibility)
- OK to include: MIT, BSD-2/3-Clause, Apache-2.0, ISC, MPL-2.0, GPL-3.0, LGPL-3.0, AGPL-3.0.
- Do NOT add: GPL-2.0-only, proprietary/closed, or non-commercial/source-available licenses (BSL, SSPL, Commons Clause, Elastic License).
- Vendored code keeps its license/attribution, recorded in NOTICE. The ChirpStack config under `chirpstack/`, `mosquitto/`, `gateway-bridge/`, `postgresql/` is MIT (chirpstack-docker) — see NOTICE. If unsure, stop and flag it.

## AGPL section 13 (network/SaaS)
- If this software runs as a network service, users interacting over the network must be offered its complete source. Build in a way to get the source (e.g., a "Source" link to this repo).

## Commercial use / relicensing (route to counsel — do not act)
- Any commercial license, dual-licensing, CLA, or relicensing is handled only by the Foundation's IP counsel. Do not add commercial terms, exceptions, or additional permissions.

## Bench-only posture (do not ship as-is)
- `mosquitto.conf` allows anonymous MQTT; ChirpStack admin defaults to admin/admin; the API
  secret default is a placeholder; the Hub API/DB bind to loopback. These are bench defaults.
  Anything network-exposed needs real auth, TLS, and a rotated `CHIRPSTACK_API_SECRET`.

## Per-PR checklist
- New files have the SPDX + copyright header
- Commits signed off (`git commit -s`)
- No incompatible-licensed dependencies added
- Third-party code keeps its license/attribution (recorded in NOTICE)
- Network-facing changes preserve the section 13 "offer source" path
- No commercial/relicensing terms added (counsel's job)
