import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import {
  issueToken,
  loadOrCreateStateSecret,
  reconcileHooks,
  resolveHooksConfig,
  startServer,
  type RunningServer,
} from '@sap-superagent/server';
import {
  hookEnvelopeSchema,
  type DemandDetailResponse,
  type EventEnvelope,
  type HookEnvelope,
  type HookReceiptBody,
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
} from '@sap-superagent/testkit';

// ---------------------------------------------------------------------------
// S4 acceptance e2e (task book §2, docs/009 #11 Hook side).
//
// One compact chain against an in-process control plane + FakeHookTarget:
//   demand -> stage event -> HTTP hook (envelope + HMAC) -> 5xx backoff ->
//   4xx dead letter -> replay (same idempotencyKey, duplicate replay cached)
//   -> signed receipt + duplicate receipt -> reconcile with both classes.
// No external process, no network; keeps `pnpm e2e` under the 5s budget.
// ---------------------------------------------------------------------------

const templatesDir = resolveTemplatesDir();
const HOOK_SECRET = 'e2e-generic-hook-secret';

let server: RunningServer;
let target: FakeHookTarget;
let stateDir: string;
let userToken: string;
let adminToken: string;
let dbPath: string;

function db(): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  database.exec('PRAGMA busy_timeout = 2000;');
  return database;
}

function readEvents(): Promise<EventEnvelope[]> {
  return apiRequest<{ events: EventEnvelope[] }>(server.url, '/api/v1/events?after=0&limit=500', {
    token: adminToken,
  }).then((response) => {
    expect(response.status).toBe(200);
    return response.body.events;
  });
}

async function waitForEvent(
  type: string,
  predicate: (event: EventEnvelope) => boolean = () => true,
): Promise<EventEnvelope> {
  return waitFor(
    async () => (await readEvents()).find((event) => event.type === type && predicate(event)),
    { timeoutMs: 5_000, label: `event ${type}`, intervalMs: 10 },
  );
}

async function createDemand(title: string): Promise<string> {
  const response = await apiRequest<{ demand: { id: string } }>(server.url, '/api/v1/demands', {
    method: 'POST',
    token: userToken,
    body: {
      title,
      description: '按销售组织汇总开票金额，空结果返回 0',
      acceptanceCriteria: ['金额与 MARA 一致'],
      priority: 'normal',
      requester: { userId: 'REQ2041', orgUnit: 'PDO' },
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.demand.id;
}

async function approveFirstGate(demandId: string): Promise<void> {
  const detail = await apiRequest<DemandDetailResponse>(server.url, `/api/v1/demands/${demandId}`, {
    token: userToken,
  });
  expect(detail.status).toBe(200);
  const approval = detail.body.approvals.find((candidate) => candidate.state === 'pending');
  expect(approval, 'pending G1 approval').toBeDefined();
  const decided = await apiRequest(server.url, `/api/v1/approvals/${approval?.id}/decisions`, {
    method: 'POST',
    token: userToken,
    body: { decision: 'approve' },
  });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
}

function signedReceipt(
  body: HookReceiptBody,
  options: { delivery?: string; timestamp?: string } = {},
): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    headers: buildFakeHookHeaders({
      secret: HOOK_SECRET,
      body: rawBody,
      delivery: options.delivery ?? body.idempotencyKey,
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    }),
  };
}

async function postReceipt(
  body: HookReceiptBody,
  options: { delivery?: string } = {},
): Promise<{ status: number; body: { duplicate?: boolean; receiptId?: string } }> {
  const { rawBody, headers } = signedReceipt(body, options);
  const response = await fetch(`${server.url}/hooks/http-example/receipt`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  return { status: response.status, body: (await response.json()) as never };
}

beforeAll(async () => {
  target = new FakeHookTarget({ secret: HOOK_SECRET });
  await target.start();
  stateDir = await createTempStateDir('sa-hooks-e2e-');
  dbPath = join(stateDir, 'state.db');
  const configPath = join(stateDir, 'hooks.yaml');
  writeFileSync(
    configPath,
    `hooks:
  - id: http-example
    target: http
    url: ${target.hookUrl}
    events: [artifact.created, stage.done]
    secretRef: env:SA_HOOKS_HTTP_SECRET
    enabled: true
    retry: { maxAttempts: 5, backoff: exponential, deadLetter: true }
    reconcileUrl: ${target.reconcileUrl}
`,
    'utf8',
  );
  const secret = loadOrCreateStateSecret(stateDir);
  server = await startServer({
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
      SA_HOOKS_RETRY_MAX_MS: '20',
      SA_HOOKS_TIMEOUT_MS: '150',
    },
  });
  userToken = issueToken({ kind: 'user', sub: 'hooks-e2e-user', secret });
  adminToken = issueToken({ kind: 'admin', sub: 'hooks-e2e-admin', secret });
});

afterAll(async () => {
  await server.close();
  await target.close();
  await removeTempStateDir(stateDir);
});

describe('S4 generic Hook e2e (docs/009 #11 Hook side, task book §2)', () => {
  it('runs delivery, retry, DLQ, replay, receipt and reconcile in one chain', async () => {
    // -- 1. demand -> AI stage event -> HTTP target receives the envelope -----
    const demandId = await createDemand('R-5001 Hook e2e');
    const first = await target.waitForDelivery();
    const firstEnvelope = JSON.parse(first.body) as HookEnvelope;
    expect(hookEnvelopeSchema.safeParse(firstEnvelope).success).toBe(true);
    expect(firstEnvelope).toMatchObject({ eventType: 'artifact.created', eventVersion: 1 });
    expect(firstEnvelope.subject.demandId).toBe(demandId);
    expect(first.headers['x-sa-signature']).toBe(computeFakeHookSignature(HOOK_SECRET, first.body));
    expect(first.headers['x-sa-delivery']).toBe(firstEnvelope.idempotencyKey);
    const firstExternalId = target.orders.get(firstEnvelope.idempotencyKey);
    expect(firstExternalId).toBeDefined();
    await waitForEvent('hook.delivered', (event) => event.data['eventId'] === firstEnvelope.eventId);

    // -- 2. 5xx x2 -> exponential backoff -> success (docs/009 #11) ----------
    target.injectFault({ kind: 'status', status: 500 });
    target.injectFault({ kind: 'status', status: 503 });
    await approveFirstGate(demandId);
    const stageEnvelope = await waitFor(
      async () => target.envelopes.find((envelope) => envelope.eventType === 'stage.done'),
      { timeoutMs: 5_000, label: 'stage.done delivery after 5xx', intervalMs: 10 },
    );
    await waitForEvent('hook.delivered', (event) => event.data['eventId'] === stageEnvelope.eventId);
    const attempted = (await readEvents()).filter(
      (event) => event.type === 'hook.attempted' && event.data['eventId'] === stageEnvelope.eventId,
    );
    expect(attempted).toHaveLength(2);
    expect(attempted.map((event) => String(event.data['error']))).toEqual([
      expect.stringContaining('HTTP 500'),
      expect.stringContaining('HTTP 503'),
    ]);

    // -- 3. 4xx -> dead letter, visible in GET /hooks ------------------------
    target.injectFault({ kind: 'status', status: 400, body: { error: 'bad field' } });
    await createDemand('R-5002 Hook 死信');
    const deadRows = await waitFor(
      async () => {
        const database = db();
        try {
          const rows = database
            .prepare(`SELECT id, payload FROM outbox WHERE target = 'hook:http-example' AND status = 'DEAD'`)
            .all() as unknown as Array<{ id: string; payload: string }>;
          return rows.length > 0 ? rows : undefined;
        } finally {
          database.close();
        }
      },
      { timeoutMs: 5_000, label: 'dead hook row', intervalMs: 10 },
    );
    const deadEnvelope = JSON.parse(deadRows[0]?.payload ?? '{}') as HookEnvelope;
    const hooksStatus = await apiRequest<ListHooksResponse>(server.url, '/hooks', { token: adminToken });
    expect(hooksStatus.status).toBe(200);
    const status = hooksStatus.body.hooks.find((hook) => hook.id === 'http-example');
    expect(status?.queue.dead).toBeGreaterThanOrEqual(1);
    expect(status?.lastError).toContain('HTTP 400');
    await waitForEvent('hook.dead', (event) => event.data['eventId'] === deadEnvelope.eventId);

    // -- 4. replay: same idempotencyKey, repeated replay is cached -----------
    const deliveriesBeforeReplay = target.deliveries.length;
    const replay = await fetch(`${server.url}/hooks/http-example/replay`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'e2e-replay-1',
      },
      body: JSON.stringify({ eventId: deadEnvelope.eventId }),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { replayed: boolean; status: string };
    expect(replayBody).toMatchObject({ replayed: true, status: 'queued' });
    await waitFor(
      async () =>
        target.deliveries.length > deliveriesBeforeReplay &&
        target.idempotencyKeys.at(-1) === deadEnvelope.idempotencyKey
          ? true
          : undefined,
      { timeoutMs: 5_000, label: 'replayed delivery', intervalMs: 10 },
    );
    expect(target.deliveries).toHaveLength(deliveriesBeforeReplay + 1);
    const duplicateReplay = await fetch(`${server.url}/hooks/http-example/replay`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'e2e-replay-1',
      },
      body: JSON.stringify({ eventId: deadEnvelope.eventId }),
    });
    expect(duplicateReplay.status).toBe(200);
    expect(duplicateReplay.headers.get('idempotent-replay')).toBe('true');

    // -- 5. signed receipt + duplicate receipt (docs/009 #11) ---------------
    const receiptBody: HookReceiptBody = {
      eventType: 'hook.receipt',
      idempotencyKey: `${firstExternalId}:created`,
      occurredAt: new Date().toISOString(),
      payload: { externalId: firstExternalId as string, status: 'created' },
    };
    const receipt = await postReceipt(receiptBody);
    expect(receipt.status).toBe(200);
    expect(receipt.body.duplicate).toBe(false);
    await waitForEvent('hook.receipt', (event) => event.data['externalId'] === firstExternalId);
    const duplicateReceipt = await postReceipt(receiptBody);
    expect(duplicateReceipt.body.duplicate).toBe(true);
    expect((await readEvents()).filter((event) => event.type === 'hook.receipt')).toHaveLength(1);
    const stale = await fetch(`${server.url}/hooks/http-example/receipt`, {
      method: 'POST',
      headers: signedReceipt(
        { ...receiptBody, idempotencyKey: 'stale:created' },
        { timestamp: '2000-01-01T00:00:00.000Z' },
      ).headers,
      body: JSON.stringify({ ...receiptBody, idempotencyKey: 'stale:created' }),
    });
    expect(stale.status).toBe(401);

    // -- 6. reconcile reports both classes (docs/009 #11 对账) --------------
    const unknownReceipt = await postReceipt({
      eventType: 'hook.receipt',
      idempotencyKey: 'EXT-GHOST:created',
      payload: { externalId: 'EXT-GHOST', status: 'created' },
    });
    expect(unknownReceipt.status).toBe(200);
    target.reconcileItems = [
      { externalId: firstExternalId as string },
      { externalId: 'EXT-ORPHAN' },
    ];
    const hooksConfig = resolveHooksConfig(
      {
        SA_HOOKS_CONFIG: join(stateDir, 'hooks.yaml'),
        SA_HOOKS_HTTP_SECRET: HOOK_SECRET,
      },
      stateDir,
    );
    const database = db();
    let report;
    try {
      report = await reconcileHooks(database, hooksConfig, { slaMs: 0 });
    } finally {
      database.close();
    }
    expect(report.counts.external_only).toBe(1);
    // The 400 row was replayed successfully, so no dead letter is left.
    expect(report.counts.dead_letter).toBe(0);
    expect(report.counts.delivered_without_receipt).toBeGreaterThanOrEqual(1);
    expect(report.counts.unknown_receipt).toBe(1);
    expect(report.differences.some((difference) => difference.kind === 'external_only')).toBe(true);
    expect(report.differences.some((difference) => difference.kind === 'delivered_without_receipt')).toBe(
      true,
    );
    expect(report.differences.some((difference) => difference.kind === 'unknown_receipt')).toBe(true);
    expect(report.summary).toContain('control plane only');
  });
});
