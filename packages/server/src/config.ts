import { existsSync, readFileSync } from 'node:fs';
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
const DEFAULT_WS_PING_MS = 20_000;

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

/**
 * Minimal, dependency-free `.env` parser (the repo root `.env` is ignored by
 * git; see docs/006). Supports `#` comments, `KEY=VALUE`, blank lines and
 * single/double quoted values.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    result[key] = value;
  }
  return result;
}

/** Read `<cwd>/.env`; missing/unreadable files simply yield no overrides. */
export function readEnvFile(cwd: string = process.cwd()): Record<string, string> {
  const file = resolve(cwd, '.env');
  if (!existsSync(file)) return {};
  try {
    return parseEnvFile(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Resolve effective environment: real environment variables win over `.env`
 * values (standard dotenv precedence), so CI/deploy can always override.
 */
export function resolveEnv(
  cwd: string = process.cwd(),
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...readEnvFile(cwd), ...baseEnv };
}

export function resolveConfig(options: ServerOptions): ServerConfig {
  if (typeof options.stateDir !== 'string' || options.stateDir.length === 0) {
    throw new Error('startServer requires a non-empty "stateDir" option');
  }
  const env = options.env ?? resolveEnv();
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
    wsPingMs: positiveInt(options.wsPingMs, DEFAULT_WS_PING_MS, 'wsPingMs'),
  };
}
