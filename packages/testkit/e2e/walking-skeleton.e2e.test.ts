import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import { issueToken, loadOrCreateStateSecret, startServer, type RunningServer } from '@sap-superagent/server';
import type {
  CreateDemandResponse,
  DemandDetailResponse,
  EventsResponse,
  HeartbeatResponse,
  RegisterExecutorResponse,
} from '@sap-superagent/protocol';
import {
  FakeExecutor,
  apiRequest,
  createTempStateDir,
  registerExecutor,
  removeTempStateDir,
  resolveTemplatesDir,
  waitFor,
} from '@sap-superagent/testkit';

// ---------------------------------------------------------------------------
// H0 acceptance: M1 local walking skeleton (docs/007 S0).
// Covers docs/009 failure scenarios #1, #2, #3, #10 against the real HTTP API
// with a fake model provider (no network, no SAP, no VSCode).
// ---------------------------------------------------------------------------

const templatesDir = resolveTemplatesDir();

interface TestContext {
  server: RunningServer;
  baseUrl: string;
  stateDir: string;
  secret: string;
  userToken: string;
  adminToken: string;
}

interface BootOverrides {
  stateDir?: string;
  leaseTtlMs?: number;
  presenceTtlMs?: number;
  eventRetentionMs?: number;
}

async function bootServer(overrides: BootOverrides = {}): Promise<TestContext> {
  const stateDir = overrides.stateDir ?? (await createTempStateDir());
  const secret = loadOrCreateStateSecret(stateDir);
  const userToken = issueToken({ kind: 'user', sub: 'e2e-requester', secret, ttlMs: 3_600_000 });
  const adminToken = issueToken({ kind: 'admin', sub: 'e2e-admin', secret, ttlMs: 3_600_000 });
  const server = await startServer({
    stateDir,
    templatesDir,
    port: 0,
    aiProvider: new FakeModelProvider(),
    leaseTtlMs: overrides.leaseTtlMs ?? 1_500,
    presenceTtlMs: overrides.presenceTtlMs ?? 60_000,
    heartbeatSweepMs: 25,
    stagePollMs: 25,
    logger: false,
    version: 'e2e',
    ...(overrides.eventRetentionMs === undefined
      ? {}
      : { eventRetentionMs: overrides.eventRetentionMs }),
  });
  return { server, baseUrl: server.url, stateDir, secret, userToken, adminToken };
}

async function createDemand(
  ctx: TestContext,
  overrides: Partial<{ title: string; description: string }> = {},
): Promise<CreateDemandResponse> {
  const response = await apiRequest<CreateDemandResponse>(ctx.baseUrl, '/api/v1/demands', {
    method: 'POST',
    token: ctx.userToken,
    body: {
      title: overrides.title ?? 'R-2041 取数逻辑',
      description: overrides.description ?? '按销售组织汇总开票金额，输出 ALV 列表',
      acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
      priority: 'normal',
      requester: { userId: 'REQ001', orgUnit: 'PDO' },
    },
  });
  expect([200, 201]).toContain(response.status);
  return response.body;
}

async function waitForDemandArtifact(ctx: TestContext, demandId: string): Promise<DemandDetailResponse> {
  return waitFor(
    async () => {
      const response = await apiRequest<DemandDetailResponse>(
        ctx.baseUrl,
        `/api/v1/demands/${demandId}`,
        { token: ctx.userToken },
      );
      if (response.status !== 200) return undefined;
      const firstStageDone = response.body.stages[0]?.status === 'done';
      return response.body.artifacts.length > 0 && firstStageDone ? response.body : undefined;
    },
    { timeoutMs: 8_000, label: 'requirement_analysis artifact' },
  );
}

interface AdminTaskInput {
  demandId: string;
  stageRunId?: string;
  title: string;
  requiredRoles?: string[];
  workspaceBinding?: { repo: string; projectKey?: string; baseBranch?: string } | null;
}

async function createDevTask(
  ctx: TestContext,
  input: AdminTaskInput,
): Promise<{ id: string }> {
  const response = await apiRequest<{ task: { id: string } }>(ctx.baseUrl, '/api/v1/admin/tasks', {
    method: 'POST',
    token: ctx.adminToken,
    body: {
      demandId: input.demandId,
      title: input.title,
      executorKind: 'vscode',
      requiredRoles: input.requiredRoles ?? ['developer'],
      workspaceBinding: input.workspaceBinding ?? { repo: 'z-sales' },
      ...(input.stageRunId === undefined ? {} : { stageRunId: input.stageRunId }),
    },
  });
  expect([200, 201]).toContain(response.status);
  return response.body.task;
}

async function createVscodeExecutor(
  ctx: TestContext,
  options: { user: string; workspaceKey?: string },
): Promise<FakeExecutor> {
  const workspaceKey = options.workspaceKey ?? 'wk-z-sales';
  const registration: RegisterExecutorResponse = await registerExecutor(ctx.baseUrl, ctx.userToken, {
    kind: 'vscode',
    user: options.user,
    protocolVersion: '1.0.0',
    capabilities: ['coding'],
    roles: ['developer'],
    workspaces: [
      { workspaceKey, repo: 'z-sales', projectKey: 'SALES', baseBranch: 'main' },
    ],
    maxConcurrent: 2,
  });
  const executor = new FakeExecutor({
    baseUrl: ctx.baseUrl,
    executorToken: registration.executorToken,
    executorId: registration.executor.id,
    user: options.user,
  });
  const heartbeat: HeartbeatResponse = await executor.heartbeatOk({
    status: 'online',
    load: 0,
    activeWorkspaceKey: workspaceKey,
  });
  expect(heartbeat.serverTime).toBeTruthy();
  return executor;
}

async function getEvents(ctx: TestContext, after: number, limit = 500): Promise<EventsResponse> {
  const response = await apiRequest<EventsResponse>(
    ctx.baseUrl,
    `/api/v1/events?after=${after}&limit=${limit}`,
    { token: ctx.adminToken },
  );
  expect(response.status).toBe(200);
  return response.body;
}

describe('H0 walking skeleton e2e (M1 local mode, fake AI)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootServer();
  });

  afterAll(async () => {
    await ctx.server.close();
    await removeTempStateDir(ctx.stateDir);
  });

  it('demand → AI artifact → manual dev task → claim → artifact → complete, with a full event timeline', async () => {
    const created = await createDemand(ctx);
    expect(created.demand.status).toBe('submitted');
    expect(created.stages.map((stage) => stage.stageKey)).toEqual([
      'requirement_analysis',
      'dev_implementation',
    ]);
    expect(created.stages[0]?.status).toBe('ready');

    const detail = await waitForDemandArtifact(ctx, created.demand.id);
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.artifacts[0]?.kind).toBe('requirement_analysis');
    const version = detail.artifactVersions[0];
    expect(version?.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(version?.authorType).toBe('ai');
    expect(detail.stages[0]?.status).toBe('done');
    expect(detail.stages[1]?.status).toBe('ready');

    const devStageRun = created.stages[1];
    const task = await createDevTask(ctx, {
      demandId: created.demand.id,
      title: '实现取数逻辑',
      ...(devStageRun === undefined ? {} : { stageRunId: devStageRun.id }),
      workspaceBinding: { repo: 'z-sales', projectKey: 'SALES', baseBranch: 'main' },
    });

    const alice = await createVscodeExecutor(ctx, { user: 'DEV001' });
    const bob = await createVscodeExecutor(ctx, { user: 'DEV002' });

    // The task is visible in the claimable pool (bound workspace is open).
    const listed = await alice.listTasks();
    expect(listed.status).toBe(200);
    const offered = listed.body.tasks.map((entry) => entry.id);
    expect(offered).toContain(task.id);

    // Context pack (markdown + JSON) is fetchable before and after claim.
    const context = await alice.getContext(task.id);
    expect(context.status).toBe(200);
    expect(context.body.markdown).toContain('实现取数逻辑');
    expect(context.body.markdown).toContain('## 验收标准');
    expect(context.body.json.demand.id).toBe(created.demand.id);

    const claim = await alice.claimOk(task.id);
    expect(claim.task.state).toBe('claimed');
    expect(claim.lease.expiresAt).toBeTruthy();
    expect(claim.contextUrl).toContain(`/tasks/${task.id}/context`);

    // docs/009 #1: the second executor must not get the same task.
    const doubleClaim = await bob.claim(task.id);
    expect(doubleClaim.status).toBe(409);

    const artifact = await alice.submitArtifact(task.id, {
      kind: 'code_change',
      content: 'diff --git a/zsales_aggregate.prog.abap b/zsales_aggregate.prog.abap\n+SELECT ...',
      summary: 'ABAP 取数实现',
    });
    expect(artifact.status).toBe(200);
    expect(artifact.body.version.version).toBe(1);
    expect(artifact.body.version.checksum).toMatch(/^sha256:/);

    const progress = await alice.progress(task.id, { percent: 100, message: '实现完成，已自测' });
    expect([200, 201, 204]).toContain(progress.status);

    const completed = await alice.complete(task.id, {
      summary: '已实现并自测：金额与 MARA 一致',
      artifactIds: [artifact.body.artifact.id],
      links: ['https://example.invalid/merge-request/1'],
      openQuestions: [],
    });
    expect(completed.status).toBe(200);
    expect(completed.body.task.state).toBe('completed');

    const taskAfter = await alice.getTask(task.id);
    expect(taskAfter.status).toBe(200);
    expect(taskAfter.body.task.state).toBe('completed');
    expect(taskAfter.body.artifacts.map((entry) => entry.id)).toContain(
      artifact.body.artifact.id,
    );

    const events = await getEvents(ctx, 0, 1000);
    const types = events.events.map((event) => event.type);
    for (const expected of [
      'demand.created',
      'stage.ready',
      'stage.started',
      'artifact.created',
      'stage.done',
      'task.created',
      'task.claimed',
      'task.completed',
    ]) {
      expect(types, `missing event ${expected}`).toContain(expected);
    }
    const seqs = events.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.lastSeq).toBe(seqs.at(-1));
  });

  it('releases the task back to the pool after the lease expires without duplicate artifacts (failure scenario #2)', async () => {
    const created = await createDemand(ctx, { title: 'R-2042 断网需求' });
    await waitForDemandArtifact(ctx, created.demand.id);
    const task = await createDevTask(ctx, {
      demandId: created.demand.id,
      title: '会断网的任务',
      workspaceBinding: { repo: 'z-sales' },
    });

    const alice = await createVscodeExecutor(ctx, { user: 'DEV011' });
    await alice.claimOk(task.id);
    const before = await alice.getTask(task.id);
    const artifactsBefore = before.body.artifacts.length;

    const pooled = await waitFor(
      async () => {
        const response = await alice.getTask(task.id);
        if (response.status !== 200) return undefined;
        return response.body.task.state === 'pending' ? response.body : undefined;
      },
      { timeoutMs: 8_000, label: 'task back in the pool after lease expiry' },
    );
    expect(pooled.task.lastHolderUserIds).toContain('DEV011');

    // A stale holder must stop writing; the server rejects with 4xx.
    const staleRenew = await alice.renew(task.id);
    expect(staleRenew.status).toBeGreaterThanOrEqual(400);
    const staleArtifact = await alice.submitArtifact(task.id, {
      kind: 'code_change',
      content: 'ghost write',
    });
    expect(staleArtifact.status).toBeGreaterThanOrEqual(400);
    const after = await alice.getTask(task.id);
    expect(after.body.artifacts.length).toBe(artifactsBefore);

    const bob = await createVscodeExecutor(ctx, { user: 'DEV012' });
    const reclaimed = await bob.claimOk(task.id);
    expect(reclaimed.task.state).toBe('claimed');
    const released = await bob.release(task.id);
    expect(released.status).toBe(200);
  });

  it('keeps state and the event cursor across a server restart without duplicate dispatch (failure scenario #3)', async () => {
    const created = await createDemand(ctx, { title: 'R-2043 重启需求' });
    const detail = await waitForDemandArtifact(ctx, created.demand.id);
    const artifactIds = detail.artifacts.map((artifact) => artifact.id);
    const demandId = created.demand.id;

    const beforeEvents = await getEvents(ctx, 0, 1000);
    const lastSeq = beforeEvents.lastSeq;

    await ctx.server.close();
    ctx = await bootServer({ stateDir: ctx.stateDir });

    const health = await apiRequest<{ status: string }>(ctx.baseUrl, '/api/v1/healthz');
    expect(health.status).toBe(200);

    const restored = await apiRequest<DemandDetailResponse>(
      ctx.baseUrl,
      `/api/v1/demands/${demandId}`,
      { token: ctx.userToken },
    );
    expect(restored.status).toBe(200);
    expect(restored.body.artifacts.map((artifact) => artifact.id)).toEqual(artifactIds);

    // Resuming from the last seen sequence must not replay or lose events.
    const replay = await getEvents(ctx, lastSeq, 1000);
    expect(replay.events.every((event) => event.seq > lastSeq)).toBe(true);
    const seen = new Set(beforeEvents.events.map((event) => event.id));
    for (const event of replay.events) {
      expect(seen.has(event.id), `duplicate event ${event.id}`).toBe(false);
      seen.add(event.id);
    }

    // The cursor keeps moving for new work after the restart.
    const next = await createDemand(ctx, { title: 'R-2044 重启后需求' });
    expect(next.demand.id).not.toBe(demandId);
    const afterNew = await getEvents(ctx, lastSeq, 1000);
    expect(afterNew.events.length).toBeGreaterThan(0);
    expect(afterNew.events.every((event) => event.seq > lastSeq)).toBe(true);
    expect(afterNew.lastSeq).toBeGreaterThan(lastSeq);
  });

  it('returns resync_required when the event cursor fell out of the retention window (failure scenario #10)', async () => {
    const resyncCtx = await bootServer({ eventRetentionMs: 50, presenceTtlMs: 60_000 });
    try {
      const created = await createDemand(resyncCtx, { title: 'R-2045 游标需求' });
      await waitForDemandArtifact(resyncCtx, created.demand.id);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Appending a new event also prunes everything older than 50ms.
      const registration = await apiRequest<RegisterExecutorResponse>(
        resyncCtx.baseUrl,
        '/api/v1/executors/register',
        {
          method: 'POST',
          token: resyncCtx.userToken,
          body: { kind: 'vscode', user: 'DEV099', protocolVersion: '1.0.0' },
        },
      );
      expect(registration.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const expiredCursor = await apiRequest<{
        error: { code: string; details?: { earliestSeq?: number; lastSeq?: number } };
      }>(resyncCtx.baseUrl, '/api/v1/events?after=0', { token: resyncCtx.adminToken });
      expect(expiredCursor.status).toBe(409);
      expect(expiredCursor.body.error.code).toBe('resync_required');

      // A cursor inside the retained window still replays normally.
      const lastSeq = expiredCursor.body.error.details?.lastSeq ?? 0;
      const tail = await apiRequest<EventsResponse>(
        resyncCtx.baseUrl,
        `/api/v1/events?after=${lastSeq}`,
        { token: resyncCtx.adminToken },
      );
      expect(tail.status).toBe(200);
    } finally {
      await resyncCtx.server.close();
      await removeTempStateDir(resyncCtx.stateDir);
    }
  });
});
