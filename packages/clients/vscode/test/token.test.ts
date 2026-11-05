import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeTokenClaims, machineIdHash, resolveExecutorUser, tokenSubject } from '../src/token.js';

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

describe('decodeTokenClaims', () => {
  it('reads the M1 CLI token shape (<payload>.<hmac>)', () => {
    const token = `${base64url(JSON.stringify({ kind: 'user', sub: 'dev', exp: 1 }))}.deadbeef`;
    expect(decodeTokenClaims(token)?.sub).toBe('dev');
    expect(tokenSubject(token)).toBe('dev');
  });

  it('reads a future OAuth JWT shape (<header>.<payload>.<signature>)', () => {
    const token = `${base64url('{"alg":"HS256"}')}.${base64url(
      JSON.stringify({ sub: 'alice', kind: 'user' }),
    )}.signature`;
    expect(decodeTokenClaims(token)?.sub).toBe('alice');
  });

  it('returns undefined for opaque or malformed tokens', () => {
    expect(decodeTokenClaims('opaque-token')).toBeUndefined();
    expect(decodeTokenClaims('')).toBeUndefined();
    expect(decodeTokenClaims('a.b')).toBeUndefined();
    expect(decodeTokenClaims(`not-json.${base64url('not-json')}`)).toBeUndefined();
  });
});

describe('executor identity', () => {
  it('hashes the machine id with sha256 and never returns it raw', () => {
    const hash = machineIdHash('machine-123');
    expect(hash).toBe(createHash('sha256').update('machine-123').digest('hex'));
    expect(machineIdHash('')).toBeNull();
    expect(machineIdHash(undefined)).toBeNull();
  });

  it('prefers the token subject over the machine id', () => {
    const token = `${base64url(JSON.stringify({ kind: 'executor', sub: 'alice' }))}.sig`;
    expect(resolveExecutorUser({ token, machineId: 'machine-123' })).toBe('alice');
  });

  it('falls back to a hashed-machine-id user', () => {
    const expected = `vscode-${createHash('sha256').update('machine-123').digest('hex').slice(0, 12)}`;
    expect(resolveExecutorUser({ token: undefined, machineId: 'machine-123' })).toBe(expected);
    expect(resolveExecutorUser({})).toBe('vscode-local');
  });
});
