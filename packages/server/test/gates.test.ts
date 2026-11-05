import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import {
  api,
  createDemand,
  decideApproval,
  getDemandDetail,
  heartbeat,
  listApprovals,
  registerExecutor,
  startTestServer,
  waitFor,
  waitForStageStatus,
  type DemandDetailLike,
  type TestServer,
} from './helpers.js';

// ---------------------------------------------------------------------------
// H1 gate runtime (task book §1.2–§1.5, docs/003 §2.2/§2.4/§2.5/§2.7).
// Covers docs/009 #13 (upstream new version -> stale + blocked gate),
// #14 (approval timeout/withdraw; stage never gets stuck) and #15 (AI output
// that fails schema/checklist never persists a half-baked artifact).
// ---------------------------------------------------------------------------

function checksumOf(content: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
}

async function waitForPendingApproval(
  server: TestServer,
  demandId: string,
  gateKey: string,
): Promise<DemandDetailLike['approvals'][number]> {
  return waitFor(
    async () => {
      const detail = await getDemandDetail(server, demandId);
      if (detail.status !== 200) return undefined;
      return detail.body.approvals.find(
        (approval) => approval.gateKey === gateKey && approval.state === 'pending',
      );
    },
    { label: `pending approval ${gateKey}`, timeoutMs: 8_000 },
  );
}

async function registerDeveloper(server: TestServer, user = 'DEV001') {
  const executor = await registerExecutor(server, user, { roles: ['developer'] });
  const beat = await heartbeat(server, executor);
  expect(beat.status).toBe(200);
  return executor;
}

async function claimTask(server: TestServer, executor: { token: string }, taskId: string) {
  const claim = await api<{ task: { state: string } }>(server, `/api/v1/tasks/${taskId}/claim`, {
    method: 'POST',
    token: executor.token,
    body: {},
  });
  expect(claim.status).toBe(200);
  return claim;
}

async function submitCodeChange(
  server: TestServer,
  executor: { token: string },
  taskId: string,
  content = 'diff --git a/z.prog.abap b/z.prog.abap\n+SELECT * FROM mara',
) {
  const response = await api<{
    artifact: { id: string; currentVersion?: number };
    version: { version: number };
  }>(server, `/api/v1/tasks/${taskId}/artifacts`, {
    method: 'POST',
    token: executor.token,
    body: {
      kind: 'code_change',
      contentType: 'text/plain',
      contentBase64: Buffer.from(content, 'utf8').toString('base64'),
      checksum: checksumOf(content),
      summary: 'ABAP 取数实现',
    },
  });
  expect(response.status).toBe(200);
  return response.body;
}

async function completeTask(
  server: TestServer,
  executor: { token: string },
  taskId: string,
  artifactIds: string[],
) {
  const response = await api<{ task: { state: string } }>(
    server,
    `/api/v1/tasks/${taskId}/complete`,
    {
      method: 'POST',
      token: executor.token,
      body: { summary: '实现并自测完成', artifactIds, links: [], openQuestions: [] },
    },
  );
  expect(response.status).toBe(200);
  return response;
}

describe('approval gate runtime (H1 §1.2–§1.5)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.dispose();
  });

  it('runs the default 3-stage template with G1 -> G3 -> G4 and template-generated tasks', async () => {
    const created = await createDemand(server);
    expect(created.templateId).toBe('default');
    expect(created.stages).toEqual([
      'requirement_analysis',
      'dev_implementation',
      'acceptance_archive',
    ]);

    // Stage 1: AI artifact is generated, then the gate parks the stage.
    const woken = await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    expect(woken.artifacts).toHaveLength(1);
    expect(woken.artifacts[0]).toMatchObject({ kind: 'requirement_analysis', state: 'in_review' });
    const g1 = await waitForPendingApproval(server, created.id, 'G1');
    expect(g1).toMatchObject({ requiredRole: 'consultant', artifactVersion: 1 });
    expect(g1.artifactId).toBe(woken.artifacts[0]?.id);
    expect(g1.expiresAt).toBeTruthy();

    // Notification for the gate is recorded and readable through the API.
    const unread = await api<{ notifications: Array<{ kind: string; approvalId: string | null }> }>(
      server,
      '/api/v1/notifications?state=unread',
      { token: server.userToken },
    );
    expect(unread.status).toBe(200);
    const requested = unread.body.notifications.find((entry) => entry.approvalId === g1.id);
    expect(requested?.kind).toBe('approval.requested');

    // Approve G1: stage done, next stage ready and the vscode task appears.
    const approved = await decideApproval(server, g1.id, 'approve', '需求分析确认 ✅');
    expect(approved.status).toBe(200);
    expect(approved.body.approval).toMatchObject({ state: 'approved', decision: 'approve' });

    const devReady = await waitForStageStatus(server, created.id, 'dev_implementation', 'ready');
    const devStage = devReady.stages.find((stage) => stage.stageKey === 'dev_implementation');
    const tasks = await api<{ tasks: Array<{ id: string; stageRunId: string | null; requiredRoles: string[]; state: string }> }>(
      server,
      '/api/v1/tasks',
      { token: server.adminToken },
    );
    const devTask = tasks.body.tasks.find((task) => task.stageRunId === devStage?.id);
    expect(devTask).toBeDefined();
    expect(devTask?.requiredRoles).toEqual(['developer']);

    // Execute the vscode stage: claim -> artifact -> complete -> G3.
    const executor = await registerDeveloper(server);
    await claimTask(server, executor, devTask!.id);
    const running = await getDemandDetail(server, created.id);
    expect(running.body.stages.find((s) => s.stageKey === 'dev_implementation')?.status).toBe('running');
    const submitted = await submitCodeChange(server, executor, devTask!.id);
    await completeTask(server, executor, devTask!.id, [submitted.artifact.id]);

    await waitForStageStatus(server, created.id, 'dev_implementation', 'waiting_human');
    const g3 = await waitForPendingApproval(server, created.id, 'G3');
    expect(g3.artifactId).toBe(submitted.artifact.id);
    await decideApproval(server, g3.id, 'approve');

    // Stage 3: acceptance archive (AI) then G4, which completes the demand.
    await waitForStageStatus(server, created.id, 'acceptance_archive', 'waiting_human');
    const g4 = await waitForPendingApproval(server, created.id, 'G4');
    expect(g4.requiredRole).toBe('requester');
    const finalApproved = await decideApproval(server, g4.id, 'approve');
    expect(finalApproved.status).toBe(200);

    const finished = await waitFor(
      async () => {
        const detail = await getDemandDetail(server, created.id);
        return detail.body.demand.status === 'done' ? detail.body : undefined;
      },
      { label: 'demand done after G4', timeoutMs: 8_000 },
    );
    expect(finished.stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done']);
    expect(finished.artifacts.map((artifact) => artifact.state)).toEqual([
      'approved',
      'approved',
      'approved',
    ]);
    expect(finished.artifactChains).toHaveLength(3);
    const types = finished.events.map((event) => event.type);
    for (const expected of [
      'approval.requested',
      'approval.decided',
      'stage.done',
      'demand.updated',
    ]) {
      expect(types, `missing ${expected}`).toContain(expected);
    }
  });

  it('rejecting a gate starts a new attempt with a new artifact version instead of overwriting', async () => {
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const g1 = await waitForPendingApproval(server, created.id, 'G1');

    const rejected = await decideApproval(server, g1.id, 'reject', '范围不清，请补充');
    expect(rejected.body.approval).toMatchObject({ state: 'rejected', decision: 'reject' });

    // The retry produces version 2 on the same artifact id and a fresh gate.
    const retried = await waitFor(
      async () => {
        const detail = await getDemandDetail(server, created.id);
        const stage = detail.body.stages.find((s) => s.stageKey === 'requirement_analysis');
        const pending = detail.body.approvals.filter(
          (approval) => approval.gateKey === 'G1' && approval.state === 'pending',
        );
        return stage?.status === 'waiting_human' && stage.attempt === 2 && pending.length === 1
          ? detail.body
          : undefined;
      },
      { label: 'stage retried after rejection', timeoutMs: 8_000 },
    );
    const artifact = retried.artifacts.find((entry) => entry.kind === 'requirement_analysis');
    expect(artifact?.currentVersion).toBe(2);
    const versions = retried.artifactVersions.filter(
      (version) => version.artifactId === artifact?.id,
    );
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions.filter((version) => version.version === 1)).toHaveLength(1);
    expect(retried.approvals.filter((approval) => approval.state === 'rejected')).toHaveLength(1);
    const types = retried.events.map((event) => event.type);
    expect(types).toContain('artifact.rejected');
    expect(types).toContain('stage.failed');
    expect(types).toContain('stage.ready');
    expect(types).toContain('artifact.created');

    // Approving the new attempt moves the demand on.
    const pending = retried.approvals.find((approval) => approval.state === 'pending');
    const approved = await decideApproval(server, pending!.id, 'approve');
    expect(approved.status).toBe(200);
    await waitForStageStatus(server, created.id, 'dev_implementation', 'ready');
  });

  it('rejects decisions on terminal approvals with 409 (idempotent read)', async () => {
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const g1 = await waitForPendingApproval(server, created.id, 'G1');
    await decideApproval(server, g1.id, 'approve');

    const again = await decideApproval(server, g1.id, 'approve');
    expect(again.status).toBe(409);
    expect((again.body as unknown as { error: { code: string; details: { approvalState: string } } }).error).toMatchObject({
      code: 'conflict',
      details: { approvalState: 'approved' },
    });
    const conflicting = await decideApproval(server, g1.id, 'reject');
    expect(conflicting.status).toBe(409);
  });

  it('withdrawing a pending gate retries the stage and keeps the artifacts immutable', async () => {
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const g1 = await waitForPendingApproval(server, created.id, 'G1');

    const withdrawn = await api<{ approval: { state: string; comment: string | null } }>(
      server,
      `/api/v1/approvals/${g1.id}/withdraw`,
      { method: 'POST', token: server.userToken },
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.approval.state).toBe('withdrawn');

    const retried = await waitFor(
      async () => {
        const detail = await getDemandDetail(server, created.id);
        const stage = detail.body.stages.find((s) => s.stageKey === 'requirement_analysis');
        return stage?.attempt === 2 && stage.status === 'waiting_human' ? detail.body : undefined;
      },
      { label: 'stage retried after withdrawal', timeoutMs: 8_000 },
    );
    expect(retried.events.map((event) => event.type)).toContain('approval.withdrawn');
    expect(retried.artifacts[0]?.currentVersion).toBe(2);
  });

  it('expires a gate through the M1 admin escalation without leaving the stage stuck (#14)', async () => {
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const g1 = await waitForPendingApproval(server, created.id, 'G1');

    const expired = await api<{ approval: { state: string } }>(
      server,
      `/api/v1/admin/approvals/${g1.id}/expire`,
      { method: 'POST', token: server.adminToken },
    );
    expect(expired.status).toBe(200);
    expect(expired.body.approval.state).toBe('expired');

    // Idempotent on a non-pending approval.
    const again = await api<{ approval: { state: string } }>(
      server,
      `/api/v1/admin/approvals/${g1.id}/expire`,
      { method: 'POST', token: server.adminToken },
    );
    expect(again.status).toBe(200);
    expect(again.body.approval.state).toBe('expired');

    const retried = await waitFor(
      async () => {
        const detail = await getDemandDetail(server, created.id);
        const stage = detail.body.stages.find((s) => s.stageKey === 'requirement_analysis');
        const pending = detail.body.approvals.filter(
          (approval) => approval.gateKey === 'G1' && approval.state === 'pending',
        );
        return stage?.attempt === 2 && pending.length === 1 ? detail.body : undefined;
      },
      { label: 'stage retried after gate expiry', timeoutMs: 8_000 },
    );
    expect(retried.events.map((event) => event.type)).toContain('approval.expired');
    const notifications = await api<{ notifications: Array<{ kind: string }> }>(
      server,
      '/api/v1/notifications?state=all',
      { token: server.userToken },
    );
    expect(notifications.body.notifications.map((entry) => entry.kind)).toContain('approval.expired');
  });

  it('expires a gate from the timeout sweeper when the gate timeout passes (#14)', async () => {
    // M1 ops/test override: every gate expires 60ms after creation; the sweeper
    // (20ms) must expire it and re-queue the stage instead of hanging forever.
    const timed = await startTestServer({
      overrides: { gateTimeoutMs: 60, heartbeatSweepMs: 20, stagePollMs: 20 },
    });
    try {
      const created = await createDemand(timed);
      await waitForStageStatus(timed, created.id, 'requirement_analysis', 'waiting_human');
      const g1 = await waitForPendingApproval(timed, created.id, 'G1');
      expect(g1.expiresAt).toBeTruthy();

      const expiredDetail = await waitFor(
        async () => {
          const detail = await getDemandDetail(timed, created.id);
          const expired = detail.body.approvals.filter((approval) => approval.state === 'expired');
          const stage = detail.body.stages.find((s) => s.stageKey === 'requirement_analysis');
          // Attempt 1 expires, the retry runs and its gate expires too -> the
          // stage parks for a human at maxAttempts instead of staying ready.
          return expired.length >= 2 && stage?.status === 'waiting_human' && stage.attempt === 2
            ? detail.body
            : undefined;
        },
        { label: 'sweeper-expired gates with a parked stage', timeoutMs: 10_000 },
      );
      const types = expiredDetail.events.map((event) => event.type);
      expect(types).toContain('approval.expired');
      expect(types).toContain('stage.failed');
      expect(types).toContain('stage.waiting_human');

      // A decided/expired gate can no longer be approved.
      const blocked = await decideApproval(timed, g1.id, 'approve');
      expect(blocked.status).toBe(409);
    } finally {
      await timed.dispose();
    }
  });

  it('marks downstream artifacts stale on an upstream revision and blocks the gate (#13)', async () => {
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const g1 = await waitForPendingApproval(server, created.id, 'G1');
    await decideApproval(server, g1.id, 'approve');

    // Produce the dev-stage artifact (code_change v1) and reach G3.
    await waitForStageStatus(server, created.id, 'dev_implementation', 'ready');
    const detail = await getDemandDetail(server, created.id);
    const devStage = detail.body.stages.find((stage) => stage.stageKey === 'dev_implementation');
    const tasks = await api<{ tasks: Array<{ id: string; stageRunId: string | null }> }>(
      server,
      '/api/v1/tasks',
      { token: server.adminToken },
    );
    const devTask = tasks.body.tasks.find((task) => task.stageRunId === devStage?.id);
    const executor = await registerDeveloper(server);
    await claimTask(server, executor, devTask!.id);
    const submitted = await submitCodeChange(server, executor, devTask!.id);
    await completeTask(server, executor, devTask!.id, [submitted.artifact.id]);
    await waitForStageStatus(server, created.id, 'dev_implementation', 'waiting_human');
    const g3 = await waitForPendingApproval(server, created.id, 'G3');

    // Requirement analysis gets a human-confirmed v2 -> code_change v1 is stale.
    const analysisContent = JSON.stringify({
      summary: '需求分析（人工确认版）',
      goals: ['按销售组织汇总开票金额'],
      scope: { inScope: ['汇总'], outOfScope: [] },
      assumptions: [],
      openQuestions: [],
      acceptanceCriteria: [
        { criterion: '金额与 MARA 一致', anchor: '金额与 MARA 一致' },
        { criterion: '空结果返回 0', anchor: '空结果返回 0' },
      ],
      risks: [],
    });
    const revision = await api<{
      artifact: { id: string; currentVersion: number };
      version: { version: number; authorType: string };
    }>(server, `/api/v1/demands/${created.id}/artifacts`, {
      method: 'POST',
      token: server.userToken,
      body: {
        kind: 'requirement_analysis',
        contentType: 'application/json',
        contentBase64: Buffer.from(analysisContent, 'utf8').toString('base64'),
        checksum: checksumOf(analysisContent),
        summary: '人工确认需求分析',
      },
    });
    expect(revision.status).toBe(200);
    expect(revision.body.version).toMatchObject({ version: 2, authorType: 'human' });

    const staled = await waitFor(
      async () => {
        const fresh = await getDemandDetail(server, created.id);
        const staleVersions = fresh.body.artifactVersions.filter((version) => version.stale);
        return staleVersions.length > 0 ? fresh.body : undefined;
      },
      { label: 'stale downstream artifact', timeoutMs: 8_000 },
    );
    const codeChangeArtifact = staled.artifacts.find((artifact) => artifact.kind === 'code_change');
    const staleVersion = staled.artifactVersions.find(
      (version) => version.artifactId === codeChangeArtifact?.id,
    );
    expect(staleVersion?.stale).toBe(true);
    expect(staled.events.map((event) => event.type)).toContain('artifact.stale');

    // Approving the stale gate must be refused with a stale reason drawn from
    // the archived event data (history was inherited).
    const blocked = await decideApproval(server, g3.id, 'approve');
    expect(blocked.status).toBe(409);
    const error = (blocked.body as unknown as { error: { code: string; details: { reason: string } } }).error;
    expect(error.code).toBe('conflict');
    expect(error.details.reason).toBe('artifact_stale');

    // Rejecting starts a fresh attempt based on analysis v2; a new code_change
    // version clears the staleness and the gate can pass.
    await decideApproval(server, g3.id, 'reject', '上游已更新，请重新生成');
    const retried = await waitFor(
      async () => {
        const fresh = await getDemandDetail(server, created.id);
        const stage = fresh.body.stages.find((s) => s.stageKey === 'dev_implementation');
        return stage?.status === 'ready' ? fresh.body : undefined;
      },
      { label: 'dev stage retry after stale rejection', timeoutMs: 8_000 },
    );
    const devStageRetry = retried.stages.find((stage) => stage.stageKey === 'dev_implementation');
    const retryTaskList = await api<{ tasks: Array<{ id: string; stageRunId: string | null; state: string }> }>(
      server,
      '/api/v1/tasks',
      { token: server.adminToken },
    );
    const retryTask = retryTaskList.body.tasks.find(
      (task) => task.stageRunId === devStageRetry?.id && task.state === 'pending',
    );
    expect(retryTask).toBeDefined();
    await claimTask(server, executor, retryTask!.id);
    const resubmitted = await submitCodeChange(
      server,
      executor,
      retryTask!.id,
      'diff --git a/z.prog.abap b/z.prog.abap\n+SELECT * FROM mara " v2',
    );
    expect(resubmitted.version.version).toBe(2);
    await completeTask(server, executor, retryTask!.id, [resubmitted.artifact.id]);
    const g3b = await waitForPendingApproval(server, created.id, 'G3');
    const approved = await decideApproval(server, g3b.id, 'approve');
    expect(approved.status).toBe(200);
    const after = await getDemandDetail(server, created.id);
    const clearedVersion = after.body.artifactVersions.find(
      (version) => version.version === 2 && version.artifactId === codeChangeArtifact?.id,
    );
    expect(clearedVersion?.stale).toBe(false);
  });

  it('parks an AI stage for a human when checklist assertions keep failing (#15)', async () => {
    // Schema-valid JSON that does not cover the second acceptance criterion.
    const uncovered = JSON.stringify({
      summary: '不完整的需求分析',
      goals: ['汇总开票金额'],
      scope: { inScope: [], outOfScope: [] },
      assumptions: [],
      openQuestions: [],
      acceptanceCriteria: [{ criterion: '金额与 MARA 一致', anchor: '金额与 MARA 一致' }],
      risks: [],
    });
    const failing = await startTestServer({
      overrides: { aiProvider: new FakeModelProvider({ responses: [uncovered, uncovered] }) },
    });
    try {
      const created = await createDemand(failing, {
        acceptanceCriteria: ['金额与 MARA 一致', '必须支持多币种'],
      });
      const detail = await waitForStageStatus(
        failing,
        created.id,
        'requirement_analysis',
        'waiting_human',
      );
      // No half-baked artifact was persisted, and the failures are recorded.
      expect(detail.artifacts).toEqual([]);
      const failures = detail.events.filter((event) => event.type === 'stage.failed');
      expect(failures).toHaveLength(2);
      expect(JSON.stringify(failures[1]?.data)).toContain('acceptance_covered');
    } finally {
      await failing.dispose();
    }
  });

  it('recovers from a model timeout on attempt 1 without duplicating artifacts (#15)', async () => {
    const ok = JSON.stringify({
      summary: '重试后的需求分析',
      goals: ['汇总开票金额'],
      scope: { inScope: [], outOfScope: [] },
      assumptions: [],
      openQuestions: [],
      acceptanceCriteria: [
        { criterion: '金额与 MARA 一致', anchor: '金额与 MARA 一致' },
        { criterion: '空结果返回 0', anchor: '空结果返回 0' },
      ],
      risks: [],
    });
    const flaky = await startTestServer({
      overrides: { aiProvider: new FakeModelProvider({ responses: [new Error('model timeout'), ok] }) },
    });
    try {
      const created = await createDemand(flaky);
      const detail = await waitForStageStatus(
        flaky,
        created.id,
        'requirement_analysis',
        'waiting_human',
      );
      expect(detail.artifacts).toHaveLength(1);
      expect(detail.artifacts[0]?.currentVersion).toBe(1);
      const types = detail.events.map((event) => event.type);
      expect(types).toContain('stage.failed');
      expect(types).toContain('stage.ready');
    } finally {
      await flaky.dispose();
    }
  });

  it('parks a non-retryable task failure immediately for a human', async () => {
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const g1 = await waitForPendingApproval(server, created.id, 'G1');
    await decideApproval(server, g1.id, 'approve');
    await waitForStageStatus(server, created.id, 'dev_implementation', 'ready');
    const detail = await getDemandDetail(server, created.id);
    const devStage = detail.body.stages.find((stage) => stage.stageKey === 'dev_implementation');
    const tasks = await api<{ tasks: Array<{ id: string; stageRunId: string | null }> }>(
      server,
      '/api/v1/tasks',
      { token: server.adminToken },
    );
    const devTask = tasks.body.tasks.find((task) => task.stageRunId === devStage?.id);
    const executor = await registerDeveloper(server);
    await claimTask(server, executor, devTask!.id);
    const failed = await api(server, `/api/v1/tasks/${devTask!.id}/fail`, {
      method: 'POST',
      token: executor.token,
      body: { reason: 'SAP 会话失效，且不可自动重试', retryable: false },
    });
    expect(failed.status).toBe(200);
    const parked = await waitForStageStatus(server, created.id, 'dev_implementation', 'waiting_human');
    expect(parked.stages.find((stage) => stage.stageKey === 'dev_implementation')?.attempt).toBe(1);
  });

  it('uses the pdo preset with an observe confirmation gate on stage 1', async () => {
    const created = await createDemand(server, {
      templateId: 'pdo',
      title: 'R-9200 PDO 需求',
      acceptanceCriteria: ['金额与 MARA 一致'],
    });
    expect(created.templateVersion).toBe(1);
    expect(created.stages).toHaveLength(6);
    const intake = await waitForStageStatus(server, created.id, 'intake', 'waiting_human');
    expect(intake.artifacts[0]).toMatchObject({ kind: 'free_note', state: 'in_review' });
    const confirm = await waitForPendingApproval(server, created.id, 'confirm:intake');
    expect(confirm.requiredRole).toBe('consultant');
    const approved = await decideApproval(server, confirm.id, 'approve');
    expect(approved.status).toBe(200);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const g1 = await waitForPendingApproval(server, created.id, 'G1');
    expect(g1.gateKey).toBe('G1');
  });

  it('marks notifications as read', async () => {
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const unread = await api<{ notifications: Array<{ id: string }> }>(
      server,
      '/api/v1/notifications?state=unread',
      { token: server.userToken },
    );
    expect(unread.body.notifications.length).toBeGreaterThan(0);
    const notificationId = unread.body.notifications[0]!.id;
    const read = await api<{ notification: { readAt: string | null } }>(
      server,
      `/api/v1/notifications/${notificationId}/read`,
      { method: 'POST', token: server.userToken },
    );
    expect(read.status).toBe(200);
    expect(read.body.notification.readAt).toBeTruthy();
    const after = await api<{ notifications: Array<{ id: string }> }>(
      server,
      '/api/v1/notifications?state=unread',
      { token: server.userToken },
    );
    expect(after.body.notifications.map((entry) => entry.id)).not.toContain(notificationId);
  });

  it('exposes approvals bound to artifact versions via GET /approvals', async () => {
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    const response = await listApprovals(server);
    expect(response.status).toBe(200);
    expect(response.body.approvals).toHaveLength(1);
    expect(response.body.approvals[0]).toMatchObject({
      gateKey: 'G1',
      state: 'pending',
      requiredRole: 'consultant',
      artifactVersion: 1,
    });
    expect(response.body.approvals[0]?.artifactId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const badState = await api(server, '/api/v1/approvals?state=nope', {
      token: server.userToken,
    });
    expect(badState.status).toBe(400);
  });
});
