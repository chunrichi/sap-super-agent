// Activation smoke: wires the extension against the mocked VSCode API and a
// stubbed fetch, proving commands/status bar/tree view/heartbeat can be created
// without a real extension host (docs/009 §1 client layer).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate, setEventSocketFactory } from '../src/extension.js';
import type { SocketLike } from '../src/events.js';
import type { TaskInboxProvider } from '../src/tasksView.js';
import {
  newDemandId,
  newUlid,
  type RegisterExecutorResponse,
  type Task,
} from '@sap-superagent/protocol';
import {
  makeClaimResponse,
  makeContextResponse,
  makeHeartbeatResponse,
  makeRegisterResponse,
  makeSubmitArtifactResponse,
  makeTask,
} from './fixtures.js';
import {
  Uri,
  createMockExtensionContext,
  fireWorkspaceFoldersChanged,
  mockState,
  resetVscodeMock,
  type MockExtensionContext,
} from './mocks/vscode.js';

const NOW = '2026-11-05T00:00:00.000Z';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface StubOptions {
  approvals?: unknown[];
  notifications?: unknown[];
  events?: unknown;
}

function stubControlPlane(
  register: RegisterExecutorResponse,
  tasks: Task[] = [],
  options: StubOptions = {},
): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      const pathname = new URL(url).pathname;
      calls.push(`${method} ${pathname}`);
      if (url.endsWith('/executors/register')) {
        return jsonResponse(register);
      }
      if (pathname === '/api/v1/approvals') {
        return jsonResponse({ approvals: options.approvals ?? [], serverTime: NOW });
      }
      if (pathname === '/api/v1/notifications') {
        return jsonResponse({ notifications: options.notifications ?? [], serverTime: NOW });
      }
      if (pathname === '/api/v1/events') {
        return jsonResponse(
          options.events ?? { events: [], lastSeq: 0, earliestSeq: 0 },
        );
      }
      if (pathname.endsWith('/decisions')) {
        return jsonResponse({ approval: (options.approvals ?? [])[0], serverTime: NOW });
      }
      if (pathname.endsWith('/read')) {
        return jsonResponse({ notification: (options.notifications ?? [])[0], serverTime: NOW });
      }
      if (url.endsWith('/heartbeat')) {
        return jsonResponse(makeHeartbeatResponse());
      }
      if (pathname.includes('/executors/') && method === 'DELETE') {
        return jsonResponse({ releasedTaskIds: [], serverTime: NOW });
      }
      if (pathname === '/api/v1/tasks') {
        return jsonResponse({ tasks, serverTime: NOW });
      }
      if (pathname.endsWith('/release')) {
        const releaseId = /\/tasks\/([^/]+)\/release/.exec(pathname)?.[1];
        const releaseTask = tasks.find((candidate) => candidate.id === releaseId) ?? makeTask();
        return jsonResponse({ task: { ...releaseTask, state: 'pending' }, serverTime: NOW });
      }
      const taskId = /\/tasks\/([^/]+)/.exec(pathname)?.[1];
      const task = tasks.find((candidate) => candidate.id === taskId) ?? makeTask();
      if (pathname.endsWith('/claim')) {
        return jsonResponse(makeClaimResponse(task));
      }
      if (pathname.endsWith('/context')) {
        return jsonResponse(makeContextResponse(task));
      }
      if (pathname.endsWith('/artifacts')) {
        return jsonResponse(makeSubmitArtifactResponse(task));
      }
      if (pathname.endsWith('/complete')) {
        return jsonResponse({ task: { ...task, state: 'completed' }, serverTime: NOW });
      }
      return jsonResponse({ tasks: [], serverTime: NOW });
    }),
  );
  return calls;
}

async function activateExtension(folder?: string): Promise<MockExtensionContext> {
  return activateExtensionIn(folder ?? (await makeFolder()));
}

const tempDirs: string[] = [];

async function makeFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sa-vscode-ext-'));
  tempDirs.push(dir);
  return dir;
}

async function activateExtensionIn(folder: string): Promise<MockExtensionContext> {
  mockState.workspaceFolders = [{ uri: Uri.file(folder), name: 'z-sales', index: 0 }];
  const context = createMockExtensionContext();
  await activate(context as unknown as Parameters<typeof activate>[0]);
  return context;
}

afterEach(async () => {
  await deactivate();
  setEventSocketFactory(undefined);
  vi.unstubAllGlobals();
  process.env['SAP_SUPERAGENT_TOKEN'] = '';
  resetVscodeMock();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('extension activation', () => {
  it('registers the six commands, the inbox view and comes online with a token', async () => {
    const register = makeRegisterResponse({ user: 'dev' });
    const calls = stubControlPlane(register);
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';

    const context = await activateExtension();

    expect([...mockState.registeredCommands.keys()].sort()).toEqual([
      'sapSuperAgent.approvalAction',
      'sapSuperAgent.bindWorkspace',
      'sapSuperAgent.claimTask',
      'sapSuperAgent.connect',
      'sapSuperAgent.openTask',
      'sapSuperAgent.readNotification',
      'sapSuperAgent.submitArtifact',
      'sapSuperAgent.toggleAccepting',
    ]);
    expect(mockState.treeViews).toHaveLength(1);
    expect(mockState.statusBarItems[0]?.text).toContain('在线');
    // Register with the user token, then heartbeat with the exchanged token.
    expect(calls).toContain('POST /api/v1/executors/register');
    expect(calls.some((call) => call.endsWith('/heartbeat'))).toBe(true);
    // Token is never persisted to workspace files.
    expect(await context.secrets.get('sapSuperAgent.token')).toBeUndefined();
  });

  it('stays offline without a token and does not call the control plane', async () => {
    const calls = stubControlPlane(makeRegisterResponse());
    process.env['SAP_SUPERAGENT_TOKEN'] = '';

    await activateExtension();

    expect(mockState.statusBarItems[0]?.text).toContain('离线');
    expect(calls).toEqual([]);
  });

  it('toggles accepting from the status bar command', async () => {
    stubControlPlane(makeRegisterResponse());
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    await activateExtension();

    await mockState.registeredCommands.get('sapSuperAgent.toggleAccepting')?.();

    expect(mockState.configUpdates).toContainEqual(
      expect.objectContaining({ section: 'sapSuperAgent.accepting', value: false }),
    );
    expect(mockState.statusBarItems[0]?.text).toContain('已暂停');
  });

  it('unregisters best-effort on deactivate', async () => {
    const calls = stubControlPlane(makeRegisterResponse());
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    await activateExtension();

    await deactivate();

    expect(calls.some((call) => call.startsWith('DELETE /api/v1/executors/'))).toBe(true);
  });

  it('claims, opens the context pack and submits an artifact from the inbox', async () => {
    const folder = await makeFolder();
    const task = makeTask({ title: '取数实现' });
    const calls = stubControlPlane(makeRegisterResponse(), [task]);
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    await activateExtension(folder);

    // Tree click on an available task → claim → write context pack → open it.
    await mockState.registeredCommands.get('sapSuperAgent.claimTask')?.(task);

    const contextPath = path.join(folder, '.sap-superagent', 'task', task.id, 'context.md');
    expect(await readFile(contextPath, 'utf8')).toContain('任务上下文');
    expect(calls).toContain(`POST /api/v1/tasks/${task.id}/claim`);
    expect(mockState.informationMessages.some((entry) => entry.message.includes('已领取'))).toBe(true);

    // Submit artifact, then accept the "完成任务" prompt.
    mockState.inputBoxResponses.push('smoke artifact');
    mockState.informationMessageResponse = '完成任务';
    await mockState.registeredCommands.get('sapSuperAgent.submitArtifact')?.(task);

    expect(calls).toContain(`POST /api/v1/tasks/${task.id}/artifacts`);
    expect(calls).toContain(`POST /api/v1/tasks/${task.id}/complete`);
    expect(mockState.informationMessages.some((entry) => entry.message.includes('任务已完成'))).toBe(true);
  });
});

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Array<(payload?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  on(event: 'open' | 'message' | 'close' | 'error', listener: (payload?: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }

  emit(event: 'open' | 'message' | 'close' | 'error', payload?: unknown): void {
    if (event === 'open') this.readyState = 1;
    for (const listener of [...(this.handlers.get(event) ?? [])]) listener(payload);
  }

  message(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }
}

function makeApproval() {
  return {
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
}

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: newUlid(),
    demandId: newDemandId(),
    stageRunId: null,
    approvalId: null,
    kind: 'stage.waiting_human',
    requiredRole: 'developer',
    title: '阶段等待人工确认',
    body: '请确认输出',
    createdAt: '2026-11-05T00:00:01.000Z',
    readAt: null,
    ...overrides,
  };
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  }
}

async function waitForCall(calls: string[], needle: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (calls.some((call) => call.includes(needle))) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  throw new Error(`timed out waiting for ${needle}; calls=${calls.join(', ')}`);
}

describe('等待我回答 group + realtime updates (S3)', () => {
  it('shows pending gates and unread notifications, counted in the status bar', async () => {
    const approval = makeApproval();
    const notification = makeNotification();
    stubControlPlane(makeRegisterResponse({ user: 'dev' }), [], {
      approvals: [approval],
      notifications: [notification],
    });
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';

    await activateExtension();
    await flush();
    const provider = mockState.treeViews[0]?.treeDataProvider as TaskInboxProvider;
    const groups = provider.getChildren();
    expect(groups[2]).toMatchObject({ kind: 'group', group: 'waiting', count: 2 });
    const waiting = provider.getChildren(groups[2]!);
    expect(waiting.map((node) => (node.kind === 'waiting' ? node.label : 'group'))).toEqual([
      '审批 G1 · consultant',
      '阶段等待人工确认',
    ]);
    expect(mockState.statusBarItems[0]?.text).toContain('在线 2');
  });

  it('decides a gate from the inbox and refreshes the group', async () => {
    const approval = makeApproval();
    const calls = stubControlPlane(makeRegisterResponse({ user: 'dev' }), [], {
      approvals: [approval],
    });
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    await activateExtension();

    mockState.quickPickResponses.push({ label: '通过', description: 'approve', decision: 'approve' });
    mockState.inputBoxResponses.push('需求清晰');
    await mockState.registeredCommands.get('sapSuperAgent.approvalAction')?.(approval);

    expect(calls).toContain(`POST /api/v1/approvals/${approval.id}/decisions`);
    expect(mockState.informationMessages.some((entry) => entry.message.includes('审批已提交'))).toBe(
      true,
    );
  });

  it('marks a notification read from the inbox', async () => {
    const notification = makeNotification();
    const calls = stubControlPlane(makeRegisterResponse({ user: 'dev' }), [], {
      notifications: [notification],
    });
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    await activateExtension();

    await mockState.registeredCommands.get('sapSuperAgent.readNotification')?.(notification);

    expect(calls).toContain(`POST /api/v1/notifications/${notification.id}/read`);
  });

  it('refreshes the inbox on a live WS event and persists the cursor in globalState', async () => {
    const task = makeTask({ title: '实时任务' });
    const calls = stubControlPlane(makeRegisterResponse({ user: 'dev' }), [task]);
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    setEventSocketFactory((url) => new FakeSocket(url));

    const context = await activateExtension();
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    expect(socket.url).toContain('/api/v1/events');
    expect(socket.url).toContain('token=executor-token');
    socket.emit('open');
    await flush();
    const taskFetchesBefore = calls.filter((call) => call === 'GET /api/v1/tasks').length;

    socket.message({
      seq: 12,
      id: newUlid(),
      type: 'task.updated',
      at: NOW,
      subject: { type: 'task', id: task.id },
      data: { state: 'pending' },
    });
    await flush();
    expect(calls.filter((call) => call === 'GET /api/v1/tasks').length).toBeGreaterThan(
      taskFetchesBefore,
    );
    expect(context.globalState.get('sapSuperAgent.lastEventSeq')).toBe(12);
  });

  it('does a full REST pull when the server sends resync_required', async () => {
    const calls = stubControlPlane(makeRegisterResponse({ user: 'dev' }), [], {
      events: { events: [], lastSeq: 42, earliestSeq: 30 },
    });
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    setEventSocketFactory((url) => new FakeSocket(url));

    const context = await activateExtension();
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    socket.emit('open');
    await flush();

    socket.message({ type: 'resync_required', lastSeq: 42, earliestSeq: 30 });
    await flush();
    expect(calls.some((call) => call.startsWith('GET /api/v1/events'))).toBe(true);
    expect(context.globalState.get('sapSuperAgent.lastEventSeq')).toBe(42);
  });

  it('releases held tasks immediately when the workspace folder changes', async () => {
    const firstFolder = await makeFolder();
    const task = makeTask({ title: '工作区任务' });
    const calls = stubControlPlane(makeRegisterResponse({ user: 'dev' }), [task]);
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    await activateExtension(firstFolder);

    await mockState.registeredCommands.get('sapSuperAgent.claimTask')?.(task);
    expect(calls).toContain(`POST /api/v1/tasks/${task.id}/claim`);

    const secondFolder = await makeFolder();
    mockState.workspaceFolders = [{ uri: Uri.file(secondFolder), name: 'other', index: 0 }];
    fireWorkspaceFoldersChanged();
    await waitForCall(calls, `/tasks/${task.id}/release`);
    expect(mockState.informationMessages.some((entry) => entry.message.includes('已释放'))).toBe(true);
  });

  it('blocks the claim instead of writing when preflight fails', async () => {
    const task = makeTask({ title: '受限工作区任务' });
    const calls = stubControlPlane(makeRegisterResponse({ user: 'dev' }), [task]);
    process.env['SAP_SUPERAGENT_TOKEN'] = 'user-token';
    await activateExtension();
    mockState.workspaceTrusted = false;

    await mockState.registeredCommands.get('sapSuperAgent.claimTask')?.(task);

    expect(calls).not.toContain(`POST /api/v1/tasks/${task.id}/claim`);
    expect(mockState.warningMessages.some((message) => message.includes('受限模式'))).toBe(true);
  });
});
