import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BYOK_REQUIRED_VARS, FAKE_PROVIDER, describeAiConfig } from '../src/lib/ai-config.js';
import { formatDurationMs, parseDurationMs } from '../src/lib/duration.js';
import { CliError } from '../src/lib/errors.js';
import {
  NODE_REQUIREMENT,
  parseNodeVersion,
  satisfiesNodeRequirement,
} from '../src/lib/node-version.js';
import {
  findEnvExample,
  findTemplatesDir,
  resolvePort,
  resolveStateDir,
} from '../src/lib/paths.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sa-cli-lib-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('duration parsing', () => {
  it('parses the CLI duration units', () => {
    expect(parseDurationMs('1500ms')).toBe(1500);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('15m')).toBe(15 * 60_000);
    expect(parseDurationMs('24h')).toBe(24 * 60 * 60_000);
    expect(parseDurationMs('7d')).toBe(7 * 24 * 60 * 60_000);
  });

  it('rejects malformed or zero durations', () => {
    expect(parseDurationMs('forever')).toBeUndefined();
    expect(parseDurationMs('1.5h')).toBeUndefined();
    expect(parseDurationMs('0s')).toBeUndefined();
    expect(parseDurationMs('')).toBeUndefined();
  });

  it('formats durations back to the shortest unit', () => {
    expect(formatDurationMs(24 * 60 * 60_000)).toBe('1d');
    expect(formatDurationMs(2 * 60 * 60_000)).toBe('2h');
    expect(formatDurationMs(90_000)).toBe('90s');
    expect(formatDurationMs(250)).toBe('250ms');
  });
});

describe('node version requirement', () => {
  it('accepts ^22.19.0 and every version >= 24.0.0', () => {
    expect(satisfiesNodeRequirement('v22.19.0')).toBe(true);
    expect(satisfiesNodeRequirement('22.19.5')).toBe(true);
    expect(satisfiesNodeRequirement('v24.0.0')).toBe(true);
    expect(satisfiesNodeRequirement('v24.22.2')).toBe(true);
    expect(satisfiesNodeRequirement('v25.1.0')).toBe(true);
  });

  it('rejects older 22.x, Node 23 and garbage', () => {
    expect(satisfiesNodeRequirement('v22.18.9')).toBe(false);
    expect(satisfiesNodeRequirement('v23.11.0')).toBe(false);
    expect(satisfiesNodeRequirement('')).toBe(false);
    expect(satisfiesNodeRequirement('not-semver')).toBe(false);
  });

  it('exposes the range string used in error messages', () => {
    expect(NODE_REQUIREMENT).toBe('^22.19.0 || >=24.0.0');
    expect(parseNodeVersion('v24.22.2')).toEqual({ major: 24, minor: 22, patch: 2, raw: 'v24.22.2' });
  });
});

describe('port / state dir resolution', () => {
  it('prefers the flag, then SA_HTTP_PORT, then 3080', () => {
    expect(resolvePort({})).toBe(3080);
    expect(resolvePort({ SA_HTTP_PORT: '3090' })).toBe(3090);
    expect(resolvePort({ SA_HTTP_PORT: '3090' }, '3099')).toBe(3099);
    expect(resolvePort({}, 0)).toBe(0);
  });

  it('rejects invalid ports', () => {
    expect(() => resolvePort({}, 'nope')).toThrow(CliError);
    expect(() => resolvePort({}, 70_000)).toThrow(/端口不合法/);
  });

  it('prefers --state-dir, then SA_STATE_DIR, then the default', () => {
    const cwd = path.resolve('/tmp/sa-cwd');
    expect(resolveStateDir(cwd, {})).toBe(path.join(cwd, '.sap-superagent', 'state'));
    expect(resolveStateDir(cwd, { SA_STATE_DIR: 'from-env' })).toBe(path.join(cwd, 'from-env'));
    expect(resolveStateDir(cwd, { SA_STATE_DIR: 'from-env' }, '/abs/state')).toBe('/abs/state');
  });
});

describe('templates / env discovery', () => {
  it('walks up from a nested directory to find templates/default.yaml', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, 'templates'), { recursive: true });
    await writeFile(path.join(root, 'templates', 'default.yaml'), 'templateId: default\n', 'utf8');
    const nested = path.join(root, 'packages', 'cli');
    await mkdir(nested, { recursive: true });

    expect(findTemplatesDir(nested)).toBe(path.join(root, 'templates'));
  });

  it('returns undefined when no template exists up the tree', async () => {
    const root = await makeTempDir();
    expect(findTemplatesDir(root)).toBeUndefined();
  });

  it('finds .env.example up the tree', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, '.env.example'), 'SA_AI_PROVIDER=fake\n', 'utf8');
    const nested = path.join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    expect(findEnvExample(nested)).toBe(path.join(root, '.env.example'));
  });
});

describe('AI config summary', () => {
  it('treats the fake provider as always ready', () => {
    expect(describeAiConfig({})).toEqual({ provider: FAKE_PROVIDER, ok: true, missing: [] });
    expect(describeAiConfig({ SA_AI_PROVIDER: 'fake' }).ok).toBe(true);
  });

  it('lists the missing BYOK variables', () => {
    const summary = describeAiConfig({ SA_AI_PROVIDER: 'deepseek', SA_AI_MODEL: 'chat' });
    expect(summary.ok).toBe(false);
    expect(summary.missing).toEqual(['SA_AI_BASE_URL', 'SA_AI_API_KEY']);
    expect(BYOK_REQUIRED_VARS).toHaveLength(3);
  });

  it('accepts a fully configured provider', () => {
    const summary = describeAiConfig({
      SA_AI_PROVIDER: 'openai-compatible',
      SA_AI_BASE_URL: 'https://example.test/v1',
      SA_AI_API_KEY: 'secret',
      SA_AI_MODEL: 'model',
    });
    expect(summary).toEqual({ provider: 'openai-compatible', ok: true, missing: [] });
  });
});
