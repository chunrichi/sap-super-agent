import { loadOrCreateStateSecret, verifyToken } from '@sap-superagent/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { issueCliToken, runToken } from '../src/commands/token.js';
import { BufferIo } from '../src/lib/io.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sa-cli-token-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('sap-superagent token', () => {
  it('issues a token that verifyToken accepts with the same state secret', async () => {
    const cwd = await makeTempDir();
    const now = Date.parse('2026-11-05T00:00:00.000Z');

    const issued = issueCliToken({
      cwd,
      env: {},
      io: new BufferIo(),
      kind: 'admin',
      user: 'alice',
      ttl: '1h',
      now: () => now,
    });

    expect(issued.expiresAt).toBe('2026-11-05T01:00:00.000Z');
    expect(issued.stateDir).toBe(path.join(cwd, '.sap-superagent', 'state'));

    const secret = loadOrCreateStateSecret(issued.stateDir);
    expect(verifyToken(issued.token, secret)).toMatchObject({ kind: 'admin', sub: 'alice' });
    // The secret is stable across runs, so tokens survive server restarts.
    expect(loadOrCreateStateSecret(issued.stateDir)).toBe(secret);
  });

  it('defaults to a 24h user token for sub=dev', async () => {
    const cwd = await makeTempDir();
    const now = Date.now();
    const issued = issueCliToken({ cwd, env: {}, io: new BufferIo(), now: () => now });

    expect(issued.kind).toBe('user');
    expect(issued.user).toBe('dev');
    expect(Date.parse(issued.expiresAt) - now).toBe(24 * 60 * 60 * 1000);
  });

  it('honours SA_STATE_DIR when --state-dir is absent', async () => {
    const cwd = await makeTempDir();
    const issued = issueCliToken({ cwd, env: { SA_STATE_DIR: 'custom-state' }, io: new BufferIo() });
    expect(issued.stateDir).toBe(path.join(cwd, 'custom-state'));
  });

  it('rejects an invalid kind or ttl', async () => {
    const cwd = await makeTempDir();
    expect(() => issueCliToken({ cwd, env: {}, io: new BufferIo(), kind: 'root' })).toThrow(
      /--kind/,
    );
    expect(() => issueCliToken({ cwd, env: {}, io: new BufferIo(), ttl: 'forever' })).toThrow(
      /--ttl/,
    );
  });

  it('prints the token + expiry and never the signing secret', async () => {
    const cwd = await makeTempDir();
    const io = new BufferIo();
    const issued = runToken({ cwd, env: {}, io, kind: 'executor', user: 'dev' });

    expect(io.text).toContain(issued.token);
    expect(io.text).toContain('expires at');
    expect(io.text).toContain('kind=executor');
    expect(io.text).not.toContain(loadOrCreateStateSecret(issued.stateDir));
  });
});
