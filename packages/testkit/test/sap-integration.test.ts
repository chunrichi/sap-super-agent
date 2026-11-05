import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import {
  issueToken,
  loadOrCreateStateSecret,
  startServer,
  type RunningServer,
} from '@sap-superagent/server';
import type { DemandDetailResponse } from '@sap-superagent/protocol';
import {
  FakeIcfServer,
  apiRequest,
  createTempStateDir,
  removeTempStateDir,
  resolveTemplatesDir,
  waitFor,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// H2 Phase A integration: SAP ICF webhook ↔ control plane ↔ writeback worker.
// Covers docs/009 #11 (hook retries/dead letters/duplicate receipts) and #12
// (writeback 409 → re-pull → replay → eventual consistency). #6/#7 (SAP client
// session/lock handling) live in packages/sap-adapter tests. No real SAP and
// no external process: the fake ICF server runs in-process.
// ---------------------------------------------------------------------------

const templatesDir = resolveTemplatesDir();
const HOOK_SECRET = 'it-hook-secret';
const SERVICE_USER = 'ZSA_CP_SERVICE';
const SERVICE_PASSWORD = 'it-password';

interface SapTestContext {
  fake: FakeIcfServer;
  server: RunningServer;
  stateDir: string;
  baseUrl: string;
  userToken: string;
  adminToken: string;
  dispose(): Promise<void>;
}

interface BootOptions {
  aiProvider?: FakeModelProvider;
  fake?: FakeIcfServer;
  /** Extra/overriding SA_SAP_* env for the server. */
  env?: Record<string, string>;
  /** Omit all SA_SAP_* config to simulate a deployment without SAP. */
  disabled?: boolean;
}

function sapEnv(fake: FakeIcfServer, extra?: Record<string, string>): Record<string, string> {
  return {
    SA_SAP_BASE_URL: fake.url,
    SA_SAP_SERVICE_USER: SERVICE_USER,
    SA_SAP_SERVICE_PASSWORD: SERVICE_PASSWORD,
    SA_SAP_HOOK_SECRET: HOOK_SECRET,
    SA_SAP_WRITEBACK_POLL_MS: '10',
    SA_SAP_WRITEBACK_BACKOFF_BASE_MS: '10',
    SA_SAP_WRITEBACK_BACKOFF_MAX_MS: '40',
    SA_SAP_WRITEBACK_MAX_ATTEMPTS: '3',
    SA_SAP_TIMEOUT_MS: '1000',
    ...extra,
  };
}

const contexts: SapTestContext[] = [];

async function bootSap(options: BootOptions = {}): Promise<SapTestContext> {
  const fake =
    options.fake ??
    new FakeIcfServer({ hookSecret: HOOK_SECRET, serviceUser: SERVICE_USER, servicePassword: SERVICE_PASSWORD });
  await fake.start();
  const stateDir = await createTempStateDir();
  const secret = loadOrCreateStateSecret(stateDir);
  const server = await startServer({
    stateDir,
    templatesDir,
    port: 0,
    aiProvider: options.aiProvider ?? new FakeModelProvider(),
    leaseTtlMs: 60_000,
    presenceTtlMs: 60_000,
    heartbeatSweepMs: 50,
    stagePollMs: 10,
    env: options.disabled === true ? options.env ?? {} : sapEnv(fake, options.env),
  });
  const context: SapTestContext = {
    fake,
    server,
    stateDir,
    baseUrl: server.url,
    userToken: issueToken({ kind: 'user', sub: 'sap-e2e-user', secret }),
    adminToken: issueToken({ kind: 'admin', sub: 'sap-e2e-admin', secret }),
    dispose: async () => {
      await server.close();
      if (options.fake === undefined) await fake.close();
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

async function deliver(ctx: SapTestContext, options: Parameters<FakeIcfServer['deliverEvents']>[1] = {}) {
  const results = await ctx.fake.deliverEvents(ctx.baseUrl, options);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) expect(result.status, JSON.stringify(result.body)).toBe(200);
  return results;
}

async function demandDetail(ctx: SapTestContext, demandId: string): Promise<DemandDetailResponse> {
  const response = await apiRequest<DemandDetailResponse>(
    ctx.baseUrl,
    `/api/v1/demands/${demandId}`,
    { token: ctx.userToken },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function waitForStage(
  ctx: SapTestContext,
  demandId: string,
  stageKey: string,
  status: string,
): Promise<DemandDetailResponse> {
  return waitFor(
    async () => {
      const detail = await demandDetail(ctx, demandId);
      const stage = detail.stages.find((entry) => entry.stageKey === stageKey);
      return stage?.status === status ? detail : undefined;
    },
    { timeoutMs: 5_000, label: `stage ${stageKey}=${status}` },
  );
}

interface SapOutboxStatus {
  enabled: { outbound: boolean; inbound: boolean };
  outbox: { pending: number; sent: number; dead: number; lastError: string | null };
}

async function outboxStatus(ctx: SapTestContext): Promise<SapOutboxStatus> {
  const response = await apiRequest<SapOutboxStatus>(ctx.baseUrl, '/hooks/sap/status', {
    token: ctx.adminToken,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function waitForOutboxDrained(ctx: SapTestContext): Promise<SapOutboxStatus> {
  return waitFor(
    async () => {
      const status = await outboxStatus(ctx);
      return status.outbox.pending === 0 ? status : undefined;
    },
    { timeoutMs: 5_000, label: 'sap writeback outbox drained' },
  );
}

function postSignedJson(baseUrl: string, body: string, headers: Record<string, string>) {
  return fetch(`${baseUrl}/hooks/sap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function signedHeaders(body: string, secret = HOOK_SECRET, timestamp = new Date().toISOString()) {
  return {
    'x-sa-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    'x-sa-timestamp': timestamp,
    'x-sa-delivery': 'manual-delivery-1',
  };
}

describe('SAP inbound webhook (POST /hooks/sap)', () => {
  it('creates a demand from demand.submitted, keeps it unbound, and is idempotent per delivery', async () => {
    const ctx = await bootSap();
    const { demand, event } = ctx.fake.createDemandFromUi({
      title: '取数逻辑',
      description: '按销售组织汇总开票金额',
      acceptanceCriteria: ['金额与 MARA 一致'],
      requesterUserId: 'REQ001',
      orgUnit: 'PDO',
      priority: 'high',
    });
    const results = await deliver(ctx);
    expect(results[0]).toMatchObject({
      eventId: event.eventId,
      type: 'demand.submitted',
      status: 200,
      body: { accepted: true, duplicate: false, action: 'demand_created' },
    });

    const demandId = demand.demandId.toLowerCase();
    const detail = await demandDetail(ctx, demandId);
    expect(detail.demand).toMatchObject({
      id: demandId,
      no: demand.demandNo,
      title: '取数逻辑',
      source: 'sap',
      workspaceBinding: null,
      priority: 'high',
    });
    expect(detail.demand.requester).toEqual({ userId: 'REQ001', orgUnit: 'PDO' });
    expect(detail.stages.map((stage) => stage.stageKey)).toEqual([
      'requirement_analysis',
      'dev_implementation',
      'acceptance_archive',
    ]);

    // Same X-SA-Delivery again → duplicate, no second demand/event.
    const replay = ctx.fake.buildDelivery(event);
    const duplicate = await postSignedJson(ctx.baseUrl, replay.body, replay.headers);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      type: 'demand.submitted',
      action: 'demand_created',
    });
    const list = await apiRequest<{ demands: unknown[] }>(ctx.baseUrl, '/api/v1/demands', {
      token: ctx.userToken,
    });
    expect(list.body.demands).toHaveLength(1);

    // The AI stage still runs and produces the requirement_analysis artifact.
    const analyzed = await waitForStage(ctx, demandId, 'requirement_analysis', 'waiting_human');
    expect(analyzed.artifacts.map((artifact) => artifact.kind)).toContain('requirement_analysis');
  });

  it('rejects bad signatures, stale timestamps, mismatched delivery ids and malformed JSON', async () => {
    const ctx = await bootSap();
    const { demand, event } = ctx.fake.createDemandFromUi({ title: '签名校验' });
    const valid = ctx.fake.buildDelivery(event);

    const tampered = ctx.fake.buildDelivery(event, { tamper: 'signature' });
    const badSignature = await postSignedJson(ctx.baseUrl, tampered.body, tampered.headers);
    expect(badSignature.status).toBe(401);
    expect(await badSignature.json()).toMatchObject({ error: { code: 'unauthorized' } });

    const stale = ctx.fake.buildDelivery(event, { timestamp: '2000-01-01T00:00:00.000Z' });
    expect((await postSignedJson(ctx.baseUrl, stale.body, stale.headers)).status).toBe(401);

    const missingDelivery = await postSignedJson(ctx.baseUrl, valid.body, {
      'x-sa-signature': valid.headers['x-sa-signature'] ?? '',
      'x-sa-timestamp': new Date().toISOString(),
    });
    expect(missingDelivery.status).toBe(401);

    // Signature is valid for the malformed body but JSON parsing must 400.
    const malformedBody = '{"data": {"type": "demand.submitted"';
    const malformed = await postSignedJson(
      ctx.baseUrl,
      malformedBody,
      signedHeaders(malformedBody),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'bad_request' } });

    // body.eventId must match X-SA-Delivery.
    const envelope = JSON.parse(valid.body) as Record<string, unknown>;
    const mismatchedBody = JSON.stringify({ ...envelope, eventId: 'other-event' });
    const mismatched = await postSignedJson(
      ctx.baseUrl,
      mismatchedBody,
      signedHeaders(mismatchedBody),
    );
    expect(mismatched.status).toBe(400);

    // Nothing above should have created a demand.
    const list = await apiRequest<{ demands: unknown[] }>(ctx.baseUrl, '/api/v1/demands', {
      token: ctx.userToken,
    });
    expect(list.body.demands).toHaveLength(0);
    expect(ctx.fake.demands.has(demand.demandId)).toBe(true);
  });

  it('syncs SAP field changes (demand.updated) and cancellations into the control plane', async () => {
    const ctx = await bootSap();
    const { demand } = ctx.fake.createDemandFromUi({ title: '旧标题', description: '旧描述' });
    await deliver(ctx);
    const demandId = demand.demandId.toLowerCase();
    await waitForStage(ctx, demandId, 'requirement_analysis', 'waiting_human');

    const stored = ctx.fake.demands.get(demand.demandId);
    expect(stored).toBeDefined();
    if (stored !== undefined) {
      stored.title = '新标题（SAP 修改）';
      stored.description = '新描述';
      stored.version += 1;
      stored.changedAt = new Date().toISOString();
    }
    ctx.fake.enqueueEvent('demand.updated', demand.demandId, {
      demand: ctx.fake.demandSnapshot(stored ?? demand),
    });
    const updated = await deliver(ctx);
    expect(updated[0]?.body).toMatchObject({ action: 'demand_updated' });
    const afterUpdate = await demandDetail(ctx, demandId);
    expect(afterUpdate.demand.title).toBe('新标题（SAP 修改）');
    expect(afterUpdate.events.map((item) => item.type)).toContain('demand.updated');

    ctx.fake.enqueueEvent('demand.cancelled', demand.demandId, { reason: '业务取消' });
    const cancelled = await deliver(ctx);
    expect(cancelled[0]?.body).toMatchObject({ action: 'demand_cancelled' });
    const afterCancel = await demandDetail(ctx, demandId);
    expect(afterCancel.demand.status).toBe('cancelled');
    expect(
      afterCancel.stages.find((stage) => stage.stageKey === 'dev_implementation')?.status,
    ).toBe('cancelled');
  });

  it('federates a SAP gate approval to the H1 gate runtime: approve closes the stage and advances', async () => {
    const ctx = await bootSap();
    const { demand } = ctx.fake.createDemandFromUi({ title: '门禁需求' });
    await deliver(ctx);
    const demandId = demand.demandId.toLowerCase();
    const parked = await waitForStage(ctx, demandId, 'requirement_analysis', 'waiting_human');
    expect(parked.artifacts).toHaveLength(1);
    expect(parked.artifacts[0]?.state).toBe('in_review');

    ctx.fake.enqueueEvent('artifact.approved', demand.demandId, {
      demandId: demand.demandId,
      stageKey: 'requirement_analysis',
      gateKey: 'G1',
      decidedBy: 'CONSULTANT01',
      comment: '同意进入开发',
      decidedAt: new Date().toISOString(),
    });
    const [result] = await deliver(ctx);
    expect(result?.body).toMatchObject({ action: 'stage_advanced' });

    const advanced = await demandDetail(ctx, demandId);
    expect(advanced.stages.find((stage) => stage.stageKey === 'requirement_analysis')?.status).toBe(
      'done',
    );
    expect(advanced.stages.find((stage) => stage.stageKey === 'dev_implementation')?.status).toBe(
      'ready',
    );
    expect(advanced.artifacts[0]?.state).toBe('approved');
    const stageDone = advanced.events.find((event) => event.type === 'stage.done');
    expect(stageDone?.data).toMatchObject({ approvedBy: 'CONSULTANT01' });
  });
  it('starts a new attempt on a SAP rejection and keeps the artifact version chain', async () => {
    const ctx = await bootSap();
    const { demand } = ctx.fake.createDemandFromUi({ title: '工件驳回' });
    await deliver(ctx);
    const demandId = demand.demandId.toLowerCase();
    const parked = await waitForStage(ctx, demandId, 'requirement_analysis', 'waiting_human');
    const artifact = parked.artifacts[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;

    ctx.fake.enqueueEvent('artifact.rejected', demand.demandId, {
      demandId: demand.demandId,
      artifactId: artifact.id,
      stageKey: 'requirement_analysis',
      gateKey: 'G1',
      decidedBy: 'CONSULTANT01',
      comment: '请补充验收标准',
      decidedAt: new Date().toISOString(),
    });
    const [result] = await deliver(ctx);
    expect(result?.body).toMatchObject({ action: 'stage_reopened' });

    // Attempt 2 re-runs on a fresh immutable version and parks at the gate again
    // (the old version is kept, never overwritten: docs/003 §2.4).
    const rerun = await waitForStage(ctx, demandId, 'requirement_analysis', 'waiting_human');
    expect(rerun.stages.find((stage) => stage.stageKey === 'requirement_analysis')?.attempt).toBe(2);
    // Same artifact id, new version in the chain.
    const chain = rerun.artifacts.find((entry) => entry.id === artifact.id);
    expect(chain?.currentVersion).toBe(2);
    expect(rerun.artifactVersions.filter((entry) => entry.artifactId === artifact.id)).toHaveLength(2);
    const rerunEvents = rerun.events.map((event) => event.type);
    expect(rerunEvents).toContain('artifact.rejected');
    expect(rerunEvents).toContain('stage.ready');
  });
  it('is fully disabled when SA_SAP_* is not configured (H0/H1 unaffected)', async () => {
    const ctx = await bootSap({ disabled: true });
    const response = await fetch(`${ctx.baseUrl}/hooks/sap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"data":{"type":"demand.submitted"}}',
    });
    expect(response.status).toBe(404);
    const status = await fetch(`${ctx.baseUrl}/hooks/sap/status`, {
      headers: { authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(status.status).toBe(404);
    // The rest of the control plane still works.
    const health = await apiRequest<{ status: string }>(ctx.baseUrl, '/healthz');
    expect(health.body.status).toBe('ok');
  });
});

describe('SAP writeback worker (outbox → PATCH ICF)', () => {
  it('projects status/artifact metadata into SAP and replays after a 409 (docs/009 #12)', async () => {
    const ctx = await bootSap();
    const { demand } = ctx.fake.createDemandFromUi({
      title: '回写需求',
      acceptanceCriteria: ['金额一致'],
      repoKey: 'z-sales',
      projectKey: 'SALES',
    });
    await deliver(ctx);
    const demandId = demand.demandId.toLowerCase();
    await waitForStage(ctx, demandId, 'requirement_analysis', 'waiting_human');

    // Pending G1 → SAP projection 待确认 (docs/004 §2.1); the artifact metadata
    // travels with the same writeback.
    await waitFor(
      async () => {
        const stored = ctx.fake.demands.get(demand.demandId);
        return stored?.status === '待确认' ? stored : undefined;
      },
      { timeoutMs: 5_000, label: 'SAP status projection 待确认' },
    );
    await waitForOutboxDrained(ctx);
    const firstWritebacks = ctx.fake.writebacks.filter((entry) => entry.status === 200);
    expect(firstWritebacks.length).toBeGreaterThan(0);
    expect(firstWritebacks[0]?.ifMatch).toBe('1');
    const artifactWriteback = firstWritebacks.find((entry) => {
      const carried = entry.patch['artifacts'];
      return Array.isArray(carried) && carried.length > 0;
    });
    expect(artifactWriteback).toBeDefined();
    expect(artifactWriteback?.patch).toMatchObject({ status: '待确认', statusText: '待确认' });
    const artifacts = artifactWriteback?.patch['artifacts'] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(artifacts?.[0]).toMatchObject({
      kind: 'requirement_analysis',
      contentType: 'application/json',
    });
    expect(artifacts?.[0]?.['checksum']).toMatch(/^sha256:[a-f0-9]{64}$/);

    await waitForOutboxDrained(ctx);

    // G1 approval from SAP advances the workflow: dev stage ready → 开发中.
    const detail = await demandDetail(ctx, demandId);
    const artifact = detail.artifacts[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    ctx.fake.enqueueEvent('artifact.approved', demand.demandId, {
      demandId: demand.demandId,
      artifactId: artifact.id,
      stageKey: 'requirement_analysis',
      gateKey: 'G1',
      decidedBy: 'CONSULTANT01',
      decidedAt: new Date().toISOString(),
    });
    await deliver(ctx);
    await waitFor(
      async () => {
        const stored = ctx.fake.demands.get(demand.demandId);
        return stored?.status === '开发中' ? stored : undefined;
      },
      { timeoutMs: 5_000, label: 'SAP status projection 开发中' },
    );
    await waitForOutboxDrained(ctx);

    // 409: inject one conflict, then trigger a new writeback via a SAP-side
    // field change. The worker re-pulls, replays with a newer If-Match.
    ctx.fake.injectFault({ kind: 'status', status: 409, method: 'PATCH', pathIncludes: '/api/demands/' });
    const stored = ctx.fake.demands.get(demand.demandId);
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    stored.title = '回写需求（SAP 修改）';
    stored.version += 1;
    stored.changedAt = new Date().toISOString();
    ctx.fake.enqueueEvent('demand.updated', demand.demandId, {
      demand: ctx.fake.demandSnapshot(stored),
    });
    await deliver(ctx);

    await waitFor(
      async () => ctx.fake.writebacks.find((entry) => entry.status === 409),
      { timeoutMs: 5_000, label: 'writeback 409' },
    );
    const drained = await waitForOutboxDrained(ctx);
    expect(drained.outbox.dead).toBe(0);
    // The row that conflicts (injected or a natural stale If-Match from a
    // concurrent projection) is re-pulled and replayed with a newer version.
    const conflictIndex = ctx.fake.writebacks.findIndex((entry) => entry.status === 409);
    expect(conflictIndex).toBeGreaterThanOrEqual(0);
    const conflictRow = ctx.fake.writebacks[conflictIndex];
    const replay = ctx.fake.writebacks
      .slice(conflictIndex + 1)
      .find((entry) => entry.status === 200 && Number(entry.ifMatch) > Number(conflictRow?.ifMatch));
    expect(replay).toBeDefined();
    expect(ctx.fake.writebacks.some((entry) => entry.status === 200 && entry.patch.status === '开发中')).toBe(
      true,
    );
    const sapDemand = ctx.fake.demands.get(demand.demandId);
    expect(sapDemand?.status).toBe('开发中');
  });
  it('retries 5xx with exponential backoff and dead-letters after maxAttempts (docs/009 #11)', async () => {
    const ctx = await bootSap({
      aiProvider: new FakeModelProvider({ responses: ['not-json', 'not-json'] }),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      ctx.fake.injectFault({ kind: 'status', status: 500, method: 'PATCH', pathIncludes: '/api/demands/' });
    }
    const { demand } = ctx.fake.createDemandFromUi({ title: '重试需求' });
    await deliver(ctx);
    const drained = await waitForOutboxDrained(ctx);
    await waitFor(async () => ((await outboxStatus(ctx)).outbox.dead > 0 ? true : undefined), {
      timeoutMs: 5_000,
      label: 'dead letter',
    });
    const status = await outboxStatus(ctx);
    expect(status.outbox.dead).toBeGreaterThan(0);
    expect(status.outbox.sent).toBe(0);
    expect(status.outbox.lastError).toContain('500');
    expect(drained.outbox.pending).toBe(0);
    const patchAttempts = ctx.fake.requests.filter((request) => request.method === 'PATCH');
    expect(patchAttempts).toHaveLength(3);
    expect(ctx.fake.demands.get(demand.demandId)?.status).toBe('待分析');
    expect(status.outbox.lastError).toContain('500');
  });

  it('dead-letters permanent 4xx failures without retrying (docs/009 #11)', async () => {
    const ctx = await bootSap({
      aiProvider: new FakeModelProvider({ responses: ['not-json', 'not-json'] }),
    });
    ctx.fake.injectFault({ kind: 'status', status: 400, method: 'PATCH', pathIncludes: '/api/demands/' });
    ctx.fake.createDemandFromUi({ title: '永久失败' });
    await deliver(ctx);
    await waitFor(async () => ((await outboxStatus(ctx)).outbox.dead > 0 ? true : undefined), {
      timeoutMs: 5_000,
      label: 'dead letter after 4xx',
    });
    const patchAttempts = ctx.fake.requests.filter((request) => request.method === 'PATCH');
    expect(patchAttempts).toHaveLength(1);
    const status = await outboxStatus(ctx);
    expect(status.outbox.dead).toBeGreaterThan(0);
  });

  it('treats ICF timeouts as retryable but dead-letters at the attempt limit', async () => {
    const ctx = await bootSap({
      aiProvider: new FakeModelProvider({ responses: ['not-json', 'not-json'] }),
      env: { SA_SAP_TIMEOUT_MS: '20', SA_SAP_WRITEBACK_MAX_ATTEMPTS: '1' },
    });
    ctx.fake.injectFault({ kind: 'timeout', method: 'PATCH', pathIncludes: '/api/demands/', delayMs: 150 });
    ctx.fake.createDemandFromUi({ title: '超时需求' });
    await deliver(ctx);
    await waitFor(async () => ((await outboxStatus(ctx)).outbox.dead > 0 ? true : undefined), {
      timeoutMs: 5_000,
      label: 'dead letter after timeout',
    });
    const status = await outboxStatus(ctx);
    expect(status.outbox.lastError).toContain('timed out');
    expect(
      ctx.fake.requests.filter((request) => request.method === 'PATCH'),
    ).toHaveLength(1);
  });
});
