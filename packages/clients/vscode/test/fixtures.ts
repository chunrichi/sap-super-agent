// Protocol-valid fixtures for client/executor tests. IDs are real ULIDs so the
// response schemas validate exactly like a live control plane would.
import {
  newDemandId,
  newUlid,
  type Artifact,
  type ArtifactVersion,
  type ClaimTaskResponse,
  type Executor,
  type HeartbeatResponse,
  type LeaseRenewResponse,
  type RegisterExecutorResponse,
  type Task,
  type TaskContext,
} from '@sap-superagent/protocol';
import type { SubmitArtifactResponse, TaskContextResponse } from '../src/client.js';

const NOW = '2026-11-05T00:00:00.000Z';

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: newUlid(),
    demandId: newDemandId(),
    stageRunId: null,
    title: '实现需求 R-2041 的取数逻辑',
    executorKind: 'vscode',
    requiredRoles: ['developer'],
    workspaceBinding: { repo: 'z-sales', projectKey: 'SALES', baseBranch: 'main' },
    priority: 'normal',
    dueAt: null,
    state: 'pending',
    lastHolderUserIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeExecutor(overrides: Partial<Executor> = {}): Executor {
  return {
    id: newUlid(),
    kind: 'vscode',
    user: 'dev',
    machineIdHash: null,
    capabilities: ['coding'],
    roles: ['developer'],
    workspaces: [],
    activeWorkspaceKey: null,
    presence: 'online',
    accepting: true,
    maxConcurrent: 2,
    protocolVersion: '1',
    cliVersion: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeRegisterResponse(
  overrides: Partial<Executor> = {},
  executorToken = 'executor-token',
): RegisterExecutorResponse {
  return {
    executor: makeExecutor(overrides),
    executorToken,
    tokenExpiresAt: NOW,
    serverTime: NOW,
  };
}

export function makeHeartbeatResponse(offers: HeartbeatResponse['offers'] = []): HeartbeatResponse {
  return { serverTime: NOW, leaseTtlMs: 60000, renewIntervalMs: 20000, offers };
}

export function makeClaimResponse(task: Task = makeTask()): ClaimTaskResponse {
  return {
    task: { ...task, state: 'claimed' },
    lease: { expiresAt: NOW, renewIntervalMs: 20000 },
    contextUrl: `/api/v1/tasks/${task.id}/context`,
    serverTime: NOW,
  };
}

export function makeLeaseRenewResponse(): LeaseRenewResponse {
  return { lease: { expiresAt: NOW, renewIntervalMs: 20000 }, serverTime: NOW };
}

export function makeContext(task: Task = makeTask()): TaskContext {
  return {
    task,
    demand: {
      id: task.demandId,
      title: 'R-2041 销售报表取数',
      description: '在 Z 销售报表中增加按客户分组的取数逻辑。',
      acceptanceCriteria: ['数据与 SAP 报表一致', '覆盖空客户分组'],
      priority: 'normal',
      requester: { userId: 'requester-1' },
    },
    stage: {
      key: 'dev_implementation',
      name: '开发实现',
      outputArtifactKind: 'code_change',
    },
    inputArtifacts: [],
    workspaceBinding: task.workspaceBinding,
    allowedActions: ['read-repo', 'submit-artifact'],
    forbiddenActions: ['git push', 'abap delete'],
    generatedAt: NOW,
  };
}

export function makeContextResponse(task: Task = makeTask()): TaskContextResponse {
  return {
    markdown: `# 任务上下文 ${task.title}\n\n上下文包正文。\n`,
    json: makeContext(task),
  };
}

export function makeArtifact(task: Task = makeTask()): Artifact {
  return {
    id: newUlid(),
    demandId: task.demandId,
    kind: 'code_change',
    stageKey: 'dev_implementation',
    stageRunId: null,
    state: 'generated',
    currentVersion: 1,
    title: task.title,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function makeArtifactVersion(artifact: Artifact): ArtifactVersion {
  return {
    artifactId: artifact.id,
    version: 1,
    contentRef: `artifact://${artifact.id}/v1`,
    contentType: 'text/markdown',
    checksum: `sha256:${'a'.repeat(64)}`,
    summary: '实现取数逻辑',
    authorType: 'agent',
    authorId: 'dev',
    stale: false,
    createdAt: NOW,
  };
}

export function makeSubmitArtifactResponse(task: Task = makeTask()): SubmitArtifactResponse {
  const artifact = makeArtifact(task);
  return {
    artifact,
    version: makeArtifactVersion(artifact),
    taskState: 'in_progress',
    serverTime: NOW,
  };
}
