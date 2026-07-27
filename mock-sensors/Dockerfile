# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# Image for the compose `mock-sensors` demo service. Compiles the TypeScript
# harness and runs the continuous emit loop by default.

FROM node:20-alpine

WORKDIR /app

# Install deps first for layer caching. No lockfile is committed, so use install.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Build the CLI.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Bench tool: run the demo loop. `provision` is available as an override arg.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run"]
