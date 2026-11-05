// S3 task transfer integration (docs/003 §2.3/§4.2, task book §1.3/§2):
// the holder ends its lease, the task returns to the pool, the event chain is
// complete, idempotency replays, and no double write is possible.
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
import { openProbe, socketUrl } from './ws-helpers.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer({ overrides: { presenceTtlMs: 10_000 } });
});

afterEach(async () => {
  await server.dispose();
});

interface TaskInput {
  requiredRoles?: string[];
  workspaceBinding?: { repo: string; projectKey?: string; baseBranch?: string } | null;
}

async function createTask(input: TaskInput = {}): Promise<string> {
  const demand = await createDemand(server);
  const created = await createAdminTask(server, {
    demandId: demand.id,
    title: 'S3 转交任务',
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

function transfer(
  executor: RegisteredExecutor,
  taskId: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
) {
  return api<{
    task: { id: string; state: string; requiredRoles: string[] };
    transfer: {
      id: string;
      taskId: string;
      fromUserId: string | null;
      targetUserId: string | null;
      targetRole: string | null;
    };
  }>(server, `/api/v1/tasks/${taskId}/transfer`, {
    method: 'POST',
    token: executor.token,
    body,
    ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
  });
}

async function claimable(executor: RegisteredExecutor, taskId: string): Promise<boolean> {
  const response = await api<{ tasks: Array<{ id: string }> }>(server, '/api/v1/tasks', {
    token: executor.token,
  });
  return response.status === 200 && response.body.tasks.some((task) => task.id === taskId);
}

describe('POST /tasks/{id}/transfer (S3)', () => {
  it('returns the task to the pool, invalidates the old lease and keeps one writer', async () => {
    const holder = await registerExecutor(server, 'DEV001', { roles: ['developer'] });
    const target = await registerExecutor(server, 'DEV002', { roles: ['developer'] });
    await heartbeat(server, holder);
    await heartbeat(server, target);

    const taskId = await createTask({ requiredRoles: ['developer'] });
    expect((await claim(holder, taskId)).status).toBe(200);

    // The target executor is connected: the transfer must re-offer the task.
    const { lastSeq } = await readEvents(server);
    const targetProbe = await openProbe(socketUrl(server.running.url, target.token, lastSeq));
    let transferId: string;
    try {
      const response = await transfer(holder, taskId, { targetUserId: 'DEV002', comment: '交给同事' });
      expect(response.status).toBe(200);
      expect(response.body.task.state).toBe('pending');
      expect(response.body.transfer).toMatchObject({
        taskId,
        fromUserId: 'DEV001',
        targetUserId: 'DEV002',
        targetRole: null,
      });
      transferId = response.body.transfer.id;
      await targetProbe.waitFor(
        (message) => message.type === 'task.offered' && message.subject.id === taskId,
      );
    } finally {
      targetProbe.socket.close();
    }

    // The old lease is gone: every holder write is rejected.
    const renewed = await api(server, `/api/v1/tasks/${taskId}/lease/renew`, {
      method: 'POST',
      token: holder.token,
      body: {},
    });
    expect(renewed.status).toBe(409);
    const released = await api(server, `/api/v1/tasks/${taskId}/release`, {
      method: 'POST',
      token: holder.token,
      body: {},
    });
    expect(released.status).toBe(409);
    const reassigned = await transfer(holder, taskId, { targetUserId: 'DEV002' });
    expect(reassigned.status).toBe(409);

    // The pool is authoritative: the named target can claim it.
    expect(await claimable(target, taskId)).toBe(true);
    const claimed = await claim(target, taskId);
    expect(claimed.status).toBe(200);
    expect((claimed.body as { task: { state: string } }).task.state).toBe('claimed');

    // Event chain: assignment.released(reason=transferred) + task.transferred,
    // in that order, with the audit fields; exactly one writer held the lease.
    const events = await readEvents(server, 0);
    const taskEvents = events.events.filter((event) => event.data['taskId'] === taskId);
    const releasedEvent = taskEvents.find(
      (event) => event.type === 'assignment.released' && event.data['reason'] === 'transferred',
    );
    const transferredEvent = taskEvents.find((event) => event.type === 'task.transferred');
    expect(releasedEvent).toBeDefined();
    expect(transferredEvent).toBeDefined();
    expect(transferredEvent?.data).toMatchObject({
      taskId,
      transferId,
      fromUserId: 'DEV001',
      targetUserId: 'DEV002',
      targetRole: null,
      requiredRoles: ['developer'],
      previousRequiredRoles: ['developer'],
    });
    const sequence = taskEvents.map((event) => event.type);
    expect(sequence[0]).toBe('task.created');
    expect(sequence.filter((type) => type === 'task.claimed')).toHaveLength(2);
    const releasedIndex = sequence.indexOf('assignment.released');
    expect(releasedIndex).toBeGreaterThan(sequence.indexOf('task.claimed'));
    expect(releasedIndex).toBeLessThan(sequence.lastIndexOf('task.claimed'));
    // The holder is down-weighted on the re-offer (lastHolderUserIds, docs/003 §2.3).
    expect(transferredEvent?.data['lastHolderUserIds']).toEqual(['DEV001']);
  });

  it('replays a transfer idempotently with the same key', async () => {
    const holder = await registerExecutor(server, 'DEV001', { roles: [] });
    await heartbeat(server, holder);
    const taskId = await createTask();
    expect((await claim(holder, taskId)).status).toBe(200);

    const key = 'transfer-idem-1';
    const first = await transfer(holder, taskId, { targetUserId: 'DEV002' }, key);
    expect(first.status).toBe(200);
    const replay = await transfer(holder, taskId, { targetRole: 'developer' }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.transfer.id).toBe(first.body.transfer.id);
    expect(replay.headers.get('idempotent-replay')).toBe('true');

    const events = await readEvents(server, 0);
    expect(
      events.events.filter(
        (event) => event.type === 'task.transferred' && event.data['taskId'] === taskId,
      ),
    ).toHaveLength(1);
  });

  it('rejects transferring to the current holder or to a full target user', async () => {
    const holder = await registerExecutor(server, 'DEV001', { roles: [] });
    const fullUser = await registerExecutor(server, 'DEV002', { roles: [] });
    await heartbeat(server, holder);
    await heartbeat(server, fullUser);

    const taskId = await createTask();
    expect((await claim(holder, taskId)).status).toBe(200);
    const toSelf = await transfer(holder, taskId, { targetUserId: 'DEV001' });
    expect(toSelf.status).toBe(409);

    // Fill DEV002 up to the per-user cap (default 2).
    const fullA = await createTask();
    const fullB = await createTask();
    expect((await claim(fullUser, fullA)).status).toBe(200);
    expect((await claim(fullUser, fullB)).status).toBe(200);
    const blocked = await transfer(holder, taskId, { targetUserId: 'DEV002' });
    expect(blocked.status).toBe(409);
    expect(
      (blocked.body as { error?: { details?: { maxConcurrentPerUser?: number } } }).error?.details
        ?.maxConcurrentPerUser,
    ).toBe(2);
  });

  it('rejects a target user whose executors cannot take the required roles', async () => {
    const holder = await registerExecutor(server, 'DEV001', { roles: ['developer'] });
    await registerExecutor(server, 'DEV002', { roles: ['consultant'] });
    await heartbeat(server, holder);
    const taskId = await createTask({ requiredRoles: ['developer'] });
    expect((await claim(holder, taskId)).status).toBe(200);

    const response = await transfer(holder, taskId, { targetUserId: 'DEV002' });
    expect(response.status).toBe(409);
    expect(
      (response.body as { error?: { details?: { requiredRoles?: string[] } } }).error?.details
        ?.requiredRoles,
    ).toEqual(['developer']);
  });

  it('narrows a non-empty role pool only to a role it already contains', async () => {
    const holder = await registerExecutor(server, 'DEV001', { roles: ['developer'] });
    await heartbeat(server, holder);
    const taskId = await createTask({ requiredRoles: ['developer'] });
    expect((await claim(holder, taskId)).status).toBe(200);

    const wrongRole = await transfer(holder, taskId, { targetRole: 'consultant' });
    expect(wrongRole.status).toBe(409);

    const sameRole = await transfer(holder, taskId, { targetRole: 'developer' });
    expect(sameRole.status).toBe(200);
    expect(sameRole.body.task.requiredRoles).toEqual(['developer']);
  });

  it('explicitly narrows an unrestricted task to the target role pool', async () => {
    const holder = await registerExecutor(server, 'DEV001', { roles: ['developer'] });
    const consultant = await registerExecutor(server, 'DEV002', { roles: ['consultant'] });
    const developerOnly = await registerExecutor(server, 'DEV003', { roles: ['developer'] });
    await heartbeat(server, holder);
    await heartbeat(server, consultant);
    await heartbeat(server, developerOnly);

    const taskId = await createTask({ requiredRoles: [] });
    expect((await claim(holder, taskId)).status).toBe(200);

    const response = await transfer(holder, taskId, { targetRole: 'consultant' });
    expect(response.status).toBe(200);
    expect(response.body.task.requiredRoles).toEqual(['consultant']);

    const events = await readEvents(server, 0);
    const transferred = events.events.find(
      (event) => event.type === 'task.transferred' && event.data['taskId'] === taskId,
    );
    expect(transferred?.data).toMatchObject({
      previousRequiredRoles: [],
      requiredRoles: ['consultant'],
      targetRole: 'consultant',
    });

    // Visibility follows the narrowed pool: developer-only executors lose it,
    // consultants gain it (the transfer is a pool change, not a user lock).
    expect(await claimable(developerOnly, taskId)).toBe(false);
    expect(await claimable(consultant, taskId)).toBe(true);
    expect((await claim(consultant, taskId)).status).toBe(200);
  });

  it('rejects transfers without the lease (non-holder, terminal task, unknown task)', async () => {
    const holder = await registerExecutor(server, 'DEV001', { roles: [] });
    const bystander = await registerExecutor(server, 'DEV002', { roles: [] });
    await heartbeat(server, holder);
    await heartbeat(server, bystander);

    const taskId = await createTask();
    // Not claimed yet: nobody holds a lease.
    expect((await transfer(holder, taskId, { targetUserId: 'DEV002' })).status).toBe(409);

    expect((await claim(holder, taskId)).status).toBe(200);
    expect((await transfer(bystander, taskId, { targetUserId: 'DEV002' })).status).toBe(409);

    const completed = await api(server, `/api/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      token: holder.token,
      body: { summary: 'done', artifactIds: [], links: [], openQuestions: [] },
    });
    expect(completed.status).toBe(200);
    expect((await transfer(holder, taskId, { targetUserId: 'DEV002' })).status).toBe(409);

    const unknown = await api(server, '/api/v1/tasks/01J8ZQ9W3K5M2V7X4C6B8N0P1Q/transfer', {
      method: 'POST',
      token: holder.token,
      body: { targetUserId: 'DEV002' },
    });
    expect(unknown.status).toBe(404);
  });

  it('is executor-only: user/admin tokens cannot transfer', async () => {
    const holder = await registerExecutor(server, 'DEV001', { roles: [] });
    await heartbeat(server, holder);
    const taskId = await createTask();
    expect((await claim(holder, taskId)).status).toBe(200);

    const asUser = await api(server, `/api/v1/tasks/${taskId}/transfer`, {
      method: 'POST',
      token: server.userToken,
      body: { targetUserId: 'DEV002' },
    });
    expect(asUser.status).toBe(403);
  });
});
