import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenKind } from '@sap-superagent/protocol';

export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const SECRET_FILE = 'auth.secret';
const SECRET_BYTES = 32;

export interface IssueTokenInput {
  kind: TokenKind;
  sub: string;
  executorId?: string;
  secret: string;
  ttlMs?: number;
}

export interface TokenClaims {
  kind: TokenKind;
  sub: string;
  executorId?: string;
  iat: number;
  exp: number;
}

/**
 * Load the control-plane HMAC secret from `${stateDir}/auth.secret`, creating a
 * fresh 0600 file on first start. The secret is what makes local tokens stable
 * across server restarts.
 */
export function loadOrCreateStateSecret(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const secretPath = join(stateDir, SECRET_FILE);
  try {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length > 0) {
      try {
        chmodSync(secretPath, 0o600);
      } catch {
        // Best effort: the file content is what matters.
      }
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

function sign(secret: string, encodedPayload: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('hex');
}

export function issueToken(input: IssueTokenInput): string {
  const nowMs = Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  const claims: TokenClaims = {
    kind: input.kind,
    sub: input.sub,
    ...(input.executorId !== undefined ? { executorId: input.executorId } : {}),
    iat: nowMs,
    exp: nowMs + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${encoded}.${sign(input.secret, encoded)}`;
}

function decodeClaims(encodedPayload: string): TokenClaims {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed token payload');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('malformed token payload');
  const record = parsed as Record<string, unknown>;
  const kind = record['kind'];
  const sub = record['sub'];
  const iat = record['iat'];
  const exp = record['exp'];
  const executorId = record['executorId'];
  if (kind !== 'user' && kind !== 'executor' && kind !== 'admin') {
    throw new Error('malformed token payload');
  }
  if (typeof sub !== 'string' || sub.length === 0) throw new Error('malformed token payload');
  if (typeof iat !== 'number' || !Number.isFinite(iat)) throw new Error('malformed token payload');
  if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new Error('malformed token payload');
  if (executorId !== undefined && typeof executorId !== 'string') {
    throw new Error('malformed token payload');
  }
  return {
    kind,
    sub,
    ...(typeof executorId === 'string' ? { executorId } : {}),
    iat,
    exp,
  };
}

function safeEqualHex(expectedHex: string, providedHex: string): boolean {
  if (expectedHex.length !== providedHex.length) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex, 'hex');
  if (expected.length !== provided.length || expected.length === 0) return false;
  return timingSafeEqual(expected, provided);
}

/** Verify a control-plane token; throws on tampering or expiry. */
export function verifyToken(token: string, secret: string): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('malformed token');
  const encoded = parts[0];
  const signature = parts[1];
  if (encoded === undefined || signature === undefined || encoded.length === 0) {
    throw new Error('malformed token');
  }
  if (!safeEqualHex(sign(secret, encoded), signature)) {
    throw new Error('invalid token signature');
  }
  const claims = decodeClaims(encoded);
  if (claims.exp <= Date.now()) throw new Error('token expired');
  return claims;
}
