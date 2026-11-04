import type { Executor, Task, TaskContext } from '@sap-superagent/protocol';

export const ULID_A = '01J8ZQ9W3K5M2V7X4C6B8N0P1Q';
export const ULID_B = '01J8ZQ9W3K5M2V7X4C6B8N0P1R';
export const DEMAND_ID = '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3';
export const NOW = '2026-11-05T00:00:00.000Z';

export const vscodeExecutor: Executor = {
  id: ULID_A,
  kind: 'vscode',
  user: 'DEV001',
  machineIdHash: 'machine-hash',
  capabilities: ['coding'],
  roles: ['developer'],
  workspaces: [
    { workspaceKey: 'wk-z-sales', repo: 'z-sales', projectKey: 'SALES', baseBranch: 'main' },
  ],
  activeWorkspaceKey: 'wk-z-sales',
  presence: 'online',
  accepting: true,
  maxConcurrent: 2,
  protocolVersion: '1.0.0',
  cliVersion: '0.0.0',
  createdAt: NOW,
  updatedAt: NOW,
};

export const serverAiExecutor: Executor = {
  ...vscodeExecutor,
  id: ULID_B,
  kind: 'server-ai',
  user: 'server-ai',
  machineIdHash: null,
  workspaces: [],
  activeWorkspaceKey: null,
  roles: ['developer', 'consultant'],
  maxConcurrent: 4,
};

export const boundTask: Task = {
  id: ULID_A,
  demandId: DEMAND_ID,
  stageRunId: ULID_B,
  title: '实现取数逻辑',
  executorKind: 'vscode',
  requiredRoles: ['developer'],
  workspaceBinding: { repo: 'z-sales', projectKey: 'SALES', baseBranch: 'main' },
  priority: 'normal',
  dueAt: null,
  state: 'pending',
  lastHolderUserIds: [],
  createdAt: NOW,
  updatedAt: NOW,
};

export const unboundTask: Task = {
  ...boundTask,
  workspaceBinding: null,
  requiredRoles: [],
};

export const serverAiTask: Task = {
  ...boundTask,
  executorKind: 'server-ai',
  workspaceBinding: null,
};

export const sampleContext: TaskContext = {
  task: boundTask,
  demand: {
    id: DEMAND_ID,
    title: 'R-2041 取数逻辑',
    description: '按销售组织汇总开票金额',
    acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
    priority: 'normal',
    requester: { userId: 'REQ001', orgUnit: 'PDO' },
  },
  stage: { key: 'dev_implementation', name: '开发实现', outputArtifactKind: 'code_change' },
  inputArtifacts: [
    {
      artifactId: ULID_B,
      version: 1,
      kind: 'requirement_analysis',
      summary: '需求分析 v1',
      contentRef: `artifact://${ULID_B}/v1`,
    },
  ],
  workspaceBinding: { repo: 'z-sales', projectKey: 'SALES', baseBranch: 'main' },
  allowedActions: ['edit_workspace', 'run_abap_check'],
  forbiddenActions: ['write_production_sap'],
  generatedAt: NOW,
};
