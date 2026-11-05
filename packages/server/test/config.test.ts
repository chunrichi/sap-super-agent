import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import {
  parseEnvFile,
  readEnvFile,
  resolveConfig,
  resolveEnv,
  startServer,
  type RunningServer,
} from '../src/index.js';
import { TEMPLATES_DIR } from './helpers.js';

// H0 §1.4: M1 configuration comes from `.env` (SA_AI_*, SA_STATE_DIR, SA_HTTP_PORT).

const tempDirs: string[] = [];
const openServers: RunningServer[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('.env parsing', () => {
  it('parses comments, blank lines, quoted and inline-comment values', () => {
    const parsed = parseEnvFile(
      [
        '# server-side model provider',
        '',
        'SA_AI_PROVIDER=openai-compatible',
        'SA_AI_API_KEY="sk-test-123"',
        "SA_AI_MODEL='deepseek-chat'",
        'SA_HTTP_PORT=3099   # local dev',
        'not a valid line',
        '1INVALID=x',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      SA_AI_PROVIDER: 'openai-compatible',
      SA_AI_API_KEY: 'sk-test-123',
      SA_AI_MODEL: 'deepseek-chat',
      SA_HTTP_PORT: '3099',
    });
  });

  it('reads a missing .env as empty and real env wins over file values', () => {
    const cwd = makeTempDir();
    expect(readEnvFile(cwd)).toEqual({});

    writeFileSync(join(cwd, '.env'), 'SA_AI_PROVIDER=fake\nSA_HTTP_PORT=3099\n', 'utf8');
    expect(readEnvFile(cwd)).toEqual({ SA_AI_PROVIDER: 'fake', SA_HTTP_PORT: '3099' });
    expect(resolveEnv(cwd, { SA_HTTP_PORT: '4099' })).toMatchObject({
      SA_AI_PROVIDER: 'fake',
      SA_HTTP_PORT: '4099',
    });
  });

  it('resolveConfig takes port/templates from the resolved env, explicit options win', () => {
    const stateDir = makeTempDir();
    const env = { SA_HTTP_PORT: '3099', SA_TEMPLATES_DIR: TEMPLATES_DIR };

    const fromEnv = resolveConfig({ stateDir, env });
    expect(fromEnv.port).toBe(3099);
    expect(fromEnv.templatesDir).toBe(TEMPLATES_DIR);
    expect(fromEnv.wsPingMs).toBe(20_000);
    // S3: per-user concurrency cap defaults to 2 (docs/003 §3 rule 6).
    expect(fromEnv.maxConcurrentPerUser).toBe(2);

    const explicit = resolveConfig({
      stateDir,
      env,
      port: 0,
      templatesDir: resolve(TEMPLATES_DIR),
      wsPingMs: 50,
      maxConcurrentPerUser: 1,
    });
    expect(explicit.port).toBe(0);
    expect(explicit.wsPingMs).toBe(50);
    expect(explicit.maxConcurrentPerUser).toBe(1);
    expect(() => resolveConfig({ stateDir, env, maxConcurrentPerUser: 0 })).toThrow(
      /maxConcurrentPerUser/,
    );
  });

  it('startServer honours the .env AI provider (healthz reports it)', async () => {
    const stateDir = makeTempDir();
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, '.env'),
      [
        'SA_AI_PROVIDER=openai-compatible',
        'SA_AI_BASE_URL=https://ai.example.invalid/v1',
        'SA_AI_API_KEY=dummy-key',
        'SA_AI_MODEL=test-model',
      ].join('\n'),
      'utf8',
    );

    const running = await startServer({
      stateDir,
      templatesDir: TEMPLATES_DIR,
      port: 0,
      env: resolveEnv(cwd, {}),
    });
    openServers.push(running);

    const response = await fetch(`${running.url}/api/v1/healthz`);
    expect(response.status).toBe(200);
    const health = (await response.json()) as { aiProvider: string };
    expect(health.aiProvider).toBe('openai-compatible');
  });

  it('still defaults to the fake provider without a .env', async () => {
    const stateDir = makeTempDir();
    const running = await startServer({
      stateDir,
      templatesDir: TEMPLATES_DIR,
      port: 0,
      aiProvider: new FakeModelProvider(),
      env: {},
    });
    openServers.push(running);
    const response = await fetch(`${running.url}/api/v1/healthz`);
    const health = (await response.json()) as { aiProvider: string };
    expect(health.aiProvider).toBe('fake');
  });
});
