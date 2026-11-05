import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import {
  issueToken,
  loadOrCreateStateSecret,
  startServer,
  type RunningServer,
} from '@sap-superagent/server';
import type {
  CreateDemandResponse,
  DemandDetailResponse,
  RegisterExecutorResponse,
  StageRun,
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
// H1 acceptance e2e (task book §2): gate approval pass/reject/timeout and stale
// blocking against a real local control-plane process (temp state dir, fake AI,
// fake executor; no network). Includes the three manual smoke scenarios.
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
  gateTimeoutMs?: number;
}

async function bootServer(overrides: BootOverrides = {}): Promise<TestContext> {
  const stateDir = overrides.stateDir ?? (await createTempStateDir());
  const secret = loadOrCreateStateSecret(stateDir);
  const userToken = issueToken({ kind: 'user', sub: 'e2e-approver', secret, ttlMs: 3_600_000 });
  const adminToken = issueToken({ kind: 'admin', sub: 'e2e-admin', secret, ttlMs: 3_600_000 });
  const server = await startServer({
    stateDir,
    templatesDir,
    port: 0,
    aiProvider: new FakeModelProvider(),
    leaseTtlMs: 2_000,
    presenceTtlMs: 60_000,
    heartbeatSweepMs: 20,
    stagePollMs: 20,
    logger: false,
    version: 'e2e',
    ...(overrides.gateTimeoutMs === undefined ? {} : { gateTimeoutMs: overrides.gateTimeoutMs }),
  });
  return { server, baseUrl: server.url, stateDir, secret, userToken, adminToken };
}

async function getDemand(ctx: TestContext, demandId: string): Promise<DemandDetailResponse> {
  const response = await apiRequest<DemandDetailResponse>(
    ctx.baseUrl,
    `/api/v1/demands/${demandId}`,
    { token: ctx.userToken },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function createDemand(
  ctx: TestContext,
  overrides: Partial<{ title: string; acceptanceCriteria: string[] }> = {},
): Promise<CreateDemandResponse> {
  const response = await apiRequest<CreateDemandResponse>(ctx.baseUrl, '/api/v1/demands', {
    method: 'POST',
    token: ctx.userToken,
    body: {
      title: overrides.title ?? 'R-4001 默认模板需求',
      description: '按销售组织汇总开票金额，空结果返回 0',
      acceptanceCriteria: overrides.acceptanceCriteria ?? ['金额与 MARA 一致', '空结果返回 0'],
      priority: 'normal',
      requester: { userId: 'REQ001', orgUnit: 'PDO' },
    },
  });
  expect(response.status).toBe(200);
  return response.body;
}

async function waitForGate(
  ctx: TestContext,
  demandId: string,
  gateKey: string,
): Promise<DemandDetailResponse['approvals'][number]> {
  return waitFor(
    async () => {
      const detail = await getDemand(ctx, demandId);
      return detail.approvals.find(
        (approval) => approval.gateKey === gateKey && approval.state === 'pending',
      );
    },
    { timeoutMs: 8_000, label: `pending gate ${gateKey}` },
  );
}

async function decideGate(
  ctx: TestContext,
  approvalId: string,
  decision: 'approve' | 'reject',
  comment?: string,
) {
  return apiRequest<{ approval: { state: string; decision: string } }>(
    ctx.baseUrl,
    `/api/v1/approvals/${approvalId}/decisions`,
    {
      method: 'POST',
      token: ctx.userToken,
      body: { decision, ...(comment === undefined ? {} : { comment }) },
    },
  );
}

async function waitForTask(ctx: TestContext, stageRunId: string): Promise<string> {
  return waitFor(
    async () => {
      const response = await apiRequest<{
        tasks: Array<{ id: string; stageRunId: string | null; state: string }>;
      }>(ctx.baseUrl, '/api/v1/tasks', { token: ctx.adminToken });
      const task = response.body.tasks.find(
        (candidate) => candidate.stageRunId === stageRunId && candidate.state === 'pending',
      );
      return task?.id;
    },
    { timeoutMs: 8_000, label: 'template-generated task' },
  );
}

async function createExecutor(ctx: TestContext, user: string): Promise<FakeExecutor> {
  const registration: RegisterExecutorResponse = await registerExecutor(
    ctx.baseUrl,
    ctx.userToken,
    {
      kind: 'vscode',
      user,
      protocolVersion: '1.0.0',
      capabilities: ['coding'],
      roles: ['developer'],
      workspaces: [{ workspaceKey: 'wk-z-sales', repo: 'z-sales', projectKey: 'SALES', baseBranch: 'main' }],
      maxConcurrent: 2,
    },
  );
  const executor = new FakeExecutor({
    baseUrl: ctx.baseUrl,
    executorToken: registration.executorToken,
    executorId: registration.executor.id,
    user,
  });
  await executor.heartbeatOk({ status: 'online', load: 0, activeWorkspaceKey: 'wk-z-sales' });
  return executor;
}

async function reachDevGate(ctx: TestContext, demandId: string): Promise<FakeExecutor> {
  const detail = await getDemand(ctx, demandId);
  const devStage = detail.stages.find((stage) => stage.stageKey === 'dev_implementation');
  expect(devStage).toBeDefined();
  const taskId = await waitForTask(ctx, devStage!.id);
  const executor = await createExecutor(ctx, 'DEV401');
  const claim = await executor.claimOk(taskId);
  expect(claim.task.state).toBe('claimed');
  const artifact = await executor.submitArtifact(taskId, {
    kind: 'code_change',
    content: 'diff --git a/zsales.prog.abap b/zsales.prog.abap\n+SELECT * FROM mara',
    summary: 'ABAP 取数实现',
  });
  const completed = await executor.complete(taskId, {
    summary: '实现并自测完成',
    artifactIds: [artifact.body.artifact.id],
    links: [],
    openQuestions: [],
  });
  expect(completed.status).toBe(200);
  return executor;
}

describe('H1 gate e2e (M1 local mode, fake AI)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootServer();
  });

  afterAll(async () => {
    await ctx.server.close();
    await removeTempStateDir(ctx.stateDir);
  });

  it('approves G1 -> G3 -> G4 and drives a demand to done (smoke #1: approve path)', async () => {
    const created = await createDemand(ctx);
    expect(created.stages.map((stage) => stage.stageKey)).toEqual([
      'requirement_analysis',
      'dev_implementation',
      'acceptance_archive',
    ]);

    // Stage 1 stops at G1.
    const g1 = await waitForGate(ctx, created.demand.id, 'G1');
    expect(g1.requiredRole).toBe('consultant');
    const approved = await decideGate(ctx, g1.id, 'approve', '分析确认 ✅');
    expect(approved.body.approval.state).toBe('approved');

    // G1 approval materialises the development task, which the executor completes.
    const devStage = await waitFor(
      async () => {
        const detail = await getDemand(ctx, created.demand.id);
        const stage = detail.stages.find((candidate) => candidate.stageKey === 'dev_implementation');
        return stage?.status === 'ready' ? stage : undefined;
      },
      { timeoutMs: 8_000, label: 'dev stage ready' },
    );
    const executor = await reachDevGate(ctx, created.demand.id);
    const g3 = await waitForGate(ctx, created.demand.id, 'G3');
    expect(g3.artifactId).toBeTruthy();
    expect((await decideGate(ctx, g3.id, 'approve')).body.approval.state).toBe('approved');

    // Stage 3 generates the archive and G4 finishes the demand.
    const g4 = await waitForGate(ctx, created.demand.id, 'G4');
    expect((await decideGate(ctx, g4.id, 'approve')).body.approval.state).toBe('approved');

    const done = await waitFor(
      async () => {
        const detail = await getDemand(ctx, created.demand.id);
        return detail.demand.status === 'done' ? detail : undefined;
      },
      { timeoutMs: 8_000, label: 'demand done' },
    );
    expect(done.stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done']);
    expect(done.artifacts.map((artifact) => artifact.state)).toEqual([
      'approved',
      'approved',
      'approved',
    ]);
    const types = done.events.map((event) => event.type);
    for (const expected of ['approval.requested', 'approval.decided', 'stage.done', 'demand.updated']) {
      expect(types, `missing event ${expected}`).toContain(expected);
    }
    await executor.unregister();
  });

  it('rejects G1 and re-runs the stage as a new attempt with artifact v2 (smoke #1: reject path)', async () => {
    const created = await createDemand(ctx, { title: 'R-4002 驳回需求' });
    const g1 = await waitForGate(ctx, created.demand.id, 'G1');
    const rejected = await decideGate(ctx, g1.id, 'reject', '范围不清，请补充');
    expect(rejected.body.approval).toMatchObject({ state: 'rejected', decision: 'reject' });

    const retried = await waitFor(
      async () => {
        const detail = await getDemand(ctx, created.demand.id);
        const stage = detail.stages.find((candidate) => candidate.stageKey === 'requirement_analysis');
        const pending = detail.approvals.filter(
          (approval) => approval.gateKey === 'G1' && approval.state === 'pending',
        );
        return stage?.attempt === 2 && pending.length === 1 ? detail : undefined;
      },
      { timeoutMs: 8_000, label: 'stage retried after rejection' },
    );
    const artifact = retried.artifacts.find((entry) => entry.kind === 'requirement_analysis');
    expect(artifact?.currentVersion).toBe(2);
    const versions = retried.artifactVersions.filter(
      (version) => version.artifactId === artifact?.id,
    );
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(retried.events.map((event) => event.type)).toContain('artifact.rejected');

    const pending = retried.approvals.find((approval) => approval.state === 'pending');
    const approved = await decideGate(ctx, pending!.id, 'approve');
    expect(approved.body.approval.state).toBe('approved');
  });

  it('expires the gate by timeout and keeps the stage moving (#14 / smoke: timeout)', async () => {
    // Tiny gate timeout so the real timeout sweeper path is exercised.
    const timedCtx = await bootServer({ gateTimeoutMs: 80 });
    try {
      const created = await createDemand(timedCtx, { title: 'R-4003 超时需求' });
      const first = await waitForGate(timedCtx, created.demand.id, 'G1');
      expect(first.expiresAt).toBeTruthy();

      const paused = await waitFor(
        async () => {
          const detail = await getDemand(timedCtx, created.demand.id);
          const expired = detail.approvals.filter((approval) => approval.state === 'expired');
          const stage = detail.stages.find((candidate) => candidate.stageKey === 'requirement_analysis');
          return expired.length >= 2 && stage?.status === 'waiting_human' && stage.attempt === 2
            ? detail
            : undefined;
        },
        { timeoutMs: 10_000, label: 'timeout-expired gates and parked stage' },
      );
      const types = paused.events.map((event) => event.type);
      expect(types).toContain('approval.expired');
      expect(types).toContain('stage.waiting_human');

      // A stale/expired approval can no longer be decided.
      const blocked = await decideGate(timedCtx, first.id, 'approve');
      expect(blocked.status).toBe(409);
    } finally {
      await timedCtx.server.close();
      await removeTempStateDir(timedCtx.stateDir);
    }
  });

  it('marks the dev artifact stale and blocks G3 when requirement analysis is revised (smoke #3: stale)', async () => {
    const created = await createDemand(ctx, { title: 'R-4004 stale 需求' });
    const g1 = await waitForGate(ctx, created.demand.id, 'G1');
    await decideGate(ctx, g1.id, 'approve');
    await waitFor(
      async () => {
        const detail = await getDemand(ctx, created.demand.id);
        const stage = detail.stages.find((candidate) => candidate.stageKey === 'dev_implementation');
        return stage?.status === 'ready' ? stage : undefined;
      },
      { timeoutMs: 8_000, label: 'dev stage ready' },
    );
    await reachDevGate(ctx, created.demand.id);
    const g3 = await waitForGate(ctx, created.demand.id, 'G3');

    // Human confirmation of the requirement analysis creates v2 -> dev artifact stale.
    const analysisContent = JSON.stringify({
      summary: '需求分析（人工确认版）',
      goals: ['汇总开票金额'],
      scope: { inScope: ['汇总'], outOfScope: [] },
      assumptions: [],
      openQuestions: [],
      acceptanceCriteria: [
        { criterion: '金额与 MARA 一致', anchor: '金额与 MARA 一致' },
        { criterion: '空结果返回 0', anchor: '空结果返回 0' },
      ],
      risks: [],
    });
    const checksum = `sha256:${createHash('sha256').update(Buffer.from(analysisContent, 'utf8')).digest('hex')}`;
    const revision = await apiRequest<{ version: { version: number } }>(
      ctx.baseUrl,
      `/api/v1/demands/${created.demand.id}/artifacts`,
      {
        method: 'POST',
        token: ctx.userToken,
        body: {
          kind: 'requirement_analysis',
          contentType: 'application/json',
          contentBase64: Buffer.from(analysisContent, 'utf8').toString('base64'),
          checksum,
          summary: '人工确认需求分析',
        },
      },
    );
    expect(revision.body.version.version).toBe(2);

    const stale = await waitFor(
      async () => {
        const detail = await getDemand(ctx, created.demand.id);
        const staleVersions = detail.artifactVersions.filter((version) => version.stale);
        return staleVersions.length > 0 ? detail : undefined;
      },
      { timeoutMs: 8_000, label: 'stale downstream artifact' },
    );
    const blocked = await decideGate(ctx, g3.id, 'approve');
    expect(blocked.status).toBe(409);
    expect(
      (blocked.body as unknown as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe('artifact_stale');
    expect(stale.events.map((event) => event.type)).toContain('artifact.stale');
  });
});
