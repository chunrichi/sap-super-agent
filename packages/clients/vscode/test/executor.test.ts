import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneError } from '../src/client.js';
import { ExecutorRuntime, type ExecutorControlPlane, type ExecutorRuntimeOptions } from '../src/executor.js';
import {
  makeHeartbeatResponse,
  makeLeaseRenewResponse,
  makeRegisterResponse,
  makeTask,
} from './fixtures.js';

const WORKSPACE = { workspaceKey: 'wk-1', repo: 'z-sales' };

function makeFakeClient(overrides: Partial<ExecutorControlPlane> = {}): ExecutorControlPlane {
  return {
    registerExecutor: vi.fn(async () => makeRegisterResponse()),
    heartbeat: vi.fn(async () => makeHeartbeatResponse()),
    renewLease: vi.fn(async () => makeLeaseRenewResponse()),
    unregister: vi.fn(async () => ({ releasedTaskIds: [], serverTime: '2026-11-05T00:00:00.000Z' })),
    ...overrides,
  };
}

interface Harness {
  runtime: ExecutorRuntime;
  client: ExecutorControlPlane;
  scheduled: number[];
  errors: string[];
  leaseLost: string[];
}

function makeHarness(overrides: Partial<ExecutorRuntimeOptions> = {}): Harness {
  const scheduled: number[] = [];
  const errors: string[] = [];
  const leaseLost: string[] = [];
  const client = overrides.client ?? makeFakeClient();
  const runtime = new ExecutorRuntime({
    client,
    user: 'dev',
    machineIdHash: 'machine-hash',
    workspace: WORKSPACE,
    roles: ['developer'],
    onError: (message) => {
      errors.push(message);
    },
    onLeaseLost: (taskId) => {
      leaseLost.push(taskId);
    },
    setTimer: (_callback, delayMs) => {
      scheduled.push(delayMs);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
    ...overrides,
  });
  return { runtime, client, scheduled, errors, leaseLost };
}

describe('ExecutorRuntime registration', () => {
  it('registers as a vscode executor with the active workspace and schedules the first beat', async () => {
    const { runtime, client, scheduled } = makeHarness();

    const state = await runtime.start();

    expect(client.registerExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'vscode',
        user: 'dev',
        machineIdHash: 'machine-hash',
        workspaces: [WORKSPACE],
        protocolVersion: '1',
      }),
    );
    expect(state.connection).toBe('online');
    expect(state.executorId).not.toBeNull();
    expect(scheduled).toEqual([20_000]);
  });

  it('does not schedule beats when registration fails and reports an actionable error', async () => {
    const client = makeFakeClient({
      registerExecutor: vi.fn(async () => {
        throw new ControlPlaneError('token invalid', { status: 401, code: 'unauthorized' });
      }),
    });
    const { runtime, scheduled, errors } = makeHarness({ client });

    const state = await runtime.start();

    expect(state.connection).toBe('offline');
    expect(scheduled).toEqual([]);
    expect(errors[0]).toContain('token');
  });
});

describe('ExecutorRuntime heartbeats', () => {
  it('reports away while accepting=false and carries activeWorkspaceKey', async () => {
    const { runtime, client } = makeHarness();
    await runtime.start();
    runtime.setAccepting(false);
    runtime.setActiveTasks(['task-1']);

    await runtime.heartbeatOnce();

    expect(client.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'away',
        load: 1,
        activeWorkspaceKey: 'wk-1',
        workspaces: [WORKSPACE],
      }),
    );
  });

  it('reports busy when a lease is held', async () => {
    const { runtime, client } = makeHarness();
    await runtime.start();
    runtime.setActiveTasks(['task-1']);

    await runtime.heartbeatOnce();

    expect(client.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ status: 'busy', load: 1 }));
  });

  it('publishes offers and keeps the 20s cadence on success', async () => {
    const task = makeTask();
    const offers = [
      {
        id: task.id,
        demandId: task.demandId,
        title: task.title,
        executorKind: 'vscode' as const,
        requiredRoles: task.requiredRoles,
        workspaceBinding: task.workspaceBinding,
        priority: task.priority,
        dueAt: task.dueAt,
      },
    ];
    const client = makeFakeClient({ heartbeat: vi.fn(async () => makeHeartbeatResponse(offers)) });
    const onOffers = vi.fn();
    const { runtime, scheduled } = makeHarness({ client, onOffers });
    await runtime.start();

    const state = await runtime.heartbeatOnce();

    expect(state.offers).toEqual(offers);
    expect(onOffers).toHaveBeenCalledWith(offers);
    expect(scheduled).toEqual([20_000, 20_000]);
  });

  it('renews every held lease before beating', async () => {
    const { runtime, client } = makeHarness();
    await runtime.start();
    runtime.setActiveTasks(['task-1', 'task-2']);

    await runtime.heartbeatOnce();

    expect(client.renewLease).toHaveBeenNthCalledWith(1, 'task-1');
    expect(client.renewLease).toHaveBeenNthCalledWith(2, 'task-2');
  });

  it('drops a task whose lease is gone instead of stopping the executor', async () => {
    const client = makeFakeClient({
      renewLease: vi.fn(async () => {
        throw new ControlPlaneError('lease expired', { status: 409, code: 'lease_expired' });
      }),
    });
    const { runtime, leaseLost } = makeHarness({ client });
    await runtime.start();
    runtime.setActiveTasks(['task-1']);

    const state = await runtime.heartbeatOnce();

    expect(leaseLost).toEqual(['task-1']);
    expect(state.activeTaskIds).toEqual([]);
    expect(state.connection).toBe('online');
  });
});

describe('ExecutorRuntime stop conditions', () => {
  it('pauses on 401 heartbeat failures and stops renewing', async () => {
    const client = makeFakeClient({
      heartbeat: vi.fn(async () => {
        throw new ControlPlaneError('token revoked', { status: 401, code: 'unauthorized' });
      }),
    });
    const { runtime, scheduled, errors } = makeHarness({ client });

    const state = await runtime.start();

    expect(state.connection).toBe('paused');
    expect(state.lastError).toContain('token revoked');
    // Paused means no further beats are scheduled at all.
    expect(scheduled).toEqual([]);
    expect(errors.some((message) => message.includes('请重新连接控制平面'))).toBe(true);
  });

  it('pauses when the control plane is unreachable', async () => {
    const client = makeFakeClient({
      heartbeat: vi.fn(async () => {
        throw new ControlPlaneError('fetch failed', { status: 0, code: 'network_error', retryable: true });
      }),
    });
    const { runtime } = makeHarness({ client });
    await runtime.start();

    const state = await runtime.heartbeatOnce();

    expect(state.connection).toBe('paused');
  });

  it('keeps retrying with backoff on retryable server errors', async () => {
    const client = makeFakeClient({
      heartbeat: vi.fn(async () => {
        throw new ControlPlaneError('boom', { status: 500, code: 'internal_error', retryable: true });
      }),
    });
    const { runtime, scheduled } = makeHarness({ client });
    await runtime.start();

    const state = await runtime.heartbeatOnce();

    expect(state.connection).toBe('online');
    // 500 on the register-triggered beat backs off to 40s; the next failure
    // doubles again and is capped at 60s.
    expect(scheduled).toEqual([40_000, 60_000]);
  });

  it('unregisters on stop and returns to offline', async () => {
    const { runtime, client } = makeHarness();
    await runtime.start();

    await runtime.stop({ unregister: true });

    expect(client.unregister).toHaveBeenCalledTimes(1);
    expect(runtime.currentState.connection).toBe('offline');
  });
});
