import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDevServer } from '../src/commands/dev.js';
import { runInit } from '../src/commands/init.js';
import { BufferIo } from '../src/lib/io.js';

// H0 §1.6: "测试：init 后 dev 能起来（e2e 可复用）". This boots the real
// control plane on an ephemeral port from a scratch workspace after init.
const templatesDir = path.resolve(process.cwd(), '../../templates');

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sa-cli-dev-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('sap-superagent init → dev', () => {
  it('boots a healthy M1 control plane in the initialized workspace', async () => {
    const cwd = await makeTempDir();
    const io = new BufferIo();

    const init = await runInit({ cwd, io });
    expect(existsSync(init.filePath)).toBe(true);

    const stateDir = path.join(cwd, '.sap-superagent', 'state');
    const handle = await startDevServer({
      cwd,
      env: {},
      io,
      port: 0,
      stateDir,
      templatesDir,
    });
    try {
      expect(handle.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(io.text).toContain('control plane:');
      expect(handle.userToken.length).toBeGreaterThan(20);
      expect(handle.adminToken.length).toBeGreaterThan(20);

      const response = await fetch(`${handle.server.url}/api/v1/healthz`);
      expect(response.status).toBe(200);
      const health = (await response.json()) as {
        status: string;
        mode: string;
        persistence: string;
      };
      expect(health).toEqual(
        expect.objectContaining({ status: 'ok', mode: 'm1', persistence: 'sqlite' }),
      );
    } finally {
      await handle.stop();
    }

    // The state-dir lock is released on stop: a second dev boot must succeed.
    const second = await startDevServer({
      cwd,
      env: {},
      io: new BufferIo(),
      port: 0,
      stateDir,
      templatesDir,
    });
    await second.stop();
  }, 30_000);
});
