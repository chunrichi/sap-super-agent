import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookEnvelope } from '@sap-superagent/protocol';
import { openDatabase } from '../src/db/database.js';
import { insertEvent } from '../src/db/events.js';
import { writeTransaction } from '../src/db/transaction.js';
import { resolveHooksConfig, type HooksRuntimeConfig } from '../src/hooks/hook-config.js';
import { reconcileHooks } from '../src/hooks/reconcile.js';
import {
  hookOutboxId,
  hookTarget,
  insertHookOutboxRow,
  insertHookReceipt,
  markHookOutboxDead,
  markHookOutboxSent,
  type HookReceiptRecord,
} from '../src/hooks/hook-store.js';

// ---------------------------------------------------------------------------
// S4 §1.6 unit tests: read-only reconcile builds the two documented difference
// classes (docs/008 §7) and never repairs/replays anything.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse('2026-11-05T12:00:00.000Z');
const OLD_ISO = '2026-11-03T12:00:00.000Z'; // 48h before NOW: beyond the 24h SLA

const databases: Array<ReturnType<typeof openDatabase>> = [];
const dirs: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-hooks-reconcile-'));
  dirs.push(dir);
  return dir;
}

function hookConfig(reconcileUrl: string | null): HooksRuntimeConfig {
  const dir = tempDir();
  const path = join(dir, 'hooks.yaml');
  const reconcileLine =
    reconcileUrl === null ? '' : `    reconcileUrl: ${reconcileUrl}\n`;
  writeFileSync(
    path,
    `hooks:
  - id: http-example
    target: http
    url: http://127.0.0.1:9099/hooks/example
    events: [demand.created]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
${reconcileLine}  - id: http-plain
    target: http
    url: http://127.0.0.1:9099/hooks/plain
    events: [demand.created]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
`,
    'utf8',
  );
  return resolveHooksConfig({ SA_HOOKS_CONFIG: path, SA_HOOKS_HTTP_SECRET: 's' }, dir);
}

function envelope(hookId: string, eventId: string): HookEnvelope {
  return {
    eventId,
    eventType: 'demand.created',
    eventVersion: 1,
    occurredAt: OLD_ISO,
    subject: { type: 'demand', id: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3' },
    payload: {},
    idempotencyKey: `4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3:${hookId}:deadbeef`,
    retry: { maxAttempts: 5, backoff: 'exponential', deadLetter: true },
    traceId: eventId,
  };
}

function seedDeliveryEvent(
  db: ReturnType<typeof openDatabase>,
  hookId: string,
  eventId: string,
  externalId: string | null,
): void {
  insertEvent(
    db,
    {
      type: 'hook.delivered',
      subject: { type: 'hook', id: hookId },
      data: { hookId, target: hookTarget(hookId), eventId, attempt: 1, externalId },
    },
    OLD_ISO,
  );
}

function seedReceipt(
  db: ReturnType<typeof openDatabase>,
  record: Omit<HookReceiptRecord, 'body' | 'receivedAt'>,
): void {
  writeTransaction(db, () => undefined, (tx) => {
    insertHookReceipt(tx, { ...record, body: '{}', receivedAt: OLD_ISO });
  });
}

describe('reconcileHooks (docs/008 §7)', () => {
  it('reports external-only ids, stale deliveries, dead letters and unknown receipts', async () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const hooks = hookConfig('http://127.0.0.1:9099/external/items');

    // 1) delivered + receipt: consistent, must not be reported.
    insertHookOutboxRow(db, {
      id: hookOutboxId('01J8ZQ9W3K5M2V7X4C6B8N0P1Q', 'http-example'),
      eventSeq: 1,
      target: hookTarget('http-example'),
      envelope: envelope('http-example', '01J8ZQ9W3K5M2V7X4C6B8N0P1Q'),
      nextAttemptAt: OLD_ISO,
      now: OLD_ISO,
    });
    markHookOutboxSent(db, hookOutboxId('01J8ZQ9W3K5M2V7X4C6B8N0P1Q', 'http-example'), 1, OLD_ISO);
    seedDeliveryEvent(db, 'http-example', '01J8ZQ9W3K5M2V7X4C6B8N0P1Q', 'EXT-KNOWN');
    seedReceipt(db, {
      id: '01J8ZQ9W3K5M2V7X4C6B8N0P1R',
      hookId: 'http-example',
      idempotencyKey: 'EXT-KNOWN:created',
      deliveryId: 'd-known',
      externalId: 'EXT-KNOWN',
      status: 'created',
    });

    // 2) delivered, SLA exceeded, no receipt -> control-plane-only difference.
    insertHookOutboxRow(db, {
      id: hookOutboxId('01J8ZQ9W3K5M2V7X4C6B8N0P1S', 'http-example'),
      eventSeq: 2,
      target: hookTarget('http-example'),
      envelope: envelope('http-example', '01J8ZQ9W3K5M2V7X4C6B8N0P1S'),
      nextAttemptAt: OLD_ISO,
      now: OLD_ISO,
    });
    markHookOutboxSent(db, hookOutboxId('01J8ZQ9W3K5M2V7X4C6B8N0P1S', 'http-example'), 1, OLD_ISO);
    seedDeliveryEvent(db, 'http-example', '01J8ZQ9W3K5M2V7X4C6B8N0P1S', 'EXT-LOST');

    // 3) dead letter.
    insertHookOutboxRow(db, {
      id: hookOutboxId('01J8ZQ9W3K5M2V7X4C6B8N0P1T', 'http-example'),
      eventSeq: 3,
      target: hookTarget('http-example'),
      envelope: envelope('http-example', '01J8ZQ9W3K5M2V7X4C6B8N0P1T'),
      nextAttemptAt: OLD_ISO,
      now: OLD_ISO,
    });
    markHookOutboxDead(
      db,
      hookOutboxId('01J8ZQ9W3K5M2V7X4C6B8N0P1T', 'http-example'),
      3,
      'HTTP 400: bad field',
      OLD_ISO,
    );

    // 4) unknown receipt: externalId never delivered by this hook.
    seedReceipt(db, {
      id: '01J8ZQ9W3K5M2V7X4C6B8N0P1U',
      hookId: 'http-example',
      idempotencyKey: 'EXT-ORPHAN:created',
      deliveryId: 'd-orphan',
      externalId: 'EXT-ORPHAN',
      status: 'created',
    });

    const fetched: string[] = [];
    const report = await reconcileHooks(db, hooks, {
      nowMs: NOW_MS,
      slaMs: 24 * 60 * 60 * 1_000,
      fetchExternal: async (url) => {
        fetched.push(url);
        return { items: [{ externalId: 'EXT-KNOWN' }, { externalId: 'EXT-EXTRA' }] };
      },
    });

    expect(fetched).toEqual(['http://127.0.0.1:9099/external/items']);
    expect(report.counts).toEqual({
      external_only: 1,
      delivered_without_receipt: 1,
      dead_letter: 1,
      unknown_receipt: 1,
    });
    expect(report.differences.find((difference) => difference.kind === 'external_only')).toMatchObject({
      hookId: 'http-example',
      externalId: 'EXT-EXTRA',
      class: 'external_only',
    });
    expect(
      report.differences.find((difference) => difference.kind === 'delivered_without_receipt'),
    ).toMatchObject({ externalId: 'EXT-LOST', eventId: '01J8ZQ9W3K5M2V7X4C6B8N0P1S' });
    expect(report.differences.find((difference) => difference.kind === 'dead_letter')).toMatchObject({
      eventId: '01J8ZQ9W3K5M2V7X4C6B8N0P1T',
      details: { lastError: 'HTTP 400: bad field' },
    });
    expect(report.differences.find((difference) => difference.kind === 'unknown_receipt')).toMatchObject({
      externalId: 'EXT-ORPHAN',
    });
    expect(report.queue['http-example']).toEqual({ pending: 0, sent: 2, dead: 1, cancelled: 0 });
    expect(report.summary).toContain('2 hook(s)');
    expect(report.summary).toContain('4 difference(s)');
  });

  it('explains "cannot compare" when a hook has no reconcileUrl and never fetches', async () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const hooks = hookConfig(null);
    let calls = 0;
    const report = await reconcileHooks(db, hooks, {
      nowMs: NOW_MS,
      fetchExternal: async () => {
        calls += 1;
        return [];
      },
    });
    const withUrl = report.external.find((check) => check.hookId === 'http-example');
    expect(withUrl).toMatchObject({ ok: false, externalCount: 0 });
    expect(String(withUrl?.reason)).toContain('no reconcileUrl configured');
    expect(report.external.find((check) => check.hookId === 'http-plain')?.ok).toBe(false);
    expect(calls).toBe(0);
    expect(report.differences).toEqual([]);
  });

  it('surfaces an external fetch failure as an actionable "cannot compare" reason', async () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const hooks = hookConfig('http://127.0.0.1:9099/external/items');
    const report = await reconcileHooks(db, hooks, {
      nowMs: NOW_MS,
      fetchExternal: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const check = report.external.find((entry) => entry.hookId === 'http-example');
    expect(check?.ok).toBe(false);
    expect(String(check?.reason)).toContain('ECONNREFUSED');
    expect(report.counts.external_only).toBe(0);
  });

  it('returns an empty, explicit report when no hooks are configured', async () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const report = await reconcileHooks(
      db,
      { configPath: '/nonexistent/examples/hooks.yaml', loaded: false, hooks: [], settings: {
        enabled: false,
        pollMs: 500,
        retryBaseMs: 2_000,
        retryMaxMs: 300_000,
        timeoutMs: 10_000,
      } },
      { nowMs: NOW_MS },
    );
    expect(report.hooks).toBe(0);
    expect(report.differences).toEqual([]);
    expect(report.summary).toContain('no hooks configured');
  });
});
