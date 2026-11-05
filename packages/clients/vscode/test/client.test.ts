import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDemandId, newUlid } from '@sap-superagent/protocol';
import { ControlPlaneClient, ControlPlaneError } from '../src/client.js';
import {
  makeClaimResponse,
  makeContextResponse,
  makeHeartbeatResponse,
  makeLeaseRenewResponse,
  makeRegisterResponse,
  makeSubmitArtifactResponse,
  makeTask,
} from './fixtures.js';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

let calls: RecordedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return handler(url, init ?? {});
    }),
  );
}

function headersOf(call: RecordedCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function newClient(): ControlPlaneClient {
  return new ControlPlaneClient({ baseUrl: 'http://127.0.0.1:3080', token: 'test-token' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
});

describe('ControlPlaneClient request shapes', () => {
  it('registerExecutor POSTs the executor body with the bearer token', async () => {
    const fixture = makeRegisterResponse();
    stubFetch(() => jsonResponse(fixture));
    const client = newClient();

    const response = await client.registerExecutor({
      kind: 'vscode',
      user: 'dev',
      capabilities: ['coding'],
      roles: ['developer'],
      workspaces: [{ workspaceKey: 'wk-1', repo: 'z-sales' }],
      protocolVersion: '1',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:3080/api/v1/executors/register');
    expect(call.init.method).toBe('POST');
    expect(headersOf(call)['authorization']).toBe('Bearer test-token');
    expect(bodyOf(call)).toMatchObject({ kind: 'vscode', user: 'dev', protocolVersion: '1' });
    expect(response.executor.id).toBe(fixture.executor.id);
    expect(client.registeredExecutorId).toBe(fixture.executor.id);
  });

  it('registers with the user token and then uses the returned executor token', async () => {
    const register = makeRegisterResponse();
    stubFetch((url) =>
      url.endsWith('/register') ? jsonResponse(register) : jsonResponse(makeHeartbeatResponse()),
    );
    const client = new ControlPlaneClient({ baseUrl: 'http://127.0.0.1:3080', token: 'user-token' });

    await client.registerExecutor({
      kind: 'vscode',
      user: 'dev',
      capabilities: [],
      roles: [],
      workspaces: [],
      protocolVersion: '1',
    });
    await client.heartbeat({ status: 'online', load: 0 });

    expect(headersOf(calls[0]!)['authorization']).toBe('Bearer user-token');
    expect(headersOf(calls[1]!)['authorization']).toBe('Bearer executor-token');

    // A reconnect goes back to the login token for registration.
    client.setBaseToken('user-token-2');
    expect(headersOf(calls[1]!)['authorization']).toBe('Bearer executor-token');
  });

  it('heartbeat targets the registered executor and reports activeWorkspaceKey', async () => {
    const register = makeRegisterResponse();
    stubFetch((url) =>
      url.endsWith('/heartbeat') ? jsonResponse(makeHeartbeatResponse()) : jsonResponse(register),
    );
    const client = newClient();
    await client.registerExecutor({
      kind: 'vscode',
      user: 'dev',
      capabilities: [],
      roles: [],
      workspaces: [],
      protocolVersion: '1',
    });

    await client.heartbeat({
      status: 'away',
      load: 1,
      workspaces: [{ workspaceKey: 'wk-1', repo: 'z-sales' }],
      activeWorkspaceKey: 'wk-1',
    });

    const heartbeat = calls[1]!;
    expect(heartbeat.url).toBe(
      `http://127.0.0.1:3080/api/v1/executors/${register.executor.id}/heartbeat`,
    );
    expect(bodyOf(heartbeat)).toMatchObject({
      status: 'away',
      load: 1,
      activeWorkspaceKey: 'wk-1',
    });
  });

  it('claim POSTs with an idempotency key and parses the lease', async () => {
    const task = makeTask();
    const claim = makeClaimResponse(task);
    stubFetch(() => jsonResponse(claim));
    const client = newClient();

    const response = await client.claim(task.id);

    const call = calls[0]!;
    expect(call.url).toBe(`http://127.0.0.1:3080/api/v1/tasks/${task.id}/claim`);
    expect(call.init.method).toBe('POST');
    expect(headersOf(call)['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.lease.renewIntervalMs).toBe(20000);
  });

  it('renewLease hits /lease/renew and returns the new expiry', async () => {
    const task = makeTask();
    stubFetch(() => jsonResponse(makeLeaseRenewResponse()));
    const client = newClient();

    const response = await client.renewLease(task.id);

    expect(calls[0]!.url).toBe(
      `http://127.0.0.1:3080/api/v1/tasks/${task.id}/lease/renew`,
    );
    expect(response.lease.expiresAt).toBe('2026-11-05T00:00:00.000Z');
  });

  it('getContext GETs the context URL and returns markdown + json', async () => {
    const task = makeTask();
    stubFetch(() => jsonResponse(makeContextResponse(task)));
    const client = newClient();

    const response = await client.getContext(task.id);

    expect(calls[0]!.url).toBe(`http://127.0.0.1:3080/api/v1/tasks/${task.id}/context`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(response.markdown).toContain('任务上下文');
    expect(response.json.task.id).toBe(task.id);
  });

  it('listTasks sends the state/limit query', async () => {
    stubFetch(() => jsonResponse({ tasks: [], serverTime: '2026-11-05T00:00:00.000Z' }));
    const client = newClient();

    await client.listTasks({ state: 'pending', limit: 5 });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/tasks');
    expect(url.searchParams.get('state')).toBe('pending');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('submitArtifact posts the declared body and parses the version', async () => {
    const task = makeTask();
    stubFetch(() => jsonResponse(makeSubmitArtifactResponse(task)));
    const client = newClient();

    const response = await client.submitArtifact(task.id, {
      kind: 'code_change',
      contentType: 'text/markdown',
      contentBase64: Buffer.from('hello').toString('base64'),
      checksum: `sha256:${'a'.repeat(64)}`,
      summary: '实现取数',
    });

    const call = calls[0]!;
    expect(call.url).toBe(`http://127.0.0.1:3080/api/v1/tasks/${task.id}/artifacts`);
    expect(bodyOf(call)).toMatchObject({ kind: 'code_change', contentType: 'text/markdown' });
    expect(response.version.version).toBe(1);
  });

  it('complete/release/unregister target the right paths', async () => {
    const task = makeTask();
    const register = makeRegisterResponse();
    stubFetch((url) => {
      if (url.endsWith('/register')) {
        return jsonResponse(register);
      }
      if (url.endsWith('/complete')) {
        return jsonResponse({ task: { ...task, state: 'completed' }, serverTime: '2026-11-05T00:00:00.000Z' });
      }
      if (url.endsWith('/release')) {
        return jsonResponse({ task, serverTime: '2026-11-05T00:00:00.000Z' });
      }
      return jsonResponse({ releasedTaskIds: [task.id], serverTime: '2026-11-05T00:00:00.000Z' });
    });
    const client = newClient();
    await client.registerExecutor({
      kind: 'vscode',
      user: 'dev',
      capabilities: [],
      roles: [],
      workspaces: [],
      protocolVersion: '1',
    });

    await client.complete(task.id, { summary: 'done', artifactIds: [], links: [], openQuestions: [] });
    await client.release(task.id);
    await client.unregister();

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v1/executors/register',
      `/api/v1/tasks/${task.id}/complete`,
      `/api/v1/tasks/${task.id}/release`,
      `/api/v1/executors/${register.executor.id}`,
    ]);
    expect(calls[3]!.init.method).toBe('DELETE');
    expect(client.registeredExecutorId).toBeNull();
  });
});

describe('ControlPlaneClient error mapping', () => {
  it('maps a 409 protocol error to ControlPlaneError(conflict, non-retryable)', async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'conflict', message: '任务已被领取', retryable: false } },
        409,
      ),
    );
    const client = newClient();

    const error = await client.claim('01J8ZQ6ZK8V6R8T2F9M1N3P4Q5').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ControlPlaneError);
    const controlPlaneError = error as ControlPlaneError;
    expect(controlPlaneError.status).toBe(409);
    expect(controlPlaneError.code).toBe('conflict');
    expect(controlPlaneError.message).toBe('任务已被领取');
    expect(controlPlaneError.retryable).toBe(false);
  });

  it('maps a 401 to unauthorized so presence can pause', async () => {
    stubFetch(() =>
      jsonResponse({ error: { code: 'unauthorized', message: 'token 过期', retryable: false } }, 401),
    );
    const client = newClient();

    const error = (await client
      .listTasks()
      .catch((caught: unknown) => caught)) as ControlPlaneError;

    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthorized');
  });

  it('maps a transport failure to a retryable network error', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = newClient();

    const error = (await client
      .listTasks()
      .catch((caught: unknown) => caught)) as ControlPlaneError;

    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error.status).toBe(0);
    expect(error.code).toBe('network_error');
    expect(error.retryable).toBe(true);
  });

  it('rejects contract-violating success bodies as invalid_response', async () => {
    stubFetch(() => jsonResponse({ nope: true }));
    const client = newClient();

    const error = (await client
      .claim('01J8ZQ6ZK8V6R8T2F9M1N3P4Q5')
      .catch((caught: unknown) => caught)) as ControlPlaneError;

    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error.code).toBe('invalid_response');
    expect(error.retryable).toBe(false);
  });

  it('falls back to a status-derived code for non-JSON errors', async () => {
    stubFetch(() => new Response('bad gateway', { status: 502 }));
    const client = newClient();

    const error = (await client
      .listTasks()
      .catch((caught: unknown) => caught)) as ControlPlaneError;

    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('internal_error');
    expect(error.retryable).toBe(true);
  });
});

describe('approvals, notifications and event cursor (S3)', () => {
  const NOW = '2026-11-05T00:00:00.000Z';
  const approval = {
    id: newUlid(),
    demandId: newDemandId(),
    stageRunId: newUlid(),
    gateKey: 'G1',
    artifactId: newUlid(),
    artifactVersion: 1,
    state: 'pending',
    requiredRole: 'consultant',
    decision: null,
    decidedBy: null,
    decidedAt: null,
    comment: null,
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const notification = {
    id: newUlid(),
    demandId: approval.demandId,
    stageRunId: null,
    approvalId: approval.id,
    kind: 'approval.requested',
    requiredRole: 'consultant',
    title: 'G1 待审批',
    body: null,
    createdAt: NOW,
    readAt: null,
  };

  it('lists pending approvals for me', async () => {
    stubFetch(() => jsonResponse({ approvals: [approval], serverTime: NOW }));
    const client = newClient();

    const response = await client.listApprovals({ assignee: 'me', state: 'pending' });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/approvals');
    expect(url.searchParams.get('assignee')).toBe('me');
    expect(url.searchParams.get('state')).toBe('pending');
    expect(response.approvals[0]?.gateKey).toBe('G1');
  });

  it('decides an approval with a comment', async () => {
    stubFetch(() =>
      jsonResponse({
        approval: { ...approval, state: 'approved', decision: 'approve', decidedBy: 'dev' },
        serverTime: NOW,
      }),
    );
    const client = newClient();

    const response = await client.decideApproval(approval.id, {
      decision: 'approve',
      comment: '需求清晰',
    });

    expect(calls[0]!.url).toBe(
      `http://127.0.0.1:3080/api/v1/approvals/${approval.id}/decisions`,
    );
    expect(bodyOf(calls[0]!)).toEqual({ decision: 'approve', comment: '需求清晰' });
    expect(response.approval.state).toBe('approved');
  });

  it('lists unread notifications and marks one read', async () => {
    stubFetch((url) =>
      url.endsWith('/read')
        ? jsonResponse({ notification: { ...notification, readAt: NOW }, serverTime: NOW })
        : jsonResponse({ notifications: [notification], serverTime: NOW }),
    );
    const client = newClient();

    const listed = await client.listNotifications({ state: 'unread' });
    expect(new URL(calls[0]!.url).searchParams.get('state')).toBe('unread');
    expect(listed.notifications).toHaveLength(1);

    const read = await client.markNotificationRead(notification.id);
    expect(calls[1]!.url).toBe(
      `http://127.0.0.1:3080/api/v1/notifications/${notification.id}/read`,
    );
    expect(calls[1]!.init.method).toBe('POST');
    expect(read.notification.readAt).toBe(NOW);
  });

  it('replays events over REST with the cursor', async () => {
    stubFetch(() => jsonResponse({ events: [], lastSeq: 42, earliestSeq: 1 }));
    const client = newClient();

    const response = await client.listEvents(17, 100);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/events');
    expect(url.searchParams.get('after')).toBe('17');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(response.lastSeq).toBe(42);
  });

  it('exposes a ws URL that carries the exchanged executor token', async () => {
    stubFetch(() => jsonResponse(makeRegisterResponse()));
    const client = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:3080',
      token: 'user-token',
    });

    expect(new URL(client.eventStreamUrl()).searchParams.get('token')).toBe('user-token');
    await client.registerExecutor({
      kind: 'vscode',
      user: 'dev',
      capabilities: [],
      roles: [],
      workspaces: [],
      protocolVersion: '1',
    });
    const url = new URL(client.eventStreamUrl());
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/api/v1/events');
    expect(url.searchParams.get('token')).toBe('executor-token');
  });
});
