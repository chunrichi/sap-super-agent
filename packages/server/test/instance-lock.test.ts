import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import { InstanceLockedError, startServer, type RunningServer } from '../src/index.js';
import { TEMPLATES_DIR, startTestServer } from './helpers.js';

// H0 §1.4: the M1 control plane must be single-instance per state directory so
// two `sap-superagent dev` processes can never write the same SQLite database.

const tempDirs: string[] = [];
const openServers: RunningServer[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-lock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('state-dir single-instance lock', () => {
  it('rejects a second control plane on the same state directory', async () => {
    const stateDir = makeTempDir();
    const first = await startServer({
      stateDir,
      templatesDir: TEMPLATES_DIR,
      port: 0,
      aiProvider: new FakeModelProvider(),
    });
    openServers.push(first);

    await expect(
      startServer({
        stateDir,
        templatesDir: TEMPLATES_DIR,
        port: 0,
        aiProvider: new FakeModelProvider(),
      }),
    ).rejects.toBeInstanceOf(InstanceLockedError);
  });

  it('releases the lock on close so a restart works', async () => {
    const stateDir = makeTempDir();
    const first = await startServer({
      stateDir,
      templatesDir: TEMPLATES_DIR,
      port: 0,
      aiProvider: new FakeModelProvider(),
    });
    await first.close();

    const second = await startServer({
      stateDir,
      templatesDir: TEMPLATES_DIR,
      port: 0,
      aiProvider: new FakeModelProvider(),
    });
    openServers.push(second);
    expect(second.url).toMatch(/^http:\/\//);
  });

  it('reclaims a stale lock left by a crashed process', async () => {
    const stateDir = makeTempDir();
    writeFileSync(
      join(stateDir, '.instance.lock'),
      JSON.stringify({ pid: 999_999, acquiredAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );

    const running = await startServer({
      stateDir,
      templatesDir: TEMPLATES_DIR,
      port: 0,
      aiProvider: new FakeModelProvider(),
    });
    openServers.push(running);
    expect(running.port).toBeGreaterThan(0);
  });

  it('keeps the testkit restart path working on a named state dir', async () => {
    const stateDir = resolve(makeTempDir());
    const first = await startTestServer({ stateDir });
    await first.dispose();

    const second = await startTestServer({ stateDir });
    try {
      expect(second.running.url).toMatch(/^http:\/\//);
    } finally {
      await second.dispose();
    }
  });
});
