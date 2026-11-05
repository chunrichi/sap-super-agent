import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  hookEnvelopeSchema,
  type EventEnvelope,
  type HookEnvelope,
} from '@sap-superagent/protocol';
import {
  buildHookEnvelope,
  buildHookSubject,
  hookIdempotencyKey,
} from '../src/hooks/hook-envelope.js';
import {
  enabledHooks,
  findHook,
  resolveHooksConfig,
  type ResolvedHook,
} from '../src/hooks/hook-config.js';
import { createDemand, startTestServer, waitFor, api } from './helpers.js';

// ---------------------------------------------------------------------------
// S4 §1.2 acceptance: config loading (fail-closed but loud) + event trigger
// (one outbox row per enabled subscribed hook, target='hook:<id>').
// ---------------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sa-hooks-config-'));
}

function writeConfig(dir: string, name: string, yaml: string): string {
  const path = join(dir, name);
  writeFileSync(path, yaml, 'utf8');
  return path;
}

const VALID_HOOK = `
hooks:
  - id: http-example
    target: http
    url: http://127.0.0.1:1/hooks/example
    events: [demand.created]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
`;

describe('resolveHooksConfig (docs/008 §6)', () => {
  it('treats a missing default config file as "all hooks disabled"', () => {
    const dir = tempDir();
    const config = resolveHooksConfig({}, dir);
    expect(config.loaded).toBe(false);
    expect(config.hooks).toEqual([]);
    expect(config.settings.enabled).toBe(false);
    expect(config.configPath).toBe(join(dir, 'examples/hooks.yaml'));
  });

  it('fails loudly when SA_HOOKS_CONFIG points to a missing file', () => {
    const dir = tempDir();
    expect(() => resolveHooksConfig({ SA_HOOKS_CONFIG: 'nope.yaml' }, dir)).toThrow(
      /SA_HOOKS_CONFIG points to .*nope\.yaml.*does not exist.*unset SA_HOOKS_CONFIG/s,
    );
  });

  it('fails loudly on invalid YAML and schema violations with actionable text', () => {
    const dir = tempDir();
    const brokenYaml = writeConfig(dir, 'hooks.yaml', 'hooks: [\n');
    expect(() => resolveHooksConfig({ SA_HOOKS_CONFIG: brokenYaml }, dir)).toThrow(
      /cannot parse hook config .*YAML/s,
    );

    const missingUrl = writeConfig(
      dir,
      'missing-url.yaml',
      'hooks:\n  - id: jira\n    target: http\n    events: [artifact.approved]\n    secretRef: env:JIRA\n',
    );
    expect(() => resolveHooksConfig({ SA_HOOKS_CONFIG: missingUrl }, dir)).toThrow(
      /invalid hook config .*url/s,
    );
  });

  it('rejects duplicate ids, hook.* subscriptions, advanceOnReceipt and missing secrets', () => {
    const dir = tempDir();
    const duplicate = writeConfig(
      dir,
      'dup.yaml',
      `${VALID_HOOK}  - id: http-example
    target: http
    url: http://127.0.0.1:1/other
    events: [stage.done]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: false
`,
    );
    expect(() =>
      resolveHooksConfig({ SA_HOOKS_CONFIG: duplicate, SA_HOOKS_HTTP_SECRET: 's' }, dir),
    ).toThrow(/duplicate hook id "http-example"/);

    const loop = writeConfig(
      dir,
      'loop.yaml',
      VALID_HOOK.replace('[demand.created]', '[hook.delivered]'),
    );
    expect(() =>
      resolveHooksConfig({ SA_HOOKS_CONFIG: loop, SA_HOOKS_HTTP_SECRET: 's' }, dir),
    ).toThrow(/must not subscribe to hook\.delivered/);

    const advance = writeConfig(dir, 'advance.yaml', `${VALID_HOOK}    advanceOnReceipt: true
`);
    expect(() =>
      resolveHooksConfig({ SA_HOOKS_CONFIG: advance, SA_HOOKS_HTTP_SECRET: 's' }, dir),
    ).toThrow(/advanceOnReceipt: true.*not implement.*set advanceOnReceipt: false/s);

    expect(() => resolveHooksConfig({ SA_HOOKS_CONFIG: writeConfig(dir, 'ok.yaml', VALID_HOOK) }, dir)).toThrow(
      /hook "http-example" is enabled but secret "env:SA_HOOKS_HTTP_SECRET" is not set.*export SA_HOOKS_HTTP_SECRET/s,
    );
  });

  it('treats an empty/comments-only config file as valid and all-disabled', () => {
    const dir = tempDir();
    for (const [name, text] of [
      ['empty.yaml', ''],
      ['comments.yaml', '# nothing configured yet\n'],
    ] as const) {
      const config = resolveHooksConfig({ SA_HOOKS_CONFIG: writeConfig(dir, name, text) }, dir);
      expect(config.loaded, name).toBe(true);
      expect(config.hooks, name).toEqual([]);
      expect(config.settings.enabled, name).toBe(false);
    }
  });

  it('can resolve a read-only config without enabled-hook secrets (hooks:reconcile)', () => {
    const dir = tempDir();
    const path = writeConfig(dir, 'ok.yaml', VALID_HOOK);
    const config = resolveHooksConfig({ SA_HOOKS_CONFIG: path }, dir, { requireSecrets: false });
    expect(config.loaded).toBe(true);
    expect(config.hooks[0]?.enabled).toBe(true);
    expect(config.hooks[0]?.secret).toBeNull();
  });

  it('resolves retry defaults, secrets and worker tunables', () => {
    const dir = tempDir();
    const path = writeConfig(dir, 'ok.yaml', VALID_HOOK);
    const config = resolveHooksConfig(
      {
        SA_HOOKS_CONFIG: path,
        SA_HOOKS_HTTP_SECRET: 'top-secret',
        SA_HOOKS_POLL_MS: '10',
        SA_HOOKS_RETRY_BASE_MS: '5',
        SA_HOOKS_RETRY_MAX_MS: '50',
        SA_HOOKS_TIMEOUT_MS: '250',
      },
      dir,
    );
    expect(config.loaded).toBe(true);
    expect(config.settings).toEqual({
      enabled: true,
      pollMs: 10,
      retryBaseMs: 5,
      retryMaxMs: 50,
      timeoutMs: 250,
    });
    const hook = findHook(config, 'http-example');
    expect(hook).toBeDefined();
    expect(hook).toMatchObject({
      id: 'http-example',
      target: 'http',
      secret: 'top-secret',
      enabled: true,
      retry: { maxAttempts: 5, backoff: 'exponential', deadLetter: true },
    });
    expect(enabledHooks(config)).toHaveLength(1);
    // Secrets never leak into the resolved config file path / events.
    expect(JSON.stringify({ ...config, hooks: config.hooks.map((h) => ({ ...h, secret: null })) })).not.toContain(
      'top-secret',
    );
  });

  it('keeps the repository example usable: every shipped hook is disabled', () => {
    const config = resolveHooksConfig({}, join(process.cwd(), '../..'));
    expect(config.loaded).toBe(true);
    expect(config.hooks.length).toBeGreaterThanOrEqual(5);
    expect(enabledHooks(config)).toEqual([]);
  });

  it('ships valid placeholder adapter configs under examples/hooks/', () => {
    const dir = join(process.cwd(), '../..', 'examples', 'hooks');
    const files = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
    expect(files.sort()).toEqual(['charm.yaml', 'confluence.yaml', 'jira.yaml', 'teams.yaml']);
    for (const file of files) {
      const path = join(dir, file);
      const config = resolveHooksConfig({ SA_HOOKS_CONFIG: path }, dir);
      expect(config.loaded, file).toBe(true);
      expect(config.hooks, file).toHaveLength(1);
      expect(config.hooks[0]?.enabled, file).toBe(false);
      expect(enabledHooks(config), file).toEqual([]);
    }
  });
});

describe('buildHookEnvelope (docs/008 §2)', () => {
  const hook = {
    id: 'http-example',
    target: 'http',
    url: 'http://127.0.0.1:1/x',
    events: ['artifact.approved'],
    secretRef: 'env:X',
    enabled: true,
    retry: { maxAttempts: 5, backoff: 'exponential', deadLetter: true },
    secret: 's',
    advanceOnReceipt: false,
  } satisfies ResolvedHook;

  const event: EventEnvelope = {
    seq: 42,
    id: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
    type: 'artifact.approved',
    at: '2026-11-05T12:00:00.000Z',
    subject: { type: 'artifact', id: '01J8ZQ9W3K5M2V7X4C6B8N0P1R' },
    data: {
      artifactId: '01J8ZQ9W3K5M2V7X4C6B8N0P1R',
      demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
      version: 2,
      approvedBy: 'CONSULTANT01',
    },
  };

  it('builds a schema-valid envelope with a stable idempotencyKey', () => {
    const first = buildHookEnvelope(hook, event);
    const replay = buildHookEnvelope(hook, event);
    expect(first).toEqual(replay);
    expect(hookEnvelopeSchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({
      eventId: event.id,
      eventType: 'artifact.approved',
      eventVersion: 1,
      occurredAt: event.at,
      payload: event.data,
      retry: { maxAttempts: 5, backoff: 'exponential', deadLetter: true },
      traceId: event.id,
    });
    expect(first.subject).toMatchObject({
      type: 'artifact',
      id: event.subject.id,
      demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
      artifactId: event.subject.id,
      version: 2,
    });
    expect(first.idempotencyKey).toBe(hookIdempotencyKey(hook, event));
    expect(first.idempotencyKey.startsWith('4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3:http-example:')).toBe(true);
  });

  it('derives subject ids for demand and stage_run events', () => {
    const demandEvent: EventEnvelope = {
      seq: 1,
      id: '01J8ZQ9W3K5M2V7X4C6B8N0P1S',
      type: 'demand.created',
      at: '2026-11-05T12:00:00.000Z',
      subject: { type: 'demand', id: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3' },
      data: { demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3', title: 'R-1' },
    };
    const subject = buildHookSubject(demandEvent);
    expect(subject).toEqual({
      type: 'demand',
      id: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
      demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
    });
  });
});

// ---------------------------------------------------------------------------
// Trigger: a committed event must produce exactly one outbox row per enabled
// subscribed hook (target `hook:<id>`), and nothing for disabled hooks.
// ---------------------------------------------------------------------------

describe('hook trigger (docs/008 §5, task book §1.2)', () => {
  it('enqueues one outbox row per enabled subscribed hook after commit', async () => {
    const dir = tempDir();
    const configPath = writeConfig(
      dir,
      'hooks.yaml',
      `
hooks:
  - id: http-example
    target: http
    url: http://127.0.0.1:1/hooks/example
    events: [demand.created]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
  - id: disabled-example
    target: http
    url: http://127.0.0.1:1/disabled
    events: [demand.created]
    secretRef: env:DISABLED_SECRET
    enabled: false
`,
    );
    const server = await startTestServer({
      overrides: {
        env: {
          SA_HOOKS_CONFIG: configPath,
          SA_HOOKS_HTTP_SECRET: 'test-secret',
          SA_HOOKS_POLL_MS: '10',
          SA_HOOKS_RETRY_BASE_MS: '10',
          SA_HOOKS_RETRY_MAX_MS: '50',
        },
      },
    });
    const demand = await createDemand(server);
    expect(demand.id).toMatch(/^[0-9a-f]{32}$/);

    const db = new DatabaseSync(join(server.stateDir, 'state.db'));
    try {
      const rows = await waitFor(
        async () => {
          const result = db
            .prepare(`SELECT * FROM outbox WHERE target LIKE 'hook:%'`)
            .all() as unknown as Array<{ target: string; payload: string; status: string }>;
          return result.length > 0 ? result : undefined;
        },
        { timeoutMs: 3_000, label: 'hook outbox row' },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.target).toBe('hook:http-example');
      expect(rows[0]?.status).toBe('PENDING');
      const envelope = JSON.parse(rows[0]?.payload ?? '{}') as HookEnvelope;
      expect(hookEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(envelope.eventType).toBe('demand.created');
      expect(envelope.subject.demandId).toBe(demand.id);

      // One event -> one row even after further ticks (idempotent enqueue).
      await new Promise((resolve) => setTimeout(resolve, 60));
      const again = db
        .prepare(`SELECT COUNT(*) AS total FROM outbox WHERE target LIKE 'hook:%'`)
        .get() as { total: number };
      expect(Number(again.total)).toBe(1);
    } finally {
      db.close();
      await server.dispose();
    }
  });

  it('keeps the plain server behaviour unchanged without a hook config', async () => {
    const server = await startTestServer();
    const demand = await createDemand(server);
    const detail = await api(server, `/api/v1/demands/${demand.id}`, { token: server.userToken });
    expect(detail.status).toBe(200);
    const db = new DatabaseSync(join(server.stateDir, 'state.db'));
    try {
      const count = db
        .prepare(`SELECT COUNT(*) AS total FROM outbox WHERE target LIKE 'hook:%'`)
        .get() as { total: number };
      expect(Number(count.total)).toBe(0);
    } finally {
      db.close();
      await server.dispose();
    }
  });
});
