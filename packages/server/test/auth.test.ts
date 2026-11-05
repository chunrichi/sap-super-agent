import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  issueToken,
  loadOrCreateStateSecret,
  verifyToken,
} from '../src/index.js';

describe('state secret + tokens', () => {
  it('creates a stable 0600 secret file in the state dir', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sa-auth-'));
    try {
      const first = loadOrCreateStateSecret(stateDir);
      const second = loadOrCreateStateSecret(stateDir);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(second).toBe(first);
      expect(statSync(join(stateDir, 'auth.secret')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('round-trips user, admin and executor claims', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sa-auth-'));
    try {
      const secret = loadOrCreateStateSecret(stateDir);
      const userToken = issueToken({ kind: 'user', sub: 'DEV001', secret });
      const adminToken = issueToken({ kind: 'admin', sub: 'ops', secret, ttlMs: 60_000 });
      const executorToken = issueToken({
        kind: 'executor',
        sub: 'DEV001',
        executorId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
        secret,
      });

      expect(verifyToken(userToken, secret)).toMatchObject({ kind: 'user', sub: 'DEV001' });
      expect(verifyToken(adminToken, secret)).toMatchObject({ kind: 'admin', sub: 'ops' });
      expect(verifyToken(executorToken, secret)).toMatchObject({
        kind: 'executor',
        sub: 'DEV001',
        executorId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
      });
      expect(verifyToken(userToken, secret).executorId).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('rejects tampered, foreign and expired tokens', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sa-auth-'));
    try {
      const secret = loadOrCreateStateSecret(stateDir);
      const token = issueToken({ kind: 'user', sub: 'DEV001', secret });
      const [payload, signature] = token.split('.');
      const tampered = `${Buffer.from('{"kind":"admin","sub":"evil"}').toString('base64url')}.${signature}`;

      expect(() => verifyToken(token, 'another-secret')).toThrow(/signature/);
      expect(() => verifyToken(tampered, secret)).toThrow(/signature/);
      expect(() => verifyToken(`${payload}.`, secret)).toThrow(/signature/);
      expect(() => verifyToken('not-a-token', secret)).toThrow(/malformed/);
      const expired = issueToken({ kind: 'user', sub: 'DEV001', secret, ttlMs: -1_000 });
      expect(() => verifyToken(expired, secret)).toThrow(/expired/);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
