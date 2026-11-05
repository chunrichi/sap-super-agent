// S3 multi-user integration: WS `task.offered` eligibility filtering and the
// per-user concurrency cap (docs/003 §3/§4.4, task book §1.1/§1.3, docs/009
// #1/#16). Everything runs against a real server + SQLite; the WS probes speak
// the protocol like a client does.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createAdminTask,
  createDemand,
  heartbeat,
  readEvents,
  registerExecutor,
  startTestServer,
  type RegisteredExecutor,
  type TestServer,
} from './helpers.js';
import { openProbe, settle, socketUrl } from './ws-helpers.js';

interface TaskInput {
  requiredRoles?: string[];
  workspaceBinding?: { repo: string; projectKey?: string; baseBranch?: string } | null;
}

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer({ overrides: { presenceTtlMs: 10_000 } });
});

afterEach(async () => {
  await server.dispose();
});

async function createTask(input: TaskInput = {}): Promise<string> {
  const demand = await createDemand(server);
  const created = await createAdminTask(server, {
    demandId: demand.id,
    title: 'S3 多执行器任务',
    executorKind: 'vscode',
    requiredRoles: input.requiredRoles ?? [],
    workspaceBinding: input.workspaceBinding ?? null,
  });
  expect(created.status).toBe(200);
  return created.body.task.id;
}

function claim(executor: RegisteredExecutor, taskId: string) {
  return api(server, `/api/v1/tasks/${taskId}/claim`, {
    method: 'POST',
    token: executor.token,
    body: {},
  });
}

async function openExecutorProbe(executor: RegisteredExecutor, after: number) {
  return openProbe(socketUrl(server.running.url, executor.token, after));
}

describe('WS task.offered eligibility filtering (S3, docs/003 §3/§4.4)', () => {
  it('only pushes offers to online executors that satisfy the workspace/role rules', async () => {
    const eligible = await registerExecutor(server, 'DEV001', {
      roles: ['developer'],
      workspaceKey: 'wk-z-sales',
      repo: 'z-sales',
    });
    await heartbeat(server, eligible, 'wk-z-sales');
    const otherWorkspace = await registerExecutor(server, 'DEV002', {
      roles: ['developer'],
      workspaceKey: 'wk-other',
      repo: 'z-other',
    });
    await heartbeat(server, otherWorkspace, 'wk-other');

    const { lastSeq } = await readEvents(server);
    const eligibleProbe = await openExecutorProbe(eligible, lastSeq);
    const otherProbe = await openExecutorProbe(otherWorkspace, lastSeq);
    const userProbe = await openProbe(socketUrl(server.running.url, server.userToken, lastSeq));
    try {
      const taskId = await createTask({
        requiredRoles: ['developer'],
        workspaceBinding: { repo: 'z-sales' },
      });

      const frame = await eligibleProbe.waitFor(
        (message) => message.type === 'task.offered' && message.subject.id === taskId,
      );
      expect(frame.task.requiredRoles).toEqual(['developer']);
      expect(frame.seq).toBeUndefined();

      await settle();
      // Ineligible executor, user and admin sockets never get the hint frame...
      expect(
        otherProbe.messages.filter((message) => message.type === 'task.offered'),
      ).toHaveLength(0);
      expect(userProbe.messages.filter((message) => message.type === 'task.offered')).toHaveLength(
        0,
      );
      // ...but they still receive the authoritative event stream.
      expect(
        otherProbe.messages.some(
          (message) => message.type === 'task.created' && message.subject.id === taskId,
        ),
      ).toBe(true);
      expect(
        userProbe.messages.some(
          (message) => message.type === 'task.created' && message.subject.id === taskId,
        ),
      ).toBe(true);
    } finally {
      eligibleProbe.socket.close();
      otherProbe.socket.close();
      userProbe.socket.close();
    }
  });

  it('never offers to offline or paused executors', async () => {
    const offline = await registerExecutor(server, 'DEV-offline', { roles: [] });
    const paused = await registerExecutor(server, 'DEV-paused', { roles: [] });
    // Paused executor is online but reports `away` (accepting=false mirror).
    await api(server, `/api/v1/executors/${paused.executorId}/heartbeat`, {
      method: 'POST',
      token: paused.token,
      body: { status: 'away', load: 0, activeWorkspaceKey: 'wk-z-sales' },
    });
    const online = await registerExecutor(server, 'DEV-online', { roles: [] });
    await heartbeat(server, online);

    const { lastSeq } = await readEvents(server);
    const offlineProbe = await openExecutorProbe(offline, lastSeq);
    const pausedProbe = await openExecutorProbe(paused, lastSeq);
    const onlineProbe = await openExecutorProbe(online, lastSeq);
    try {
      const taskId = await createTask();
      await onlineProbe.waitFor(
        (message) => message.type === 'task.offered' && message.subject.id === taskId,
      );
      await settle();
      expect(offlineProbe.messages.filter((message) => message.type === 'task.offered')).toHaveLength(
        0,
      );
      expect(pausedProbe.messages.filter((message) => message.type === 'task.offered')).toHaveLength(
        0,
      );
    } finally {
      offlineProbe.socket.close();
      pausedProbe.socket.close();
      onlineProbe.socket.close();
    }
  });

  it('keeps the push and pull paths consistent across a reconnect', async () => {
    const executor = await registerExecutor(server, 'DEV001', { roles: [] });
    await heartbeat(server, executor);

    const { lastSeq: baseSeq } = await readEvents(server);
    const first = await openExecutorProbe(executor, baseSeq);
    let taskId: string;
    try {
      taskId = await createTask();
      await first.waitFor(
        (message) => message.type === 'task.offered' && message.subject.id === taskId,
      );
    } finally {
      first.socket.close();
    }

    // Pull path agrees with the frame that was pushed before the disconnect.
    const pulled = await heartbeat(server, executor);
    expect(pulled.body.offers.map((offer) => offer.id)).toContain(taskId);

    // A reconnect does not replay the transport-only frame (it is not persisted),
    // but the heartbeat still offers the task, so the inbox is consistent.
    const { lastSeq } = await readEvents(server);
    expect(lastSeq).toBeGreaterThan(baseSeq);
    const second = await openExecutorProbe(executor, lastSeq);
    try {
      await settle();
      expect(second.messages.filter((message) => message.type === 'task.offered')).toHaveLength(0);
    } finally {
      second.socket.close();
    }
  });
});

describe('maxConcurrentPerUser (S3, docs/003 §3 rule 6)', () => {
  it('caps human tasks per user across executors and frees a slot on completion', async () => {
    const first = await registerExecutor(server, 'DEV001', { roles: [] });
    const second = await registerExecutor(server, 'DEV001', { roles: [] });
    const otherUser = await registerExecutor(server, 'DEV002', { roles: [] });
    await heartbeat(server, first);
    await heartbeat(server, second);
    await heartbeat(server, otherUser);

    const t1 = await createTask();
    const t2 = await createTask();
    const t3 = await createTask();

    expect((await claim(first, t1)).status).toBe(200);
    expect((await claim(second, t2)).status).toBe(200);

    const blocked = await claim(first, t3);
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error?: { details?: { reasons?: string[] } } }).error?.details?.reasons).toContain(
      'user_at_capacity',
    );
    // Offers for the same user hide the task too (pull path = push path).
    const offers = await heartbeat(server, first);
    expect(offers.body.offers.map((offer) => offer.id)).not.toContain(t3);
    // A different user is unaffected by DEV001's cap.
    expect((await claim(otherUser, t3)).status).toBe(200);

    // Completing one task frees DEV001's slot again.
    const completed = await api(server, `/api/v1/tasks/${t1}/complete`, {
      method: 'POST',
      token: first.token,
      body: { summary: 'done', artifactIds: [], links: [], openQuestions: [] },
    });
    expect(completed.status).toBe(200);
    const t4 = await createTask();
    expect((await claim(first, t4)).status).toBe(200);
  });
});
