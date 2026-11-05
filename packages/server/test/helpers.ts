import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeModelProvider } from '@sap-superagent/ai';
import type { EventEnvelope } from '@sap-superagent/protocol';
import {
  issueToken,
  loadOrCreateStateSecret,
  startServer,
  type RunningServer,
  type ServerOptions,
} from '../src/index.js';

export const TEMPLATES_DIR = resolve(process.cwd(), '../../templates');

export interface TestServer {
  running: RunningServer;
  stateDir: string;
  secret: string;
  userToken: string;
  adminToken: string;
  dispose(): Promise<void>;
}

export interface StartTestServerOptions {
  stateDir?: string;
  secret?: string;
  overrides?: Partial<ServerOptions>;
}

export async function startTestServer(
  options: StartTestServerOptions = {},
): Promise<TestServer> {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'sa-server-test-'));
  const secret = options.secret ?? loadOrCreateStateSecret(stateDir);
  const running = await startServer({
    stateDir,
    templatesDir: TEMPLATES_DIR,
    port: 0,
    aiProvider: new FakeModelProvider(),
    leaseTtlMs: 1_000,
    presenceTtlMs: 1_000,
    heartbeatSweepMs: 20,
    stagePollMs: 20,
    ...options.overrides,
  });
  return {
    running,
    stateDir,
    secret,
    userToken: issueToken({ kind: 'user', sub: 'user-1', secret }),
    adminToken: issueToken({ kind: 'admin', sub: 'admin-1', secret }),
    dispose: async () => {
      await running.close();
      if (options.stateDir === undefined) rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = unknown>(
  server: TestServer | RunningServer,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse<T>> {
  const url = 'running' in server ? server.running.url : server.url;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length === 0 ? undefined : JSON.parse(text)) as T,
    headers: response.headers,
  };
}

export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`timed out waiting for ${options.label ?? 'condition'}`);
}

export async function readEvents(
  server: TestServer,
  after = 0,
): Promise<{ events: EventEnvelope[]; lastSeq: number; earliestSeq: number }> {
  const response = await api<{
    events: EventEnvelope[];
    lastSeq: number;
    earliestSeq: number;
  }>(server, `/api/v1/events?after=${after}`, { token: server.userToken });
  if (response.status !== 200) {
    throw new Error(`events request failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export interface CreatedDemand {
  demandId: string;
  artifactId: string;
}

/** Create a demand through the API and wait until the AI stage produced its artifact. */
export async function createDemandWithArtifact(
  server: TestServer,
  title = 'R-9001 取数逻辑',
): Promise<CreatedDemand> {
  const created = await api<{ demand: { id: string } }>(server, '/api/v1/demands', {
    method: 'POST',
    token: server.userToken,
    body: {
      title,
      description: '按销售组织汇总开票金额，空结果返回 0',
      acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
      priority: 'normal',
      requester: { userId: 'DEV001', orgUnit: 'PDO' },
    },
  });
  if (created.status !== 200) {
    throw new Error(`createDemand failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const demandId = created.body.demand.id;
  const artifactId = await waitFor(
    async () => {
      const detail = await api<{
        artifacts: Array<{ id: string; kind: string }>;
      }>(server, `/api/v1/demands/${demandId}`, { token: server.userToken });
      if (detail.status !== 200) return undefined;
      const artifact = detail.body.artifacts.find(
        (candidate) => candidate.kind === 'requirement_analysis',
      );
      return artifact?.id;
    },
    { label: 'requirement_analysis artifact' },
  );
  return { demandId, artifactId };
}

export function createAdminTask(
  server: TestServer,
  body: Record<string, unknown>,
): Promise<ApiResponse<{ task: { id: string; state: string } }>> {
  return api(server, '/api/v1/admin/tasks', {
    method: 'POST',
    token: server.adminToken,
    body,
  });
}

export interface RegisteredExecutor {
  executorId: string;
  token: string;
}

export async function registerExecutor(
  server: TestServer,
  user: string,
  options: { workspaceKey?: string; repo?: string } = {},
): Promise<RegisteredExecutor> {
  const workspaceKey = options.workspaceKey ?? 'wk-z-sales';
  const response = await api<{
    executor: { id: string };
    executorToken: string;
  }>(server, '/api/v1/executors/register', {
    method: 'POST',
    token: server.userToken,
    body: {
      kind: 'vscode',
      user,
      protocolVersion: '1.0',
      capabilities: ['coding'],
      roles: [],
      workspaces: [
        { workspaceKey, repo: options.repo ?? 'z-sales', projectKey: 'SALES', baseBranch: 'main' },
      ],
    },
  });
  if (response.status !== 200) {
    throw new Error(`registerExecutor failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { executorId: response.body.executor.id, token: response.body.executorToken };
}

export async function heartbeat(
  server: TestServer,
  executor: RegisteredExecutor,
  workspaceKey = 'wk-z-sales',
): Promise<ApiResponse<{ offers: Array<{ id: string }> }>> {
  return api(server, `/api/v1/executors/${executor.executorId}/heartbeat`, {
    method: 'POST',
    token: executor.token,
    body: { status: 'online', load: 0, activeWorkspaceKey: workspaceKey },
  });
}
