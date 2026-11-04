// Token helpers. The extension never prints or logs the token; it only reads
// the public claims (`sub`) so the executor registers under the right user.
// Tokens are opaque to us otherwise: M1 issues HS256 JWTs from the CLI, M2 will
// use OAuth device flow (docs/003 §4.1), so decoding must stay best-effort.
import { createHash } from 'node:crypto';

export const TOKEN_SECRET_STORAGE_KEY = 'sapSuperAgent.token';
export const TOKEN_ENV_VAR = 'SAP_SUPERAGENT_TOKEN';

export interface TokenClaims {
  sub?: string;
  kind?: string;
  executorId?: string;
  /** Expiry as epoch seconds (JWT `exp`). */
  exp?: number;
  iat?: number;
  [claim: string]: unknown;
}

function decodeBase64Url(value: string): string | undefined {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

function parseClaimsPayload(payload: string): TokenClaims | undefined {
  const json = decodeBase64Url(payload);
  if (json === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as TokenClaims;
}

/**
 * Best-effort decode of the payload. Two shapes are supported because M1 and
 * M2 issue different tokens (docs/003 §4.1):
 * - M1 CLI token: `<base64url payload>.<hmac hex>` (2 parts, payload first);
 * - future OAuth JWT: `<header>.<payload>.<signature>` (3 parts).
 * Returns `undefined` for opaque/malformed tokens; callers fall back to the
 * machine-id hash.
 */
export function decodeTokenClaims(token: string): TokenClaims | undefined {
  const parts = token.trim().split('.');
  if (parts.length < 2) {
    return undefined;
  }
  const candidates = parts.length >= 3 ? [parts[1], parts[0]] : [parts[0]];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') {
      continue;
    }
    const claims = parseClaimsPayload(candidate);
    if (claims !== undefined) {
      return claims;
    }
  }
  return undefined;
}

/** Non-empty `sub` claim, if the token exposes one. */
export function tokenSubject(token: string | undefined): string | undefined {
  if (token === undefined || token.trim() === '') {
    return undefined;
  }
  const subject = decodeTokenClaims(token)?.sub;
  return typeof subject === 'string' && subject.trim() !== '' ? subject.trim() : undefined;
}

/** `sha256(machineId)` — the only machine identity stored by the control plane. */
export function machineIdHash(machineId: string | undefined): string | null {
  const value = machineId?.trim();
  if (value === undefined || value === '') {
    return null;
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Executor user: the token subject when available, otherwise a stable local
 * identity derived from the hashed machine id (never the raw machine id).
 */
export function resolveExecutorUser(options: {
  token?: string | undefined;
  machineId?: string | undefined;
}): string {
  const subject = tokenSubject(options.token);
  if (subject !== undefined) {
    return subject;
  }
  const hash = machineIdHash(options.machineId);
  if (hash !== null) {
    return `vscode-${hash.slice(0, 12)}`;
  }
  return 'vscode-local';
}
