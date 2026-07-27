// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

import { defineConfig } from 'vitest/config';

// The e2e suite drives a running stack over the network, so it needs generous
// timeouts and must run its cases serially (they share one MQTT/UDP/PG session).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
