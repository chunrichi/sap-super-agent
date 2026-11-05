export const ULID_A = '01J8ZQ9W3K5M2V7X4C6B8N0P1Q';
export const ULID_B = '01J8ZQ9W3K5M2V7X4C6B8N0P1R';
export const DEMAND_ID = '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3';
export const NOW = '2026-11-05T00:00:00.000Z';
export const CHECKSUM = `sha256:${'a'.repeat(64)}`;

export const validDemand = {
  id: DEMAND_ID,
  title: 'R-2041 取数逻辑',
  description: '按销售组织汇总开票金额',
  acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
  requester: { userId: 'DEV001', orgUnit: 'PDO' },
  priority: 'normal',
  templateId: 'default',
  templateVersion: 1,
  status: 'submitted',
  workspaceBinding: null,
  source: 'local',
  createdAt: NOW,
  updatedAt: NOW,
};

export const validTask = {
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

export const validArtifactVersion = {
  artifactId: ULID_A,
  version: 1,
  contentRef: `artifact://${ULID_A}/v1`,
  contentType: 'application/json',
  checksum: CHECKSUM,
  summary: '需求分析 v1',
  authorType: 'ai',
  authorId: 'server-ai',
  stale: false,
  createdAt: NOW,
};
