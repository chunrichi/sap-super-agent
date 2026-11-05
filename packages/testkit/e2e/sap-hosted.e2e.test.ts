import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeModelProvider,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
} from '@sap-superagent/ai';
import {
  issueToken,
  loadOrCreateStateSecret,
  startServer,
  type RunningServer,
} from '@sap-superagent/server';
import type {
  Approval,
  CreateDemandResponse,
  DemandDetailResponse,
  EventEnvelope,
  ListTasksResponse,
  RegisterExecutorResponse,
  SapAiJobsStatus,
  StageRun,
} from '@sap-superagent/protocol';
import {
  FakeAiGateway,
  FakeExecutor,
  FakeSapAiBatch,
  apiRequest,
  buildFakeHookHeaders,
  createTempStateDir,
  registerExecutor,
  removeTempStateDir,
  resolveTemplatesDir,
  waitFor,
  type FakeAiGatewayMessage,
  type FakeSapAiBatchProcessedJob,
} from '@sap-superagent/testkit';

// ---------------------------------------------------------------------------
// S5 acceptance e2e (docs/009 #17/#18, task book §1.4/§1.6): M3 SAP-hosted mode.
//
// One compact in-process chain with NO external process and NO network:
//   pdo Demand -> the SAP batch executor (fake ZCL_ZSA_AI_BATCH) pumps intake /
//   requirement_analysis / dev_spec jobs, each calling the fake enterprise AI
//   gateway -> SAP-side approvals federate through POST /hooks/sap
//   (`artifact.approved`, confirm:intake + G1 + G2) -> a FakeExecutor implements
//   dev_implementation and unregisters (the developer goes offline) -> the SAP
//   batch produces test_doc -> SAP approves G4 -> knowledge_archive -> G5 ->
//   Demand done.
//
// Assertions: no executor is online for the whole SAP-driven tail, the event
// chain contains stage.ai_job.queued/claimed/completed, the local model
// provider was never called, artifact versions/gates are correct and
// `/hooks/sap/status` reports the SAP job counters.
// ---------------------------------------------------------------------------

const templatesDir = resolveTemplatesDir();
const HOOK_SECRET = 'e2e-sap-hosted-hook-secret';
const AI_MODEL = 'e2e-sap-ai-model';
const DEMAND_TITLE = 'R-5001 SAP 宿主需求';
const ACCEPTANCE_CRITERIA = ['金额与 MARA 一致', '空结果返回 0'];

const INTAKE_OUTPUT = JSON.stringify(
  {
    summary: '已受理：按销售组织汇总开票金额',
    openQuestions: [],
    inScope: ['按销售组织汇总开票金额，空结果返回 0'],
  },
  null,
  2,
);

const REQUIREMENT_ANALYSIS_OUTPUT = JSON.stringify(
  {
    summary: '按销售组织汇总开票金额的需求分析',
    goals: ['按月汇总开票金额'],
    scope: { inScope: ['销售组织汇总'], outOfScope: ['跨系统对账'] },
    assumptions: ['数据来自 MARA'],
    openQuestions: [],
    acceptanceCriteria: ACCEPTANCE_CRITERIA.map((criterion) => ({
      criterion,
      anchor: criterion,
    })),
    risks: ['数据量大时需要分页'],
  },
  null,
  2,
);

const DEV_SPEC_OUTPUT = JSON.stringify(
  {
    summary: '汇总取数逻辑的开发说明',
    changes: [
      {
        file: 'zsales_aggregate.prog.abap',
        description: '新增按销售组织汇总开票金额的取数逻辑',
      },
    ],
    testPlan: ['空结果返回 0', '金额与 MARA 一致'],
    risks: ['大结果集性能'],
  },
  null,
  2,
);

const TEST_DOC_OUTPUT = JSON.stringify(
  {
    summary: '汇总取数逻辑的测试文档',
    cases: ACCEPTANCE_CRITERIA.map((criterion, index) => ({
      id: `TC-${String(index + 1).padStart(3, '0')}`,
      title: criterion,
      steps: ['准备测试数据', '执行取数程序', '核对输出'],
      expected: criterion,
    })),
    environment: 'SAP 测试系统（虚构数据）',
  },
  null,
  2,
);

const KNOWLEDGE_ENTRY_OUTPUT = JSON.stringify(
  {
    summary: '汇总取数逻辑的验收归档',
    tags: ['PDO', '取数'],
    decisions: ['按需求分析确认的范围交付'],
  },
  null,
  2,
);

/**
 * The enterprise gateway only sees messages (never the stage key), so the fake
 * selects the stage-specific JSON by the rendered prompt heading
 * (`packages/ai/prompts/<stage>.md` first line).
 */
const STAGE_OUTPUTS: ReadonlyArray<{ promptHeading: string; output: string }> = [
  { promptHeading: '# 受理与澄清', output: INTAKE_OUTPUT },
  { promptHeading: '# 需求分析', output: REQUIREMENT_ANALYSIS_OUTPUT },
  { promptHeading: '# 开发说明', output: DEV_SPEC_OUTPUT },
  { promptHeading: '# 测试文档', output: TEST_DOC_OUTPUT },
  { promptHeading: '# 知识归档', output: KNOWLEDGE_ENTRY_OUTPUT },
];

function fakeGatewayOutput(messages: readonly FakeAiGatewayMessage[]): string {
  const prompt = messages.map((message) => message.content).join('\n');
  for (const entry of STAGE_OUTPUTS) {
    if (prompt.includes(entry.promptHeading)) return entry.output;
  }
  throw new Error('fake AI gateway received a prompt for an unknown stage');
}

/** Wraps `FakeModelProvider` so the e2e can prove the local provider is unused. */
class CountingModelProvider implements ModelProvider {
  readonly name = 'e2e-counting-fake';
  calls = 0;
  private readonly inner = new FakeModelProvider();

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    return this.inner.complete(request);
  }
}

interface SapHookStatusResponse {
  enabled: { outbound: boolean; inbound: boolean };
  outbox: unknown;
  aiJobs?: SapAiJobsStatus;
  serverTime: string;
}

interface PendingApproval {
  detail: DemandDetailResponse;
  approval: Approval;
  stageKey: string;
}

let gateway: FakeAiGateway;
let batch: FakeSapAiBatch;
let server: RunningServer;
let stateDir: string;
let userToken: string;
let adminToken: string;
let dbPath: string;
const provider = new CountingModelProvider();
let approvalSequence = 0;

function db(): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  database.exec('PRAGMA busy_timeout = 2000;');
  return database;
}

/** Number of executors that still count as online (presence != offline). */
async function countOnlineExecutors(): Promise<number> {
  const database = db();
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM executors WHERE presence != 'offline'`)
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  } finally {
    database.close();
  }
}

async function detail(demandId: string): Promise<DemandDetailResponse> {
  const response = await apiRequest<DemandDetailResponse>(
    server.url,
    `/api/v1/demands/${demandId}`,
    { token: userToken },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function waitForDetail(
  demandId: string,
  probe: (current: DemandDetailResponse) => DemandDetailResponse | undefined,
  label: string,
): Promise<DemandDetailResponse> {
  return waitFor(async () => probe(await detail(demandId)), {
    timeoutMs: 5_000,
    intervalMs: 5,
    label,
  });
}

async function waitForStage(
  demandId: string,
  stageKey: string,
  status: StageRun['status'],
): Promise<StageRun> {
  return waitFor(
    async () => {
      const current = await detail(demandId);
      const stage = current.stages.find((candidate) => candidate.stageKey === stageKey);
      return stage?.status === status ? stage : undefined;
    },
    { timeoutMs: 5_000, intervalMs: 5, label: `stage ${stageKey} ${status}` },
  );
}

async function readEvents(): Promise<EventEnvelope[]> {
  const response = await apiRequest<{ events: EventEnvelope[] }>(
    server.url,
    '/api/v1/events?after=0&limit=500',
    { token: adminToken },
  );
  expect(response.status).toBe(200);
  return response.body.events;
}

/** Wait for the next queued SAP job and let the fake batch executor drain it. */
async function pumpNextJob(): Promise<FakeSapAiBatchProcessedJob> {
  return waitFor(
    async () => {
      const processed = await batch.pump({ maxJobs: 1 });
      return processed[0];
    },
    { timeoutMs: 5_000, intervalMs: 5, label: 'queued SAP AI job' },
  );
}

async function waitForPendingApproval(demandId: string): Promise<PendingApproval> {
  const current = await waitForDetail(
    demandId,
    (candidate) =>
      candidate.approvals.some((approval) => approval.state === 'pending') ? candidate : undefined,
    'pending gate approval',
  );
  const approval = current.approvals.find((candidate) => candidate.state === 'pending');
  expect(approval).toBeDefined();
  const stage = current.stages.find((candidate) => candidate.id === approval?.stageRunId);
  expect(stage, 'approval must point at a stage run').toBeDefined();
  return { detail: current, approval: approval as Approval, stageKey: stage?.stageKey ?? '' };
}

/**
 * Fake SAP Web approval: the SAP outbox signs `artifact.approved` with the
 * X-SA-* HMAC headers and federates it to `POST /hooks/sap` (docs/004 §3.3).
 */
async function approveFromSapWeb(demandId: string, approval: Approval): Promise<void> {
  approvalSequence += 1;
  const delivery = `e2e-sap-hosted-approval-${approvalSequence}`;
  const rawBody = JSON.stringify({
    eventId: delivery,
    occurredAt: new Date().toISOString(),
    data: {
      type: 'artifact.approved',
      demandId,
      artifactId: approval.artifactId,
      version: approval.artifactVersion,
      gateKey: approval.gateKey,
      decidedBy: 'CONSULTANT01',
      comment: 'SAP 内审批通过',
    },
  });
  const response = await fetch(`${server.url}/hooks/sap`, {
    method: 'POST',
    headers: {
      ...buildFakeHookHeaders({ secret: HOOK_SECRET, body: rawBody, delivery }),
    },
    body: rawBody,
  });
  const body = (await response.json()) as {
    accepted?: boolean;
    duplicate?: boolean;
    action?: string;
  };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({ accepted: true, duplicate: false, action: 'stage_advanced' });
}

async function waitForPendingTask(demandId: string, stageRunId: string): Promise<string> {
  return waitFor(
    async () => {
      const response = await apiRequest<ListTasksResponse>(server.url, '/api/v1/tasks', {
        token: adminToken,
      });
      expect(response.status).toBe(200);
      return response.body.tasks.find(
        (task) => task.stageRunId === stageRunId && task.state === 'pending',
      )?.id;
    },
    { timeoutMs: 5_000, intervalMs: 5, label: 'dev implementation task' },
  );
}

beforeAll(async () => {
  gateway = new FakeAiGateway({
    model: AI_MODEL,
    respond: (request) => fakeGatewayOutput(request.messages),
  });
  await gateway.start();
  stateDir = await createTempStateDir('sa-sap-hosted-e2e-');
  dbPath = join(stateDir, 'state.db');
  const secret = loadOrCreateStateSecret(stateDir);
  server = await startServer({
    stateDir,
    templatesDir,
    port: 0,
    aiProvider: provider,
    leaseTtlMs: 60_000,
    presenceTtlMs: 60_000,
    heartbeatSweepMs: 25,
    stagePollMs: 5,
    logger: false,
    env: {
      // M3: delegate every server-ai stage to the SAP batch executor.
      SA_SAP_AI_BATCH: '1',
      SA_SAP_HOOK_SECRET: HOOK_SECRET,
      SA_SAP_AI_JOB_LEASE_MS: '60000',
      SA_SAP_AI_JOB_MAX_AGE_MS: '300000',
      SA_SAP_AI_JOB_BATCH_SIZE: '5',
      SA_SAP_AI_JOB_TIMEOUT_MS: '5000',
      SA_AI_PROVIDER: 'fake',
      SA_AI_MODEL: AI_MODEL,
    },
  });
  batch = new FakeSapAiBatch({
    controlPlaneUrl: server.url,
    hookSecret: HOOK_SECRET,
    gatewayUrl: gateway.url,
    heartbeatBeforeResult: true,
  });
  userToken = issueToken({ kind: 'user', sub: 'sap-hosted-e2e-requester', secret });
  adminToken = issueToken({ kind: 'admin', sub: 'sap-hosted-e2e-admin', secret });
});

afterAll(async () => {
  await batch.stop();
  await server.close();
  await gateway.stop();
  await removeTempStateDir(stateDir);
});

describe('S5 SAP-hosted mode e2e (M3: SAP batch AI + SAP-side approvals)', () => {
  it('runs pdo intake -> done with no executor online and no local provider call', async () => {
    // -- 0. The control plane is in SAP batch mode; nothing is claimed by an
    //    executor yet and the local model provider must stay untouched.
    expect(provider.calls).toBe(0);
    expect(await countOnlineExecutors()).toBe(0);

    // -- 1. A PDO demand enters the control plane ---------------------------
    const created = await apiRequest<CreateDemandResponse>(server.url, '/api/v1/demands', {
      method: 'POST',
      token: userToken,
      body: {
        title: DEMAND_TITLE,
        description: '按销售组织汇总开票金额，空结果返回 0',
        acceptanceCriteria: ACCEPTANCE_CRITERIA,
        priority: 'high',
        requester: { userId: 'REQ2041', orgUnit: 'PDO' },
        templateId: 'pdo',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const demandId = created.body.demand.id;
    expect(created.body.stages.map((stage) => stage.stageKey)).toEqual([
      'intake',
      'requirement_analysis',
      'dev_spec',
      'dev_implementation',
      'test_acceptance',
      'knowledge_archive',
    ]);

    // -- 2. The SAP batch drives intake; the observe stage parks at the
    //    auto-generated confirm gate (role consultant).
    const intakeJob = await pumpNextJob();
    expect(intakeJob).toMatchObject({
      stageKey: 'intake',
      attempt: 1,
      state: 'succeeded',
      resultStatus: 200,
      gatewayRequests: 1,
    });
    const intakeApproval = await waitForPendingApproval(demandId);
    expect(intakeApproval.approval).toMatchObject({
      gateKey: 'confirm:intake',
      requiredRole: 'consultant',
      state: 'pending',
    });
    const intakeArtifact = intakeApproval.detail.artifacts.find(
      (artifact) => artifact.kind === 'free_note',
    );
    expect(intakeArtifact?.state).toBe('in_review');
    await approveFromSapWeb(demandId, intakeApproval.approval);

    // -- 3. requirement_analysis (G1) is produced by the SAP batch too ------
    const analysisJob = await pumpNextJob();
    expect(analysisJob).toMatchObject({ stageKey: 'requirement_analysis', state: 'succeeded' });
    const g1 = await waitForPendingApproval(demandId);
    expect(g1.approval).toMatchObject({ gateKey: 'G1', requiredRole: 'consultant' });
    await approveFromSapWeb(demandId, g1.approval);
    expect(
      (await waitForDetail(
        demandId,
        (current) =>
          current.artifacts.find((artifact) => artifact.kind === 'requirement_analysis')
            ?.state === 'approved'
            ? current
            : undefined,
        'requirement analysis approved',
      )).artifacts.find((artifact) => artifact.kind === 'free_note')?.state,
    ).toBe('approved');

    // -- 4. dev_spec (G2) then the developer implements dev_implementation ---
    const devSpecJob = await pumpNextJob();
    expect(devSpecJob).toMatchObject({ stageKey: 'dev_spec', state: 'succeeded' });
    const g2 = await waitForPendingApproval(demandId);
    expect(g2.approval).toMatchObject({ gateKey: 'G2', requiredRole: 'consultant' });
    await approveFromSapWeb(demandId, g2.approval);

    const devStage = await waitForStage(demandId, 'dev_implementation', 'ready');
    const taskId = await waitForPendingTask(demandId, devStage.id);
    const registration: RegisterExecutorResponse = await registerExecutor(server.url, userToken, {
      kind: 'vscode',
      user: 'DEV2041',
      protocolVersion: '1.0.0',
      capabilities: ['coding'],
      roles: ['developer'],
      // Unbound demand: the executor has no repository open.
      workspaces: [],
      maxConcurrent: 2,
    });
    const executor = new FakeExecutor({
      baseUrl: server.url,
      executorToken: registration.executorToken,
      executorId: registration.executor.id,
      user: 'DEV2041',
    });
    const heartbeat = await executor.heartbeatOk({
      status: 'online',
      load: 0,
      activeWorkspaceKey: null,
    });
    expect(heartbeat.offers.map((offer) => offer.id)).toContain(taskId);
    const claim = await executor.claimOk(taskId);
    expect(claim.task.state).toBe('claimed');
    const submitted = await executor.submitArtifact(taskId, {
      kind: 'code_change',
      content: 'diff --git a/zsales_aggregate.prog.abap b/zsales_aggregate.prog.abap\n+SELECT * FROM mara',
      summary: 'ABAP 取数实现',
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const completed = await executor.complete(taskId, {
      summary: '实现并自测完成',
      artifactIds: [submitted.body.artifact.id],
      links: [],
      openQuestions: [],
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    // The dev artifact lands in review: the stage parks at gate G3.
    await waitForStage(demandId, 'dev_implementation', 'waiting_human');
    // The developer goes offline; from here on the SAP batch alone drives the
    // remaining server-ai stages (task book §1.4/§1.6).
    const unregistered = await executor.unregister();
    expect(unregistered.status).toBe(200);
    expect(await countOnlineExecutors()).toBe(0);

    // G3 (dev review) is approved inside SAP as well.
    const g3 = await waitForPendingApproval(demandId);
    expect(g3.approval).toMatchObject({ gateKey: 'G3', requiredRole: 'developer' });
    await approveFromSapWeb(demandId, g3.approval);

    // -- 5. test_acceptance (G4) is produced by the SAP batch ---------------
    const testDocJob = await pumpNextJob();
    expect(testDocJob, JSON.stringify(testDocJob)).toMatchObject({
      stageKey: 'test_acceptance',
      state: 'succeeded',
    });
    const g4 = await waitForPendingApproval(demandId);
    expect(g4.approval).toMatchObject({ gateKey: 'G4', requiredRole: 'requester' });
    await approveFromSapWeb(demandId, g4.approval);

    // -- 6. knowledge_archive (G5) -> demand done ---------------------------
    const archiveJob = await pumpNextJob();
    expect(archiveJob).toMatchObject({ stageKey: 'knowledge_archive', state: 'succeeded' });
    const g5 = await waitForPendingApproval(demandId);
    expect(g5.approval).toMatchObject({ gateKey: 'G5', requiredRole: 'ops' });
    await approveFromSapWeb(demandId, g5.approval);

    const done = await waitForDetail(
      demandId,
      (current) => (current.demand.status === 'done' ? current : undefined),
      'demand done',
    );

    // -- 7. Artifacts / gates / executor state ------------------------------
    expect(done.demand.status).toBe('done');
    expect(done.stages.map((stage) => stage.status)).toEqual(Array(6).fill('done'));
    expect(done.artifacts.map((artifact) => artifact.state)).toEqual(Array(6).fill('approved'));
    expect(done.artifacts.map((artifact) => artifact.currentVersion)).toEqual(Array(6).fill(1));
    expect([...done.artifacts.map((artifact) => artifact.kind)].sort()).toEqual(
      ['code_change', 'dev_spec', 'free_note', 'knowledge_entry', 'requirement_analysis', 'test_doc'],
    );
    expect(done.approvals.map((approval) => approval.gateKey).sort()).toEqual(
      ['G1', 'G2', 'G3', 'G4', 'G5', 'confirm:intake'].sort(),
    );
    expect(done.approvals.every((approval) => approval.state === 'approved')).toBe(true);
    expect(done.approvals.every((approval) => approval.decidedBy === 'CONSULTANT01')).toBe(true);
    expect(done.artifactVersions.every((version) => !version.stale)).toBe(true);
    expect(await countOnlineExecutors()).toBe(0);

    // -- 8. Event chain: SAP job lifecycle + no failure + no local provider --
    const events = await readEvents();
    const ofType = (type: string): EventEnvelope[] =>
      events.filter((event) => event.type === type);
    const completedJobs = ofType('stage.ai_job.completed');
    expect(completedJobs).toHaveLength(5);
    expect(ofType('stage.ai_job.queued')).toHaveLength(5);
    expect(ofType('stage.ai_job.claimed')).toHaveLength(5);
    expect(ofType('stage.ai_job.failed')).toHaveLength(0);
    expect(
      completedJobs.map((event) => String(event.data['stageKey'])).sort(),
    ).toEqual(['dev_spec', 'intake', 'knowledge_archive', 'requirement_analysis', 'test_acceptance']);
    for (const event of completedJobs) {
      expect(event.subject.type).toBe('stage_run');
      expect(event.data['demandId']).toBe(demandId);
      expect(typeof event.data['jobId']).toBe('string');
      expect(typeof event.data['artifactId']).toBe('string');
      expect(typeof event.data['artifactVersion']).toBe('number');
      expect(typeof event.data['tokens']).toBe('number');
    }
    const claimedEvents = ofType('stage.ai_job.claimed');
    for (const event of claimedEvents) {
      expect(typeof event.data['claimId']).toBe('string');
      expect(typeof event.data['leaseExpiresAt']).toBe('string');
    }
    expect(provider.calls).toBe(0);
    // The SAP batch called the enterprise gateway exactly once per stage.
    expect(gateway.requests).toHaveLength(5);
    for (const request of gateway.requests) {
      expect(request.path).toBe('/chat/completions');
      expect(request.model.length).toBeGreaterThan(0);
      expect(request.messages.map((message) => message.role)).toEqual(['system', 'user']);
      expect(request.messages.every((message) => message.content.length > 0)).toBe(true);
    }
    expect(batch.processed.map((job) => job.stageKey)).toEqual([
      'intake',
      'requirement_analysis',
      'dev_spec',
      'test_acceptance',
      'knowledge_archive',
    ]);
    expect(batch.processed.every((job) => job.resultStatus === 200)).toBe(true);
    expect(batch.processed.every((job) => job.duplicate === false)).toBe(true);
    for (const job of batch.processed) expect(job.gatewayRequests).toBe(1);

    // -- 9. Ops surface: GET /hooks/sap/status aiJobs counters -------------
    const status = await apiRequest<SapHookStatusResponse>(server.url, '/hooks/sap/status', {
      token: adminToken,
    });
    expect(status.status).toBe(200);
    expect(status.body.aiJobs).toMatchObject({
      queued: 0,
      claimed: 0,
      succeeded: 5,
      failed: 0,
      expired: 0,
      cancelled: 0,
      lastError: null,
    });
  });
});
