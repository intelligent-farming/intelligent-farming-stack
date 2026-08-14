# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# Image for the compose `mock-sensors` demo service. Compiles the TypeScript
# harness and runs the continuous emit loop by default.
#
# Two stages: the build stage carries the TypeScript/vitest/tsx toolchain, the
# runtime stage gets only `dist/` plus production dependencies. Single-stage with a
# plain `npm install` shipped the whole compiler toolchain in an image whose
# entrypoint is `node dist/cli.js`.

FROM node:20-alpine AS build

WORKDIR /app

# Install deps first for layer caching. The lockfile is committed, so `npm ci`
# gives a deterministic tree.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build the CLI, then drop the build-only deps so the runtime stage can copy
# node_modules as-is.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Bench tool: run the demo loop. `provision` is available as an override arg.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run"]
