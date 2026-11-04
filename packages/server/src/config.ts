import { resolve } from 'node:path';
import {
  DEFAULT_EVENT_RETENTION_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_PRESENCE_TTL_MS,
  IDEMPOTENCY_TTL_MS,
} from '@sap-superagent/protocol';
import type { ServerConfig, ServerOptions } from './types.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3080;
const DEFAULT_HEARTBEAT_SWEEP_MS = 1_000;
const DEFAULT_STAGE_POLL_MS = 200;
const DEFAULT_VERSION = '0.0.0';

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (received ${value})`);
  }
  return value;
}

function envPort(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`SA_HTTP_PORT must be a port number between 0 and 65535 (received "${raw}")`);
  }
  return parsed;
}

function envValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export function resolveConfig(options: ServerOptions): ServerConfig {
  if (typeof options.stateDir !== 'string' || options.stateDir.length === 0) {
    throw new Error('startServer requires a non-empty "stateDir" option');
  }
  const env = process.env;
  const templatesDir =
    options.templatesDir ?? envValue(env['SA_TEMPLATES_DIR']) ?? resolve(process.cwd(), 'templates');
  const port = options.port ?? envPort(env['SA_HTTP_PORT']) ?? DEFAULT_PORT;
  return {
    host: options.host ?? DEFAULT_HOST,
    port,
    stateDir: options.stateDir,
    dbPath: options.dbPath ?? resolve(options.stateDir, 'state.db'),
    templatesDir,
    leaseTtlMs: positiveInt(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS, 'leaseTtlMs'),
    presenceTtlMs: positiveInt(options.presenceTtlMs, DEFAULT_PRESENCE_TTL_MS, 'presenceTtlMs'),
    eventRetentionMs: positiveInt(
      options.eventRetentionMs,
      DEFAULT_EVENT_RETENTION_MS,
      'eventRetentionMs',
    ),
    idempotencyTtlMs: positiveInt(options.idempotencyTtlMs, IDEMPOTENCY_TTL_MS, 'idempotencyTtlMs'),
    heartbeatSweepMs: positiveInt(
      options.heartbeatSweepMs,
      DEFAULT_HEARTBEAT_SWEEP_MS,
      'heartbeatSweepMs',
    ),
    stagePollMs: positiveInt(options.stagePollMs, DEFAULT_STAGE_POLL_MS, 'stagePollMs'),
    logger: options.logger ?? false,
    version: options.version ?? DEFAULT_VERSION,
  };
}
