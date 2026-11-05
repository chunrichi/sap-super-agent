import { describe, expect, it } from 'vitest';
import type { Demand, StageRun } from '@sap-superagent/protocol';
import {
  SAP_DEMAND_STATUS,
  SAP_WRITEBACK_FORBIDDEN_FIELDS,
  assertWhitelistedWriteback,
  buildSapWritebackPatch,
  mapSapDemandToControlPlane,
  projectSapStatus,
  sapStatusToDemandStatus,
  type StatusProjectionInput,
} from '../src/index.js';

function stage(executorKind: StageRun['executorKind'], status: StageRun['status']): StageRun {
  return {
    id: '01J00000000000000000000001',
    demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
    stageKey: executorKind === 'server-ai' ? 'requirement_analysis' : 'dev_implementation',
    status,
    attempt: 1,
    executorKind,
    gateKey: null,
    inputRefs: [],
    outputArtifactId: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  };
}

interface ProjectionCase {
  name: string;
  input: StatusProjectionInput;
  expected: string;
}

const PROJECTION_CASES: readonly ProjectionCase[] = [
  {
    name: 'submitted, analysis not started',
    input: { demand: { status: 'submitted' }, stages: [stage('server-ai', 'pending')] },
    expected: SAP_DEMAND_STATUS.awaitingAnalysis,
  },
  {
    name: 'server-ai stage ready (waiting for the runner)',
    input: { demand: { status: 'submitted' }, stages: [stage('server-ai', 'ready')] },
    expected: SAP_DEMAND_STATUS.analysing,
  },
  {
    name: 'server-ai stage running',
    input: { demand: { status: 'in_progress' }, stages: [stage('server-ai', 'running')] },
    expected: SAP_DEMAND_STATUS.analysing,
  },
  {
    name: 'pending approval projects to 待确认',
    input: {
      demand: { status: 'in_progress' },
      stages: [stage('server-ai', 'waiting_human')],
      approvals: [{ state: 'pending' }],
    },
    expected: SAP_DEMAND_STATUS.awaitingConfirmation,
  },
  {
    name: 'gate reached without an approval row yet',
    input: { demand: { status: 'in_progress' }, stages: [stage('server-ai', 'waiting_human')] },
    expected: SAP_DEMAND_STATUS.awaitingConfirmation,
  },
  {
    name: 'dev stage ready (waiting for dispatch)',
    input: {
      demand: { status: 'in_progress' },
      stages: [stage('server-ai', 'done'), stage('vscode', 'ready')],
    },
    expected: SAP_DEMAND_STATUS.developing,
  },
  {
    name: 'dev stage running',
    input: {
      demand: { status: 'in_progress' },
      stages: [stage('server-ai', 'done'), stage('vscode', 'running')],
    },
    expected: SAP_DEMAND_STATUS.developing,
  },
  {
    name: 'all stages done, demand in review',
    input: {
      demand: { status: 'review' },
      stages: [stage('server-ai', 'done'), stage('vscode', 'done')],
    },
    expected: SAP_DEMAND_STATUS.awaitingAcceptance,
  },
  {
    name: 'all stages done even if the demand status lags',
    input: {
      demand: { status: 'in_progress' },
      stages: [stage('server-ai', 'done'), stage('vscode', 'done')],
    },
    expected: SAP_DEMAND_STATUS.awaitingAcceptance,
  },
  {
    name: 'terminal done',
    input: { demand: { status: 'done' }, stages: [stage('server-ai', 'done')] },
    expected: SAP_DEMAND_STATUS.completed,
  },
  {
    name: 'terminal cancelled wins over everything',
    input: {
      demand: { status: 'cancelled' },
      stages: [stage('server-ai', 'cancelled')],
      approvals: [{ state: 'pending' }],
    },
    expected: SAP_DEMAND_STATUS.cancelled,
  },
  {
    name: 'terminal rejected',
    input: { demand: { status: 'rejected' }, stages: [stage('server-ai', 'failed')] },
    expected: SAP_DEMAND_STATUS.rejected,
  },
  {
    name: 'no stages yet (template not materialized)',
    input: { demand: { status: 'submitted' }, stages: [] },
    expected: SAP_DEMAND_STATUS.awaitingAnalysis,
  },
];

describe('control-plane → SAP status projection (docs/004 §2.1)', () => {
  it('covers the documented projection table', () => {
    const actual = PROJECTION_CASES.map((entry) => ({
      name: entry.name,
      status: projectSapStatus(entry.input).status,
      statusText: projectSapStatus(entry.input).statusText,
    }));
    expect(actual).toEqual(
      PROJECTION_CASES.map((entry) => ({
        name: entry.name,
        status: entry.expected,
        statusText: entry.expected,
      })),
    );
  });

  it('maps SAP statuses back to control-plane demand statuses (reconcile hints only)', () => {
    expect(
      Object.values(SAP_DEMAND_STATUS).map((value) => [value, sapStatusToDemandStatus(value)]),
    ).toEqual([
      ['待分析', 'in_progress'],
      ['分析中', 'in_progress'],
      ['待确认', 'in_progress'],
      ['开发中', 'in_progress'],
      ['待验收', 'review'],
      ['已完成', 'done'],
      ['已取消', 'cancelled'],
      ['已驳回', 'rejected'],
    ]);
    expect(sapStatusToDemandStatus('unknown')).toBeNull();
  });
});

describe('SAP demand snapshot → control-plane demand (docs/003 §4.3)', () => {
  it('maps a fully populated SAP demand, keeping the SAP UUID C32 as demandId', () => {
    const mapped = mapSapDemandToControlPlane({
      demandId: '4A3F9C2E7B1D48F0A6C5E2D9B8F7A1C3',
      demandNo: 'R-2041',
      title: '  取数逻辑  ',
      description: '按销售组织汇总开票金额',
      acceptanceCriteria: ['金额一致', ''],
      requesterUserId: 'REQ001',
      orgUnit: 'PDO',
      priority: 'high',
      repoKey: 'z-sales',
      projectKey: 'SALES',
    });
    expect(mapped).toEqual({
      demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
      no: 'R-2041',
      title: '取数逻辑',
      description: '按销售组织汇总开票金额',
      acceptanceCriteria: ['金额一致'],
      requester: { userId: 'REQ001', orgUnit: 'PDO' },
      priority: 'high',
      workspaceBinding: { repo: 'z-sales', projectKey: 'SALES' },
      source: 'sap',
    });
  });

  it('keeps unbound demands unbound (repo/project empty → general task inbox)', () => {
    const mapped = mapSapDemandToControlPlane({
      demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
      title: '未绑定仓库的需求',
      requesterUserId: 'REQ002',
      repoKey: '',
      projectKey: null,
      priority: 'emergency',
    });
    expect(mapped.workspaceBinding).toBeNull();
    expect(mapped.priority).toBe('normal');
    expect(mapped.requester).toEqual({ userId: 'REQ002' });
  });

  it('rejects invalid SAP snapshots instead of creating broken demands', () => {
    expect(() =>
      mapSapDemandToControlPlane({
        demandId: 'not-a-uuid',
        title: 'x',
        requesterUserId: 'REQ001',
      }),
    ).toThrow(/UUID C32/);
    expect(() =>
      mapSapDemandToControlPlane({
        demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
        title: '   ',
        requesterUserId: 'REQ001',
      }),
    ).toThrow(/title/);
    expect(() =>
      mapSapDemandToControlPlane({
        demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
        title: 'x',
        requesterUserId: '',
      }),
    ).toThrow(/requesterUserId/);
  });
});

describe('control-plane → SAP writeback whitelist (docs/004 §3.2)', () => {
  const demand: Pick<Demand, 'status'> = { status: 'in_progress' };

  it('builds a whitelisted PATCH with projection, artifacts and approval result', () => {
    const patch = buildSapWritebackPatch({
      projection: projectSapStatus({ demand, stages: [stage('server-ai', 'done')] }),
      stageKey: 'requirement_analysis',
      artifacts: [
        {
          artifactId: '01J9ZZZZZZZZZZZZZZZZZZZZZ',
          stageKey: 'requirement_analysis',
          stageRunId: '01J8ZZZZZZZZZZZZZZZZZZZZZ',
          kind: 'requirement_analysis',
          version: 1,
          checksum: `sha256:${'a'.repeat(64)}`,
          contentRef: 'artifact://01J9ZZZZZZZZZZZZZZZZZZZZZ/v1',
          contentType: 'application/json',
          status: 'approved',
        },
      ],
      approval: {
        gateKey: 'G1',
        state: 'approved',
        decidedBy: 'CONSULTANT01',
        comment: 'ok',
        decidedAt: '2026-11-05T00:00:00.000Z',
      },
    });
    expect(patch.status).toBe(SAP_DEMAND_STATUS.awaitingAcceptance);
    expect(patch.statusText).toBe(SAP_DEMAND_STATUS.awaitingAcceptance);
    expect(patch.artifacts).toHaveLength(1);
    expect(patch.approval?.state).toBe('approved');
    expect(Object.keys(patch).sort()).toEqual([
      'approval',
      'artifacts',
      'stageKey',
      'status',
      'statusText',
    ]);
    expect(() => assertWhitelistedWriteback(patch as unknown as Record<string, unknown>)).not.toThrow();
  });

  it('has no business fields in the whitelist', () => {
    for (const field of ['title', 'description', 'acceptanceCriteria', 'requester', 'repoKey']) {
      expect(SAP_WRITEBACK_FORBIDDEN_FIELDS).toContain(field);
      expect(() => assertWhitelistedWriteback({ status: '开发中', [field]: 'x' })).toThrow(
        /must not modify business field/,
      );
    }
    expect(() => assertWhitelistedWriteback({ status: '开发中', unknownField: 1 })).toThrow(
      /not whitelisted/,
    );
  });
});
