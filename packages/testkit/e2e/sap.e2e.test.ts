import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import {
  issueToken,
  loadOrCreateStateSecret,
  startServer,
  type RunningServer,
} from '@sap-superagent/server';
import {
  SapIcfClient,
  reconcileSapDemands,
  type ReconcileLocalDemand,
} from '@sap-superagent/sap-adapter';
import type { DemandDetailResponse, RegisterExecutorResponse } from '@sap-superagent/protocol';
import {
  FakeExecutor,
  FakeIcfServer,
  apiRequest,
  createTempStateDir,
  registerExecutor,
  removeTempStateDir,
  resolveTemplatesDir,
  waitFor,
} from '@sap-superagent/testkit';

// ---------------------------------------------------------------------------
// H2 Phase A end-to-end: SAP ICF (fake, in-process) → control plane → writeback.
//
// One compact chain: SAP Web submission → demand + AI stage in the control
// plane → writeback projection in SAP → SAP approval → unbound demand in the
// general task inbox → duplicate delivery idempotency → 409 writeback replay
// (docs/009 #12) → reconcile report has no differences for the SAP demand.
// No external process, no network, no real SAP; keeps `pnpm e2e` fast.
// ---------------------------------------------------------------------------

const templatesDir = resolveTemplatesDir();
const HOOK_SECRET = 'e2e-sap-hook-secret';
const SERVICE_USER = 'ZSA_CP_SERVICE';
const SERVICE_PASSWORD = 'e2e-password';

let fake: FakeIcfServer;
let server: RunningServer;
let stateDir: string;
let userToken: string;
let adminToken: string;

async function detail(demandId: string): Promise<DemandDetailResponse> {
  const response = await apiRequest<DemandDetailResponse>(
    server.url,
    `/api/v1/demands/${demandId}`,
    { token: userToken },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function deliverAll(): Promise<void> {
  const results = await fake.deliverEvents(server.url);
  for (const result of results) expect(result.status, JSON.stringify(result.body)).toBe(200);
}

beforeAll(async () => {
  fake = new FakeIcfServer({
    hookSecret: HOOK_SECRET,
    serviceUser: SERVICE_USER,
    servicePassword: SERVICE_PASSWORD,
  });
  await fake.start();
  stateDir = await createTempStateDir('sap-superagent-sap-e2e-');
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
      SA_SAP_BASE_URL: fake.url,
      SA_SAP_SERVICE_USER: SERVICE_USER,
      SA_SAP_SERVICE_PASSWORD: SERVICE_PASSWORD,
      SA_SAP_HOOK_SECRET: HOOK_SECRET,
      SA_SAP_WRITEBACK_POLL_MS: '10',
      SA_SAP_WRITEBACK_BACKOFF_BASE_MS: '10',
      SA_SAP_WRITEBACK_BACKOFF_MAX_MS: '40',
      SA_SAP_WRITEBACK_MAX_ATTEMPTS: '3',
      SA_SAP_TIMEOUT_MS: '500',
    },
  });
  userToken = issueToken({ kind: 'user', sub: 'sap-e2e-requester', secret });
  adminToken = issueToken({ kind: 'admin', sub: 'sap-e2e-admin', secret });
});

afterAll(async () => {
  await server.close();
  await fake.close();
  await removeTempStateDir(stateDir);
});

describe('H2 Phase A end-to-end (SAP ICF → control plane → writeback)', () => {
  it('runs the SAP submission → analysis → writeback → approval → inbox chain', async () => {
    // 1. A business user submits an *unbound* demand in the SAP Web page.
    const { demand: sapDemand, event } = fake.createDemandFromUi({
      title: 'E2E 取数逻辑',
      description: '按销售组织汇总开票金额',
      acceptanceCriteria: ['金额与 MARA 一致'],
      requesterUserId: 'REQ2041',
      orgUnit: 'PDO',
      priority: 'high',
    });
    const delivery = await fake.deliverEvents(server.url);
    expect(delivery[0]).toMatchObject({
      eventId: event.eventId,
      status: 200,
      body: { accepted: true, duplicate: false },
    });
    const demandId = sapDemand.demandId.toLowerCase();

    // 2. The control plane creates the demand, keeps the SAP UUID C32 and runs
    //    the server-ai analysis stage (H0 behaviour, now SAP-sourced).
    const analyzed = await waitFor(
      async () => {
        const current = await detail(demandId);
        return current.stages[0]?.status === 'done' && current.artifacts.length > 0
          ? current
          : undefined;
      },
      { timeoutMs: 5_000, label: 'SAP demand analysis stage' },
    );
    expect(analyzed.demand).toMatchObject({
      id: demandId,
      source: 'sap',
      workspaceBinding: null,
      priority: 'high',
    });
    expect(analyzed.artifacts[0]?.kind).toBe('requirement_analysis');

    // 3. The writeback worker projects the status + artifact metadata into SAP.
    await waitFor(
      async () => (fake.demands.get(sapDemand.demandId)?.status === '开发中' ? true : undefined),
      { timeoutMs: 5_000, label: 'SAP status projection' },
    );
    const writeback = fake.writebacks.find((entry) => entry.status === 200);
    expect(writeback?.patch).toMatchObject({ status: '开发中', stageKey: 'dev_implementation' });

    // 4. A SAP-side gate approval federates back as artifact.approved.
    fake.decideApproval({
      demandId: sapDemand.demandId,
      gateKey: 'G1',
      decision: 'approve',
      decidedBy: 'CONSULTANT01',
      comment: '同意',
      stageKey: 'requirement_analysis',
    });
    await deliverAll();
    const approved = await waitFor(
      async () => {
        const current = await detail(demandId);
        return current.artifacts[0]?.state === 'approved' ? current : undefined;
      },
      { timeoutMs: 5_000, label: 'artifact approved from SAP' },
    );
    expect(approved.events.map((event) => event.type)).toContain('artifact.approved');

    // 5. The unbound demand enters the general task inbox (docs/009 #16):
    //    the task carries no workspace binding and is claimable by an executor
    //    that has no repository open.
    const task = await apiRequest<{ task: { id: string } }>(server.url, '/api/v1/admin/tasks', {
      method: 'POST',
      token: adminToken,
      body: {
        demandId,
        title: '实现 E2E 取数逻辑',
        executorKind: 'vscode',
        requiredRoles: ['developer'],
        workspaceBinding: null,
      },
    });
    expect([200, 201]).toContain(task.status);
    const registration: RegisterExecutorResponse = await registerExecutor(server.url, userToken, {
      kind: 'vscode',
      user: 'DEV2041',
      protocolVersion: '1.0.0',
      capabilities: ['coding'],
      roles: ['developer'],
      workspaces: [],
      maxConcurrent: 2,
    });
    expect(registration.executor.id).toBeTruthy();
    const executor = new FakeExecutor({
      baseUrl: server.url,
      executorToken: registration.executorToken,
      executorId: registration.executor.id,
      user: 'DEV2041',
    });
    const heartbeat = await executor.heartbeatOk({ status: 'online', load: 0, activeWorkspaceKey: null });
    expect(heartbeat.offers.map((offer) => offer.id)).toContain(task.body.task.id);
    const listed = await executor.listTasks();
    expect(listed.body.tasks.map((entry) => entry.id)).toContain(task.body.task.id);
    const claim = await executor.claimOk(task.body.task.id);
    expect(claim.task.state).toBe('claimed');

    // 6. Re-delivering the same SAP outbox event is idempotent.
    const replayDelivery = fake.buildDelivery(event);
    const duplicate = await fetch(`${server.url}/hooks/sap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...replayDelivery.headers },
      body: replayDelivery.body,
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    const list = await apiRequest<{ demands: Array<{ id: string }> }>(server.url, '/api/v1/demands', {
      token: userToken,
    });
    expect(list.body.demands.filter((entry) => entry.id === demandId)).toHaveLength(1);

    // 7. A writeback 409 is re-pulled and replayed (docs/009 #12), and the SAP
    //    projection converges on the cancellation.
    fake.injectFault({ kind: 'status', status: 409, method: 'PATCH', pathIncludes: '/api/demands/' });
    fake.enqueueEvent('demand.cancelled', sapDemand.demandId, { reason: '业务取消' });
    await deliverAll();
    await waitFor(
      async () => (fake.demands.get(sapDemand.demandId)?.status === '已取消' ? true : undefined),
      { timeoutMs: 5_000, label: 'SAP projection 已取消 after 409 replay' },
    );
    const conflict = fake.writebacks.find((entry) => entry.status === 409);
    expect(conflict).toBeDefined();
    expect(await detail(demandId).then((current) => current.demand.status)).toBe('cancelled');

    // 8. Reconcile over the real ICF client reports no differences.
    const client = new SapIcfClient({
      baseUrl: fake.url,
      username: SERVICE_USER,
      password: SERVICE_PASSWORD,
    });
    const currentList = await apiRequest<{ demands: Array<{ id: string }> }>(
      server.url,
      '/api/v1/demands',
      { token: userToken },
    );
    const localDemands = currentList.body.demands as unknown as Array<{
      id: string;
      status: ReconcileLocalDemand['status'];
      title: string;
      source: ReconcileLocalDemand['source'];
    }>;
    const report = await reconcileSapDemands(
      client,
      localDemands
        .filter((entry) => entry.source === 'sap')
        .map((entry) => ({ id: entry.id, status: entry.status, title: entry.title, source: entry.source })),
      { changedSince: '2000-01-01T00:00:00.000Z' },
    );
    expect(report.sapCount).toBeGreaterThanOrEqual(1);
    expect(report.differences).toEqual([]);
  });
});
