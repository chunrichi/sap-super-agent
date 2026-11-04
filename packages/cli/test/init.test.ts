import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BufferIo } from '../src/lib/io.js';
import { runInit } from '../src/commands/init.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sa-cli-init-'));
  tempDirs.push(dir);
  return dir;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('sap-superagent init', () => {
  it('writes workspace.json and creates the state directory', async () => {
    const cwd = await makeTempDir();
    const io = new BufferIo();

    const result = await runInit({
      cwd,
      io,
      repo: 'z-sales',
      projectKey: 'SALES',
      baseBranch: 'develop',
      prepare: 'pnpm install',
    });

    expect(result.filePath).toBe(path.join(cwd, '.sap-superagent', 'workspace.json'));
    expect(existsSync(result.stateDir)).toBe(true);
    expect(result.overwritten).toBe(false);
    await expect(readJson(result.filePath)).resolves.toEqual({
      repo: 'z-sales',
      projectKey: 'SALES',
      baseBranch: 'develop',
      prepare: 'pnpm install',
    });
    expect(io.text).toContain('已写入');
    expect(io.text).toContain('sap-superagent dev');
  });

  it('defaults baseBranch to main and omits empty optional fields', async () => {
    const cwd = await makeTempDir();
    const result = await runInit({ cwd, io: new BufferIo() });

    await expect(readJson(result.filePath)).resolves.toEqual({ baseBranch: 'main' });
  });

  it('refuses to overwrite an existing workspace.json without --force', async () => {
    const cwd = await makeTempDir();
    await runInit({ cwd, io: new BufferIo(), repo: 'first' });

    await expect(runInit({ cwd, io: new BufferIo(), repo: 'second' })).rejects.toThrow(/--force/);
    await expect(
      readJson(path.join(cwd, '.sap-superagent', 'workspace.json')),
    ).resolves.toMatchObject({ repo: 'first' });
  });

  it('overwrites with --force', async () => {
    const cwd = await makeTempDir();
    await runInit({ cwd, io: new BufferIo(), repo: 'first' });
    const io = new BufferIo();

    const result = await runInit({ cwd, io, repo: 'second', force: true });

    expect(result.overwritten).toBe(true);
    expect(io.text).toContain('已覆盖');
    await expect(
      readJson(path.join(cwd, '.sap-superagent', 'workspace.json')),
    ).resolves.toMatchObject({ repo: 'second' });
  });

  it('hints at .env when it is missing and stays quiet when present', async () => {
    const cwd = await makeTempDir();
    const withoutEnv = new BufferIo();
    const missing = await runInit({ cwd, io: withoutEnv });
    expect(missing.envFilePresent).toBe(false);
    expect(withoutEnv.text).toContain('.env');
    expect(withoutEnv.text).toContain('提示');

    await writeFile(path.join(cwd, '.env'), 'SA_AI_PROVIDER=fake\n', 'utf8');
    const withEnv = new BufferIo();
    const present = await runInit({ cwd, io: withEnv, force: true });
    expect(present.envFilePresent).toBe(true);
    expect(withEnv.text).not.toContain('提示：未找到');
  });
});
