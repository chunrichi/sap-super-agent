import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnose, isPortFree, isStateDirWritable, runDoctor } from '../src/commands/doctor.js';
import { BufferIo } from '../src/lib/io.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sa-cli-doctor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Inject everything except the checks under test: no real port, no pnpm spawn. */
const fastChecks = {
  nodeVersion: 'v24.22.2',
  checkPnpm: async () => ({ ok: true, detail: 'pnpm 10.17.1' }),
  checkPort: async (port: number) => ({ ok: true, detail: `端口 ${port} 可用` }),
  findTemplates: () => '/repo/templates',
};

describe('sap-superagent doctor', () => {
  it('reports every check and passes on a healthy machine', async () => {
    const cwd = await makeTempDir();
    const report = await diagnose({
      cwd,
      env: { SA_AI_PROVIDER: 'fake' },
      io: new BufferIo(),
      ...fastChecks,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      'node',
      'pnpm',
      'port',
      'state-dir',
      'templates',
      'ai',
    ]);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it('fails for an unwritable state dir and exits 1 with the hint', async () => {
    const cwd = await makeTempDir();
    const blocked = path.join(cwd, 'blocked-state');
    await writeFile(blocked, 'not a directory', 'utf8');

    const report = await diagnose({
      cwd,
      env: {},
      io: new BufferIo(),
      stateDir: blocked,
      ...fastChecks,
    });

    expect(report.ok).toBe(false);
    const stateCheck = report.checks.find((check) => check.id === 'state-dir');
    expect(stateCheck?.ok).toBe(false);
    expect(stateCheck?.hint).toBeDefined();

    const io = new BufferIo();
    const exitCode = await runDoctor({
      cwd,
      env: {},
      io,
      stateDir: blocked,
      ...fastChecks,
    });
    expect(exitCode).toBe(1);
    expect(io.text).toContain('✗ 状态目录可写');
    expect(io.text).toContain('1 项失败');
  });

  it('fails when the Node version is outside the supported range', async () => {
    const cwd = await makeTempDir();
    const report = await diagnose({
      cwd,
      env: {},
      io: new BufferIo(),
      ...fastChecks,
      nodeVersion: 'v22.18.0',
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'node')?.ok).toBe(false);
  });

  it('fails when BYOK variables are missing for a real provider', async () => {
    const cwd = await makeTempDir();
    const report = await diagnose({
      cwd,
      env: { SA_AI_PROVIDER: 'openai-compatible', SA_AI_MODEL: 'gpt-x' },
      io: new BufferIo(),
      ...fastChecks,
    });
    const ai = report.checks.find((check) => check.id === 'ai');
    expect(ai?.ok).toBe(false);
    expect(ai?.detail).toContain('SA_AI_API_KEY');
  });

  it('emits machine-readable JSON with --json', async () => {
    const cwd = await makeTempDir();
    const io = new BufferIo();
    const exitCode = await runDoctor({ cwd, env: {}, io, json: true, ...fastChecks });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(io.text) as { ok: boolean; checks: { id: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((check) => check.id)).toContain('state-dir');
  });
});

describe('port + state-dir checks', () => {
  it('detects a busy port and accepts it after release', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address');
    }

    await expect(isPortFree(address.port, '127.0.0.1')).resolves.toMatchObject({ ok: false });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(isPortFree(address.port, '127.0.0.1')).resolves.toMatchObject({ ok: true });
  });

  it('creates and probes the state dir', async () => {
    const cwd = await makeTempDir();
    const result = await isStateDirWritable(path.join(cwd, 'state'));
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('可写');
  });
});

describe('.env configuration (H0 §1.4)', () => {
  it('doctor reflects BYOK settings from <cwd>/.env', async () => {
    const cwd = await makeTempDir();
    await writeFile(
      path.join(cwd, '.env'),
      [
        'SA_AI_PROVIDER=openai-compatible',
        'SA_AI_BASE_URL=https://ai.example.invalid/v1',
        'SA_AI_API_KEY=dummy-key',
        'SA_AI_MODEL=test-model',
      ].join('\n'),
      'utf8',
    );

    const report = await diagnose({ cwd, env: {}, io: new BufferIo(), ...fastChecks });
    const ai = report.checks.find((check) => check.id === 'ai');
    expect(ai?.ok).toBe(true);
    expect(ai?.detail).toContain('openai-compatible');
  });

  it('lets real environment variables override .env', async () => {
    const cwd = await makeTempDir();
    await writeFile(path.join(cwd, '.env'), 'SA_AI_PROVIDER=openai-compatible\n', 'utf8');

    const report = await diagnose({
      cwd,
      env: { SA_AI_PROVIDER: 'fake' },
      io: new BufferIo(),
      ...fastChecks,
    });
    const ai = report.checks.find((check) => check.id === 'ai');
    expect(ai?.detail).toContain('fake');
  });
});
