import { describe, expect, it } from 'vitest';
import { diffSapDemands, reconcileSapDemands, type ReconcileLocalDemand } from '../src/index.js';

const DEMAND_A = '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3';
const DEMAND_B = '5b4a0d3f8c2e49f1b7d6f3e2a9c8b1d4';
const DEMAND_C = '6c5b1e4a9d3f40a2c8e7a5f4b2d1c0e9';
const NOW = '2026-11-05T08:00:00.000Z';
const CURSOR = '2026-11-04T00:00:00.000Z';

const LOCAL: ReconcileLocalDemand[] = [
  {
    id: DEMAND_A,
    status: 'in_progress',
    title: '取数逻辑',
    expectedSapStatus: '开发中',
    source: 'sap',
  },
  {
    id: DEMAND_B,
    status: 'review',
    title: '接口调整',
    expectedSapStatus: '待验收',
    source: 'sap',
  },
  {
    id: DEMAND_C,
    status: 'in_progress',
    title: '只在控制平面存在',
    source: 'sap',
  },
];

describe('SAP reconcile report (docs/004 §3.1, docs/009 #12)', () => {
  it('reports the four difference classes without writing anything', () => {
    const report = diffSapDemands({
      local: LOCAL,
      sap: [
        {
          demandId: DEMAND_A,
          title: '取数逻辑',
          status: '开发中',
          changedAt: '2026-11-05T07:00:00.000Z',
        },
        {
          demandId: DEMAND_B,
          title: '接口调整',
          status: '待确认', // SAP says 待确认, the control plane expected 待验收
          changedAt: '2026-11-05T07:10:00.000Z',
        },
        {
          demandId: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
          title: '只在 SAP 存在',
          status: '待分析',
          changedAt: '2026-11-05T07:20:00.000Z',
        },
      ],
      changedSince: CURSOR,
      now: NOW,
    });

    expect(report.checkedAt).toBe(NOW);
    expect(report.changedSince).toBe(CURSOR);
    expect(report.sapCount).toBe(3);
    expect(report.localCount).toBe(3);
    expect(report.counts).toEqual({
      missing_in_sap: 1,
      missing_in_control_plane: 1,
      status_mismatch: 1,
      field_mismatch: 0,
    });
    expect(report.differences).toEqual([
      {
        kind: 'status_mismatch',
        demandId: DEMAND_B,
        details: { expected: '待验收', actual: '待确认' },
      },
      {
        kind: 'missing_in_sap',
        demandId: DEMAND_C,
        details: { title: '只在控制平面存在', status: 'in_progress' },
      },
      {
        kind: 'missing_in_control_plane',
        demandId: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
        details: { title: '只在 SAP 存在', sapStatus: '待分析', changedAt: '2026-11-05T07:20:00.000Z' },
      },
    ]);
    expect(report.nextCursor).toBe('2026-11-05T07:20:00.000Z');
  });

  it('detects title drift as a field mismatch and never proposes a write', () => {
    const report = diffSapDemands({
      local: [LOCAL[0] as ReconcileLocalDemand],
      sap: [
        {
          demandId: DEMAND_A,
          title: '取数逻辑（SAP 已改）',
          status: '开发中',
          changedAt: '2026-11-05T07:00:00.000Z',
        },
      ],
      changedSince: CURSOR,
      now: NOW,
    });
    expect(report.counts.field_mismatch).toBe(1);
    expect(report.differences[0]).toEqual({
      kind: 'field_mismatch',
      demandId: DEMAND_A,
      details: { field: 'title', controlPlane: '取数逻辑', sap: '取数逻辑（SAP 已改）' },
    });
    expect(report.counts.missing_in_sap).toBe(0);
    expect(report.counts.missing_in_control_plane).toBe(0);
  });

  it('falls back to the reverse status projection when no expected status is tracked', () => {
    const report = diffSapDemands({
      local: [{ id: DEMAND_A, status: 'review', title: '取数逻辑', source: 'sap' }],
      sap: [{ demandId: DEMAND_A, title: '取数逻辑', status: '已完成' }],
      changedSince: NOW,
      now: NOW,
    });
    expect(report.counts.status_mismatch).toBe(1);
    expect(report.differences[0]?.details).toMatchObject({ actual: '已完成', projected: 'done' });
  });

  it('pulls the CHANGED_AT cursor through the client interface', async () => {
    const queries: Array<{ changedSince?: string; limit?: number }> = [];
    const report = await reconcileSapDemands(
      {
        listDemands: async (query) => {
          queries.push(query);
          return {
            demands: [
              {
                demandId: DEMAND_A,
                title: '取数逻辑',
                status: '开发中',
                changedAt: '2026-11-05T07:00:00.000Z',
              },
            ],
          };
        },
      },
      LOCAL,
      { changedSince: CURSOR, now: NOW, limit: 100 },
    );
    expect(queries).toEqual([{ changedSince: CURSOR, limit: 100 }]);
    expect(report.counts.missing_in_sap).toBe(2);
    expect(report.counts.missing_in_control_plane).toBe(0);
  });
});
