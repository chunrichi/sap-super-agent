// `sap-superagent token` — issue a local M1 static token (H0 §1.6, docs/003 §4.1).
// The HMAC secret is loaded/created next to the server state; it is never printed.
import { DEFAULT_TOKEN_TTL_MS, issueToken, loadOrCreateStateSecret } from '@sap-superagent/server';
import type { IssueTokenInput } from '@sap-superagent/server';

/** Reuse the server's token-kind union so the CLI keeps a single dependency. */
type TokenKind = IssueTokenInput['kind'];
import { parseDurationMs } from '../lib/duration.js';
import { CliError } from '../lib/errors.js';
import type { CliIo } from '../lib/io.js';
import { resolveStateDir } from '../lib/paths.js';

export interface TokenOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  kind?: string | undefined;
  user?: string | undefined;
  stateDir?: string | undefined;
  ttl?: string | undefined;
  /** Injectable clock for deterministic expiry in tests. */
  now?: (() => number) | undefined;
}

export interface IssuedToken {
  token: string;
  kind: TokenKind;
  user: string;
  expiresAt: string;
  stateDir: string;
}

const TOKEN_KINDS: readonly TokenKind[] = ['user', 'admin', 'executor'];

function parseKind(raw: string | undefined): TokenKind {
  const value = (raw ?? 'user').trim();
  if (!TOKEN_KINDS.includes(value as TokenKind)) {
    throw new CliError(`--kind 只能是 user / admin / executor（收到 "${value}"）。`);
  }
  return value as TokenKind;
}

function parseTtl(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TOKEN_TTL_MS;
  }
  const ttlMs = parseDurationMs(raw);
  if (ttlMs === undefined) {
    throw new CliError(`--ttl 不合法：${raw}（示例：30m、24h、7d）。`);
  }
  return ttlMs;
}

function loadStateSecret(stateDir: string): string {
  try {
    return loadOrCreateStateSecret(stateDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`无法初始化状态目录 ${stateDir}：${detail}`);
  }
}

/** Issue a token without printing; used by tests and by `runToken`. */
export function issueCliToken(options: TokenOptions): IssuedToken {
  const stateDir = resolveStateDir(options.cwd, options.env, options.stateDir);
  const kind = parseKind(options.kind);
  const user = (options.user ?? 'dev').trim();
  if (user === '') {
    throw new CliError('--user 不能为空。');
  }
  const ttlMs = parseTtl(options.ttl);
  const issuedAt = options.now?.() ?? Date.now();
  const secret = loadStateSecret(stateDir);
  const token = issueToken({ kind, sub: user, secret, ttlMs });
  return {
    token,
    kind,
    user,
    expiresAt: new Date(issuedAt + ttlMs).toISOString(),
    stateDir,
  };
}

export function runToken(options: TokenOptions): IssuedToken {
  const issued = issueCliToken(options);
  options.io.out(`token（kind=${issued.kind}, sub=${issued.user}）：${issued.token}`);
  options.io.out(`expires at：${issued.expiresAt}`);
  options.io.out(`状态目录：${issued.stateDir}（auth.secret 权限 0600，勿提交）`);
  options.io.out('用法：curl -H "Authorization: Bearer <token>" http://127.0.0.1:3080/api/v1/tasks');
  return issued;
}
