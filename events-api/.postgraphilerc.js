// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// PostGraphile configuration for events-api.
//
// This is the read path over the standalone device-event store. It exposes the
// `public` schema — the event_* tables ChirpStack's PostgreSQL integration writes
// (event_up, event_join, event_ack, event_tx_ack, event_status, event_location,
// event_log, event_integration) — as a GraphQL endpoint, so apps and dashboards
// query events without touching Postgres directly. It does NOT ingest anything;
// ChirpStack remains the sole writer.
//
// The connection string comes from DATABASE_URL (env) rather than a CLI flag so
// the credentials never show up in the container's process args. It points at the
// read-only `events_api` role created by postgresql/events-initdb/010_events_roles.sh
// — least privilege: SELECT on public only.

module.exports = {
  options: {
    connection: process.env.DATABASE_URL,
    schema: ['public'],
    host: '0.0.0.0', // inside the container; what's published is set by EVENTS_API_HOST_BIND
    port: 5000,

    // ── read-only posture ──────────────────────────────────────────────────
    disableDefaultMutations: true, // no create/update/delete fields in the schema
    ignoreRbac: false,             // honor the events_api role's GRANTs (SELECT only)
    // ChirpStack's event_* tables ship only a primary-key index (no index on time,
    // dev_eui, …). ignoreIndexes:true exposes orderBy/condition on every column so
    // clients can query "recent events for a device" — at bench volumes the
    // unindexed scans are fine; add indexes to event_* before relying on this at scale.
    ignoreIndexes: true,

    // ── client ergonomics ──────────────────────────────────────────────────
    cors: true,            // browser apps may call cross-origin — lock down when exposed
    dynamicJson: true,     // decoded `object` / rx_info / tx_info JSONB <-> GraphQL JSON
    enableQueryBatching: true,
    legacyRelations: 'omit',
    setofFunctionsContainNulls: false,

    // ── operational ────────────────────────────────────────────────────────
    watchPg: false,                // schema is owned by ChirpStack's migrations, not live-watched
    retryOnInitFail: true,         // tolerate the DB still finishing init on first boot
    extendedErrors: ['errcode'],   // errcode only — no detail/hint leakage to clients
    bodySizeLimit: '100kB',

    // ── GraphiQL IDE (bench convenience; turn OFF on any exposed deployment) ──
    // GraphiQL is on by default at /graphiql; EVENTS_API_GRAPHIQL=false disables it.
    disableGraphiql: process.env.API_GRAPHIQL !== 'true',
    enhanceGraphiql: true,
  },
};
