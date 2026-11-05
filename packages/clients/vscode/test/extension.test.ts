// Activation smoke: wires the extension against the mocked VSCode API and a
// stubbed fetch, proving commands/status bar/tree view/heartbeat can be created
// without a real extension host (docs/009 §1 client layer).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate } from '../src/extension.js';
import type { RegisterExecutorResponse, Task } from '@sap-superagent/protocol';
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

function stubControlPlane(register: RegisterExecutorResponse, tasks: Task[] = []): string[] {
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
      if (url.endsWith('/heartbeat')) {
        return jsonResponse(makeHeartbeatResponse());
      }
      if (pathname.includes('/executors/') && method === 'DELETE') {
        return jsonResponse({ releasedTaskIds: [], serverTime: NOW });
      }
      if (pathname === '/api/v1/tasks') {
        return jsonResponse({ tasks, serverTime: NOW });
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
      'sapSuperAgent.bindWorkspace',
      'sapSuperAgent.claimTask',
      'sapSuperAgent.connect',
      'sapSuperAgent.openTask',
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
