// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Thin ChirpStack v4 REST client (the grpc-gateway on :8090).
 *
 * Auth is a tenant API key passed as `Grpc-Metadata-Authorization: Bearer <key>`
 * — grpc-gateway maps `Grpc-Metadata-*` headers into gRPC metadata, and
 * ChirpStack reads the `authorization` metadata key. Enums are sent as their
 * proto string names (e.g. "US915", "LORAWAN_1_0_3", "JS"), which protojson
 * accepts on input.
 */

import type { Config } from './config';

export class ChirpStackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChirpStackError';
  }
}

async function request<T>(
  cfg: Config,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(cfg.restUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Grpc-Metadata-Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ChirpStackError(`${method} ${path} -> ${res.status}: ${text}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const rest = {
  get: <T>(cfg: Config, path: string) => request<T>(cfg, 'GET', path),
  post: <T>(cfg: Config, path: string, body: unknown) =>
    request<T>(cfg, 'POST', path, body),
};
