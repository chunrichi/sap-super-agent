import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import {
  issueToken,
  loadOrCreateStateSecret,
  startServer,
  type RunningServer,
} from '@sap-superagent/server';
import {
  hookEnvelopeSchema,
  type DemandDetailResponse,
  type EventEnvelope,
  type HookEnvelope,
  type HookReceiptBody,
  type HookReplayResponse,
  type ListHooksResponse,
} from '@sap-superagent/protocol';
import {
  FakeHookTarget,
  apiRequest,
  buildFakeHookHeaders,
  computeFakeHookSignature,
  createTempStateDir,
  removeTempStateDir,
  resolveTemplatesDir,
  waitFor,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// S4 integration: generic Hook outbound queue (docs/008 §2/§5/§6, docs/009 #11).
//
// Covers task-book §1.3: 2xx delivery + HMAC/envelope, 5xx backoff retry, 4xx
// dead letter, 429 Retry-After, timeout retry, unknown eventVersion DLQ and
// demand-cancel cancellation. The target is the in-process FakeHookTarget, so
// everything runs offline and fast.
// ---------------------------------------------------------------------------

const templatesDir = resolveTemplatesDir();
const HOOK_SECRET = 'it-generic-hook-secret';

interface HookTestContext {
  server: RunningServer;
  target: FakeHookTarget;
  stateDir: string;
  userToken: string;
  adminToken: string;
  dispose(): Promise<void>;
}

interface BootOptions {
  events: string[];
  env?: Record<string, string>;
  /** Additional hooks appended to the config file (already YAML fragments). */
  hooksYaml?: string;
}

const contexts: HookTestContext[] = [];

function hookYaml(url: string, events: string[]): string {
  return `
hooks:
  - id: http-example
    target: http
    url: ${url}
    events: [${events.join(', ')}]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
    retry: { maxAttempts: 5 }
`;
}

async function bootHooks(options: BootOptions): Promise<HookTestContext> {
  const target = new FakeHookTarget({ secret: HOOK_SECRET });
  await target.start();
  const stateDir = await createTempStateDir('sa-hooks-it-');
  const configPath = join(stateDir, 'hooks.yaml');
  const yaml = options.hooksYaml ?? hookYaml(target.hookUrl, options.events);
  writeFileSync(configPath, yaml, 'utf8');
  const secret = loadOrCreateStateSecret(stateDir);
  const server = await startServer({
    stateDir,
    templatesDir,
    port: 0,
    aiProvider: new FakeModelProvider(),
    leaseTtlMs: 60_000,
    presenceTtlMs: 60_000,
    heartbeatSweepMs: 25,
    stagePollMs: 10,
    env: {
      SA_HOOKS_CONFIG: configPath,
      SA_HOOKS_HTTP_SECRET: HOOK_SECRET,
      SA_HOOKS_POLL_MS: '10',
      SA_HOOKS_RETRY_BASE_MS: '10',
      SA_HOOKS_RETRY_MAX_MS: '40',
      SA_HOOKS_TIMEOUT_MS: '150',
      ...options.env,
    },
  });
  const context: HookTestContext = {
    server,
    target,
    stateDir,
    userToken: issueToken({ kind: 'user', sub: 'hook-user', secret }),
    adminToken: issueToken({ kind: 'admin', sub: 'hook-admin', secret }),
    dispose: async () => {
      await server.close();
      await target.close();
      await removeTempStateDir(stateDir);
    },
  };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (context !== undefined) await context.dispose();
  }
});

function dbPath(context: HookTestContext): string {
  return join(context.stateDir, 'state.db');
}

/** Read-only helper (the server owns the writes; we only assert persisted state). */
function queryDb<T>(context: HookTestContext, sql: string, ...params: Array<string | number>): T[] {
  const db = new DatabaseSync(dbPath(context));
  try {
    db.exec('PRAGMA busy_timeout = 2000;');
    return db.prepare(sql).all(...params) as unknown as T[];
  } finally {
    db.close();
  }
}

function executeDb(context: HookTestContext, sql: string, ...params: Array<string | number>): void {
  const db = new DatabaseSync(dbPath(context));
  try {
    db.exec('PRAGMA busy_timeout = 2000;');
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

async function createDemand(context: HookTestContext, title: string): Promise<string> {
  const response = await apiRequest<{ demand: { id: string } }>(context.server.url, '/api/v1/demands', {
    method: 'POST',
    token: context.userToken,
    body: {
      title,
      description: '按销售组织汇总开票金额，空结果返回 0',
      acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
      priority: 'normal',
      requester: { userId: 'REQ001', orgUnit: 'PDO' },
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.demand.id;
}

async function events(context: HookTestContext): Promise<EventEnvelope[]> {
  const response = await apiRequest<{ events: EventEnvelope[] }>(
    context.server.url,
    '/api/v1/events?after=0&limit=500',
    { token: context.adminToken },
  );
  expect(response.status).toBe(200);
  return response.body.events;
}

async function waitForEvent(
  context: HookTestContext,
  type: string,
  predicate: (event: EventEnvelope) => boolean = () => true,
): Promise<EventEnvelope> {
  return waitFor(
    async () => (await events(context)).find((event) => event.type === type && predicate(event)),
    { timeoutMs: 5_000, label: `hook event ${type}`, intervalMs: 10 },
  );
}

async function waitForOutboxStatus(
  context: HookTestContext,
  status: string,
  eventId?: string,
): Promise<{ id: string; status: string; attempts: number; last_error: string | null; payload: string }> {
  return waitFor(
    async () => {
      const rows = queryDb<{
        id: string;
        status: string;
        attempts: number;
        last_error: string | null;
        payload: string;
      }>(context, `SELECT * FROM outbox WHERE target = 'hook:http-example' ORDER BY created_at ASC`);
      return rows.find(
        (row) => row.status === status && (eventId === undefined || row.id.startsWith(`${eventId}:`)),
      );
    },
    { timeoutMs: 5_000, label: `outbox ${status}`, intervalMs: 10 },
  );
}

describe('generic Hook outbound delivery (docs/008 §5)', () => {
  it('delivers the uniform envelope with valid HMAC headers and records hook.delivered', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    const demandId = await createDemand(context, 'R-3001 Hook 成功投递');

    const delivery = await context.target.waitForDelivery();
    const envelope = JSON.parse(delivery.body) as HookEnvelope;
    expect(hookEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      eventType: 'demand.created',
      eventVersion: 1,
      subject: { type: 'demand', demandId },
    });
    expect(envelope.payload['demandId']).toBe(demandId);

    // Independent HMAC check: X-SA-Signature over the exact raw body.
    expect(delivery.headers['x-sa-signature']).toBe(
      computeFakeHookSignature(HOOK_SECRET, delivery.body),
    );
    expect(delivery.headers['x-sa-delivery']).toBe(envelope.idempotencyKey);
    expect(delivery.headers['x-sa-timestamp']).toBeDefined();
    expect(delivery.headers['content-type']).toContain('application/json');

    const delivered = await waitForEvent(context, 'hook.delivered', (event) => {
      return (event.data['eventId'] ?? '') === envelope.eventId;
    });
    expect(delivered.subject).toEqual({ type: 'hook', id: 'http-example' });
    expect(delivered.data).toMatchObject({
      hookId: 'http-example',
      target: 'hook:http-example',
      attempt: 1,
      externalId: 'EXT-1',
    });

    const row = await waitForOutboxStatus(context, 'SENT');
    expect(row.attempts).toBe(1);
    expect(queryDb(context, `SELECT COUNT(*) AS total FROM outbox WHERE target LIKE 'hook:%'`)).toEqual([
      { total: 1 },
    ]);
  });

  it('retries 5xx with exponential backoff until success (hook.attempted per attempt)', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    context.target.injectFault({ kind: 'status', status: 500 });
    context.target.injectFault({ kind: 'status', status: 503 });
    await createDemand(context, 'R-3002 Hook 5xx 重试');

    await waitFor(async () => (context.target.orders.size > 0 ? true : undefined), {
      timeoutMs: 5_000,
      label: 'delivery after two 5xx',
      intervalMs: 10,
    });
    expect(context.target.deliveries).toHaveLength(3);
    expect(context.target.deliveries.map((request) => request.headers['x-sa-delivery'])).toEqual([
      context.target.deliveries[0]?.headers['x-sa-delivery'],
      context.target.deliveries[0]?.headers['x-sa-delivery'],
      context.target.deliveries[0]?.headers['x-sa-delivery'],
    ]);

    const attempted = (await events(context)).filter((event) => event.type === 'hook.attempted');
    expect(attempted).toHaveLength(2);
    expect(attempted.map((event) => event.data['attempt'])).toEqual([1, 2]);
    expect(String(attempted[0]?.data['error'])).toContain('HTTP 500');
    expect(String(attempted[1]?.data['error'])).toContain('HTTP 503');

    const row = await waitForOutboxStatus(context, 'SENT');
    expect(row.attempts).toBe(3);
    expect((await events(context)).some((event) => event.type === 'hook.delivered')).toBe(true);
  });

  it('dead-letters 4xx immediately with lastError and hook.dead', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    context.target.injectFault({ kind: 'status', status: 400, body: { error: 'invalid field' } });
    await createDemand(context, 'R-3003 Hook 4xx 死信');

    const row = await waitForOutboxStatus(context, 'DEAD');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('HTTP 400');
    expect(row.last_error).toContain('invalid field');
    const dead = await waitForEvent(context, 'hook.dead');
    expect(dead.data).toMatchObject({ hookId: 'http-example', attempt: 1 });
    expect(context.target.orders.size).toBe(0);
    expect((await events(context)).some((event) => event.type === 'hook.delivered')).toBe(false);
  });

  it('honours Retry-After on 429 and still delivers', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    context.target.injectFault({
      kind: 'status',
      status: 429,
      headers: { 'retry-after': '0' },
      body: { error: 'rate limited' },
    });
    await createDemand(context, 'R-3004 Hook 429');
    await waitFor(async () => (context.target.orders.size > 0 ? true : undefined), {
      timeoutMs: 5_000,
      label: 'delivery after 429',
      intervalMs: 10,
    });
    const attempted = (await events(context)).filter((event) => event.type === 'hook.attempted');
    expect(attempted).toHaveLength(1);
    expect(String(attempted[0]?.data['error'])).toContain('HTTP 429');
    expect((await waitForOutboxStatus(context, 'SENT')).attempts).toBe(2);
  });

  it('retries timeouts and reaches the target on the next attempt', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    context.target.injectFault({ kind: 'timeout', delayMs: 400 });
    await createDemand(context, 'R-3005 Hook 超时重试');
    await waitFor(async () => (context.target.orders.size > 0 ? true : undefined), {
      timeoutMs: 5_000,
      label: 'delivery after timeout',
      intervalMs: 10,
    });
    const failed = (await events(context)).find((event) => event.type === 'hook.attempted');
    expect(String(failed?.data['error'])).toContain('request failed');
    expect((await waitForOutboxStatus(context, 'SENT')).attempts).toBe(2);
  });

  it('dead-letters an unsupported envelope eventVersion instead of sending it', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    // Let the enqueue cursor advance past existing events, then inject a row.
    await createDemand(context, 'R-3006 Hook 版本校验');
    await waitForOutboxStatus(context, 'SENT');

    const bogus: HookEnvelope = {
      eventId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
      eventType: 'demand.created',
      eventVersion: 99,
      occurredAt: '2026-11-05T12:00:00.000Z',
      subject: { type: 'demand', id: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3' },
      payload: {},
      idempotencyKey: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3:http-example:deadbeef',
      retry: { maxAttempts: 5, backoff: 'exponential', deadLetter: true },
      traceId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
    };
    executeDb(
      context,
      `INSERT INTO outbox (id, event_seq, target, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, 0, 'hook:http-example', ?, 'PENDING', 0, ?, ?, ?)`,
      'bogus-event:http-example',
      JSON.stringify(bogus),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const dead = await waitForEvent(context, 'hook.dead', (event) => {
      return String(event.data['error'] ?? '').includes('unsupported_event_version');
    });
    expect(dead.data['error']).toContain('supported 1');
    expect(context.target.deliveries).toHaveLength(1); // only the first, valid delivery
  });

  it('cancels not-yet-sent hooks when the demand is cancelled', async () => {
    const context = await bootHooks({
      events: ['demand.created'],
      env: { SA_HOOKS_RETRY_BASE_MS: '250', SA_HOOKS_RETRY_MAX_MS: '250' },
    });
    context.target.injectFault({ kind: 'status', status: 500 });
    const demandId = await createDemand(context, 'R-3007 Hook 取消');
    await waitForEvent(context, 'hook.attempted');

    const cancelled = await apiRequest(context.server.url, `/api/v1/demands/${demandId}/cancel`, {
      method: 'POST',
      token: context.userToken,
      body: { reason: 'test cancel' },
    });
    expect(cancelled.status).toBe(200);

    const row = await waitForOutboxStatus(context, 'CANCELLED');
    expect(row.last_error).toContain('cancelled_by:demand.cancelled');
    const cancelledEvent = await waitForEvent(context, 'hook.cancelled', (event) => {
      return event.data['reason'] === 'demand.cancelled';
    });
    expect(cancelledEvent.data).toMatchObject({ hookId: 'http-example', delivered: false });
  });
});

// ---------------------------------------------------------------------------
// §1.4 management API: GET /hooks status, POST /hooks/{id}/replay idempotency.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listHooks(context: HookTestContext, token?: string): Promise<ListHooksResponse> {
  const response = await apiRequest<ListHooksResponse>(context.server.url, '/hooks', {
    token: token ?? context.adminToken,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

function hookStatus(context: HookTestContext, body: ListHooksResponse): ListHooksResponse['hooks'][number] {
  const status = body.hooks.find((hook) => hook.id === 'http-example');
  expect(status).toBeDefined();
  return status as ListHooksResponse['hooks'][number];
}

async function replay(
  context: HookTestContext,
  hookId: string,
  eventId: string,
  idempotencyKey?: string,
): Promise<{ status: number; body: HookReplayResponse | { error: { code: string } }; headers: Headers }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${context.adminToken}`,
    'content-type': 'application/json',
  };
  if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch(`${context.server.url}/hooks/${hookId}/replay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ eventId }),
  });
  return { status: response.status, body: (await response.json()) as never, headers: response.headers };
}

describe('generic Hook management API (docs/003 §4.7, docs/008 §6)', () => {
  it('reports enablement, subscriptions, queue depth, lastError and last attempt (admin only)', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    const forbidden = await apiRequest(context.server.url, '/hooks', { token: context.userToken });
    expect(forbidden.status).toBe(403);

    await createDemand(context, 'R-4001 Hook 状态');
    await waitForOutboxStatus(context, 'SENT');
    await waitForEvent(context, 'hook.delivered');
    const status = hookStatus(context, await listHooks(context));
    expect(status).toMatchObject({
      id: 'http-example',
      target: 'http',
      enabled: true,
      events: ['demand.created'],
      queue: { pending: 0, sent: 1, dead: 0, cancelled: 0 },
      lastError: null,
    });
    expect(status.lastAttempt).toMatchObject({ attempt: 1, ok: true, error: null });

    const deadContext = await bootHooks({ events: ['demand.created'] });
    deadContext.target.injectFault({ kind: 'status', status: 400, body: { error: 'bad field' } });
    await createDemand(deadContext, 'R-4002 Hook 死信状态');
    await waitForOutboxStatus(deadContext, 'DEAD');
    await waitForEvent(deadContext, 'hook.dead');
    const deadStatus = hookStatus(deadContext, await listHooks(deadContext));
    expect(deadStatus.queue).toEqual({ pending: 0, sent: 0, dead: 1, cancelled: 0 });
    expect(deadStatus.lastError).toContain('HTTP 400');
    expect(deadStatus.lastAttempt).toMatchObject({ attempt: 1, ok: false });
    expect(String(deadStatus.lastAttempt?.error)).toContain('HTTP 400');
  });

  it('replays a dead delivery by eventId and is idempotent per Idempotency-Key', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    context.target.injectFault({ kind: 'status', status: 400, body: { error: 'bad field' } });
    await createDemand(context, 'R-4003 Hook 重放');
    const deadRow = await waitForOutboxStatus(context, 'DEAD');
    const deadEnvelope = JSON.parse(deadRow.payload) as HookEnvelope;
    const deliveriesBefore = context.target.deliveries.length;
    expect(deliveriesBefore).toBe(1);

    const first = await replay(context, 'http-example', deadEnvelope.eventId, 'replay-key-1');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      hookId: 'http-example',
      eventId: deadEnvelope.eventId,
      replayed: true,
      status: 'queued',
    });
    await waitFor(async () => (context.target.orders.size === 1 ? true : undefined), {
      timeoutMs: 5_000,
      label: 'replayed delivery',
      intervalMs: 10,
    });
    expect(context.target.deliveries).toHaveLength(deliveriesBefore + 1);
    expect(context.target.idempotencyKeys.at(-1)).toBe(deadEnvelope.idempotencyKey);
    await waitForEvent(context, 'hook.delivered');
    expect((await events(context)).filter((event) => event.type === 'hook.delivered')).toHaveLength(1);

    // Same Idempotency-Key -> served from the idempotency store: no new delivery.
    const duplicate = await replay(context, 'http-example', deadEnvelope.eventId, 'replay-key-1');
    expect(duplicate.status).toBe(200);
    expect(duplicate.headers.get('idempotent-replay')).toBe('true');
    expect(duplicate.body).toEqual(first.body);
    await sleep(80);
    expect(context.target.deliveries).toHaveLength(deliveriesBefore + 1);
    expect((await events(context)).filter((event) => event.type === 'hook.delivered')).toHaveLength(1);

    // A deliberate replay with a new key re-POSTs the same idempotencyKey; the
    // external target dedupes it and no second external order is created.
    const deliberate = await replay(context, 'http-example', deadEnvelope.eventId, 'replay-key-2');
    expect(deliberate.status).toBe(200);
    expect(deliberate.body).toMatchObject({ replayed: true, status: 'queued' });
    await waitFor(async () => (context.target.deliveries.length === deliveriesBefore + 2 ? true : undefined), {
      timeoutMs: 5_000,
      label: 'deliberate replay delivery',
      intervalMs: 10,
    });
    expect(context.target.duplicateDeliveries).toBe(1);
    expect(context.target.orders.size).toBe(1);
    expect(context.target.idempotencyKeys.at(-1)).toBe(deadEnvelope.idempotencyKey);
  });

  it('validates replay requests (missing key / unknown hook / unknown event / disabled hook)', async () => {
    const context = await bootHooks({
      events: ['demand.created'],
      hooksYaml: `
hooks:
  - id: http-example
    target: http
    url: http://127.0.0.1:9099/hooks/example
    events: [demand.created]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
  - id: disabled-hook
    target: http
    url: http://127.0.0.1:9099/disabled
    events: [demand.created]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: false
`,
    });
    const eventId = '01J8ZQ9W3K5M2V7X4C6B8N0P1Q';

    const missingKey = await replay(context, 'http-example', eventId);
    expect(missingKey.status).toBe(400);
    expect((missingKey.body as { error: { code: string } }).error.code).toBe('bad_request');

    expect((await replay(context, 'unknown-hook', eventId, 'k-1')).status).toBe(404);
    expect((await replay(context, 'http-example', eventId, 'k-2')).status).toBe(404);

    const disabled = await replay(context, 'disabled-hook', eventId, 'k-3');
    expect(disabled.status).toBe(409);
    expect((disabled.body as { error: { code: string } }).error.code).toBe('conflict');
  });
});

// ---------------------------------------------------------------------------
// §1.5 inbound receipts: HMAC verification, idempotency and v1 record-only.
// ---------------------------------------------------------------------------

function receiptBody(
  idempotencyKey: string,
  externalId: string,
  status: HookReceiptBody['payload']['status'] = 'created',
): HookReceiptBody {
  return {
    eventType: 'hook.receipt',
    idempotencyKey,
    occurredAt: new Date().toISOString(),
    payload: {
      externalId,
      status,
      detailRef: `https://jira.example.com/browse/${externalId}`,
    },
  };
}

interface ReceiptCallOptions {
  secret?: string;
  delivery?: string;
  timestamp?: string;
  rawBody?: string;
}

async function postReceipt(
  context: HookTestContext,
  target: string,
  body: unknown,
  options: ReceiptCallOptions = {},
): Promise<{ status: number; body: { accepted?: boolean; duplicate?: boolean; receiptId?: string; externalId?: string; status?: string; error?: { code: string; message: string } }; headers: Headers }> {
  const rawBody = options.rawBody ?? JSON.stringify(body);
  const delivery =
    options.delivery ??
    (typeof body === 'object' && body !== null && 'idempotencyKey' in body
      ? String((body as { idempotencyKey: unknown }).idempotencyKey)
      : 'delivery-1');
  const headers = buildFakeHookHeaders({
    secret: options.secret ?? HOOK_SECRET,
    body: rawBody,
    delivery,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });
  const response = await fetch(`${context.server.url}/hooks/${target}/receipt`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  return { status: response.status, body: (await response.json()) as never, headers: response.headers };
}

describe('generic Hook inbound receipts (docs/008 §4)', () => {
  it('records a signed receipt, emits hook.receipt and is idempotent', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    const body = receiptBody('JIRA-1234:created', 'JIRA-1234');
    const first = await postReceipt(context, 'http-example', body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      accepted: true,
      duplicate: false,
      hookId: 'http-example',
      externalId: 'JIRA-1234',
      status: 'created',
    });
    const receiptId = first.body.receiptId as string;
    expect(receiptId).toBeDefined();

    const receiptEvent = await waitForEvent(context, 'hook.receipt', (event) => {
      return event.data['receiptId'] === receiptId;
    });
    expect(receiptEvent.subject).toEqual({ type: 'hook', id: 'http-example' });
    expect(receiptEvent.data).toMatchObject({
      hookId: 'http-example',
      receiptId,
      idempotencyKey: 'JIRA-1234:created',
      externalId: 'JIRA-1234',
      status: 'created',
      duplicate: false,
      linked: false,
    });

    const rows = queryDb<{
      id: string;
      hook_id: string;
      idempotency_key: string;
      delivery_id: string;
      external_id: string;
      status: string;
    }>(context, 'SELECT * FROM hook_receipts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: receiptId,
      hook_id: 'http-example',
      idempotency_key: 'JIRA-1234:created',
      external_id: 'JIRA-1234',
      status: 'created',
    });

    // Same idempotencyKey + same X-SA-Delivery: cached, no second row/event.
    const duplicate = await postReceipt(context, 'http-example', body);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ accepted: true, duplicate: true, receiptId });
    // Same delivery id with a different idempotencyKey is still the same delivery.
    const replayedDelivery = await postReceipt(
      context,
      'http-example',
      receiptBody('JIRA-1234:updated', 'JIRA-1234', 'updated'),
      { delivery: body.idempotencyKey },
    );
    expect(replayedDelivery.body).toMatchObject({ duplicate: true, receiptId });
    expect(queryDb(context, 'SELECT COUNT(*) AS total FROM hook_receipts')).toEqual([{ total: 1 }]);
    expect((await events(context)).filter((event) => event.type === 'hook.receipt')).toHaveLength(1);
  });

  it('rejects bad signatures, stale timestamps, unknown targets and invalid bodies', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    const body = receiptBody('JIRA-9999:created', 'JIRA-9999');

    const badSignature = await postReceipt(context, 'http-example', body, { secret: 'wrong-secret' });
    expect(badSignature.status).toBe(401);

    const stale = await postReceipt(context, 'http-example', body, {
      timestamp: '2000-01-01T00:00:00.000Z',
    });
    expect(stale.status).toBe(401);
    expect(stale.body.error?.message).toContain('stale_timestamp');

    const unknownTarget = await postReceipt(context, 'jira', body);
    expect(unknownTarget.status).toBe(404);

    const invalidBody = await postReceipt(context, 'http-example', { eventType: 'hook.receipt' });
    expect(invalidBody.status).toBe(400);
    const invalidJson = await postReceipt(context, 'http-example', undefined, { rawBody: '{' });
    expect(invalidJson.status).toBe(400);

    expect(queryDb(context, 'SELECT COUNT(*) AS total FROM hook_receipts')).toEqual([{ total: 0 }]);
  });

  it('scopes receipt idempotency per hook (same key on two hooks is not a duplicate)', async () => {
    const context = await bootHooks({
      events: ['demand.created'],
      hooksYaml: `
hooks:
  - id: http-example
    target: http
    url: http://127.0.0.1:9099/hooks/example
    events: [demand.created]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
  - id: second-hook
    target: http
    url: http://127.0.0.1:9099/hooks/second
    events: [demand.created]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
`,
    });
    const body = receiptBody('EXT-SHARED:created', 'EXT-SHARED');
    const first = await postReceipt(context, 'http-example', body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ duplicate: false, hookId: 'http-example' });

    const second = await postReceipt(context, 'second-hook', body);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ duplicate: false, hookId: 'second-hook' });
    expect(second.body.receiptId).not.toBe(first.body.receiptId);

    const rows = queryDb<{ hook_id: string; idempotency_key: string }>(
      context,
      'SELECT hook_id, idempotency_key FROM hook_receipts ORDER BY hook_id',
    );
    expect(rows).toEqual([
      { hook_id: 'http-example', idempotency_key: 'EXT-SHARED:created' },
      { hook_id: 'second-hook', idempotency_key: 'EXT-SHARED:created' },
    ]);
  });

  it('records an unknown externalId without failing or advancing the stage (v1)', async () => {
    const context = await bootHooks({ events: ['demand.created'] });
    const demandId = await createDemand(context, 'R-4004 回执未知外部单');

    const detailUrl = `/api/v1/demands/${demandId}`;
    const settled = await waitFor(
      async () => {
        const detail = await apiRequest<DemandDetailResponse>(context.server.url, detailUrl, {
          token: context.userToken,
        });
        return detail.body.stages.some((stage) => stage.status === 'waiting_human') ? detail.body : undefined;
      },
      { timeoutMs: 5_000, label: 'demand parked at G1', intervalMs: 10 },
    );
    const stagesBefore = settled.stages.map((stage) => `${stage.stageKey}:${stage.status}`).join('|');

    const orphan = await postReceipt(
      context,
      'http-example',
      receiptBody('EXT-ORPHAN:created', 'EXT-ORPHAN'),
    );
    expect(orphan.status, JSON.stringify(orphan.body)).toBe(200);
    expect(orphan.body).toMatchObject({ accepted: true, duplicate: false, externalId: 'EXT-ORPHAN' });
    const receiptEvent = await waitForEvent(context, 'hook.receipt', (event) => {
      return event.data['externalId'] === 'EXT-ORPHAN';
    });
    expect(receiptEvent.data['linked']).toBe(false);

    const after = await apiRequest<DemandDetailResponse>(context.server.url, detailUrl, {
      token: context.userToken,
    });
    const stagesAfter = after.body.stages.map((stage) => `${stage.stageKey}:${stage.status}`).join('|');
    expect(stagesAfter).toBe(stagesBefore);
  });
});
