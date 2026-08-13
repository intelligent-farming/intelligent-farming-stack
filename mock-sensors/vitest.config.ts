// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

import { defineConfig } from 'vitest/config';

// The e2e suite drives a running stack over the network, so it needs generous
// timeouts and must run its cases serially (they share one MQTT/UDP/PG session).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each case waits up to 15s for the MQTT event and then up to 15s for the
    // event_up row, so 30s would leave zero headroom: a case that succeeded
    // slowly on both would be killed by vitest's generic timeout instead of
    // reporting the suite's own diagnosable message.
    testTimeout: 45_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
