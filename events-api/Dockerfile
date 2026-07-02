# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# events-api: PostGraphile (MIT-licensed, AGPL-compatible) serving a read-only
# GraphQL endpoint over the ChirpStack PostgreSQL integration tables (event_up,
# event_join, …) in events-postgres. Configuration lives in .postgraphilerc.js,
# which the `postgraphile` entrypoint auto-loads from the working directory.

FROM graphile/postgraphile:4.14.0

# Keep the image's own WORKDIR (/postgraphile) — its entrypoint is the relative
# `./cli.js`, and PostGraphile reads .postgraphilerc.js from the current directory.
# Dropping the rc file here means no CLI args (and no creds) in the entrypoint.
WORKDIR /postgraphile
COPY .postgraphilerc.js ./

# Entrypoint stays the base image's `./cli.js`; with no extra args it applies the
# options from .postgraphilerc.js (connection comes from DATABASE_URL in the env).
