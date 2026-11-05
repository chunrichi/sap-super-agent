import type { DemandStatus } from '@sap-superagent/protocol';
import { sapStatusToDemandStatus, type SapDemandRecord } from './mapping.js';

// ---------------------------------------------------------------------------
// Reconcile (docs/004 §3.1 chunk 3, docs/009 #12): pull SAP demands by the
// `CHANGED_AT` cursor and produce a *difference report only*. It never writes
// business fields and never replays creation actions (docs/008 §5).
// ---------------------------------------------------------------------------

export type ReconcileDifferenceKind =
  | 'missing_in_sap'
  | 'missing_in_control_plane'
  | 'status_mismatch'
  | 'field_mismatch';

export interface ReconcileDifference {
  kind: ReconcileDifferenceKind;
  demandId: string;
  details: Record<string, unknown>;
}

export interface ReconcileLocalDemand {
  id: string;
  status: DemandStatus;
  title: string;
  /** Status last written back to SAP, when known (best-effort check). */
  expectedSapStatus?: string | null;
  source: 'local' | 'sap';
}

export interface ReconcileReport {
  checkedAt: string;
  /** `CHANGED_AT` cursor used for the SAP pull. */
  changedSince: string;
  sapCount: number;
  localCount: number;
  differences: ReconcileDifference[];
  counts: Record<ReconcileDifferenceKind, number>;
  /** Next cursor for the following reconcile run (latest SAP `changedAt`). */
  nextCursor: string;
}

export interface ReconcileDemandSource {
  listDemands(query: {
    changedSince?: string;
    limit?: number;
  }): Promise<{ demands: SapDemandRecord[] }>;
}

export interface ReconcileOptions {
  changedSince: string;
  /** Overrides the report timestamp (tests/determinism). */
  now?: string;
  limit?: number;
}

function emptyCounts(): Record<ReconcileDifferenceKind, number> {
  return {
    missing_in_sap: 0,
    missing_in_control_plane: 0,
    status_mismatch: 0,
    field_mismatch: 0,
  };
}

function pushDifference(
  differences: ReconcileDifference[],
  counts: Record<ReconcileDifferenceKind, number>,
  difference: ReconcileDifference,
): void {
  differences.push(difference);
  counts[difference.kind] += 1;
}

/**
 * Pure diff between the control-plane snapshot and the SAP pull. `local` must
 * contain the SAP-sourced demands (the caller filters by `source`), because a
 * demand created locally is not expected to exist in SAP.
 */
export function diffSapDemands(input: {
  local: readonly ReconcileLocalDemand[];
  sap: readonly SapDemandRecord[];
  changedSince: string;
  now?: string;
}): ReconcileReport {
  const sapById = new Map<string, SapDemandRecord>();
  for (const record of input.sap) sapById.set(record.demandId.toLowerCase(), record);
  const localById = new Map<string, ReconcileLocalDemand>();
  for (const demand of input.local) localById.set(demand.id.toLowerCase(), demand);

  const differences: ReconcileDifference[] = [];
  const counts = emptyCounts();
  let nextCursorMs = Date.parse(input.changedSince);
  if (Number.isNaN(nextCursorMs)) nextCursorMs = 0;

  for (const record of input.sap) {
    const demandId = record.demandId.toLowerCase();
    const changedAt = typeof record.changedAt === 'string' ? Date.parse(record.changedAt) : Number.NaN;
    if (!Number.isNaN(changedAt) && changedAt > nextCursorMs) nextCursorMs = changedAt;

    const local = localById.get(demandId);
    if (local === undefined) {
      pushDifference(differences, counts, {
        kind: 'missing_in_control_plane',
        demandId,
        details: {
          title: record.title,
          sapStatus: record.status ?? null,
          changedAt: record.changedAt ?? null,
        },
      });
      continue;
    }

    const expectedStatus = local.expectedSapStatus ?? null;
    if (
      expectedStatus !== null &&
      record.status !== null &&
      record.status !== undefined &&
      expectedStatus !== record.status
    ) {
      pushDifference(differences, counts, {
        kind: 'status_mismatch',
        demandId,
        details: { expected: expectedStatus, actual: record.status },
      });
    } else {
      const projected = sapStatusToDemandStatus(record.status ?? '');
      if (projected !== null && projected !== local.status) {
        pushDifference(differences, counts, {
          kind: 'status_mismatch',
          demandId,
          details: { expected: local.status, actual: record.status ?? null, projected },
        });
      }
    }

    if (typeof record.title === 'string' && record.title !== local.title) {
      pushDifference(differences, counts, {
        kind: 'field_mismatch',
        demandId,
        details: { field: 'title', controlPlane: local.title, sap: record.title },
      });
    }
  }

  for (const demand of input.local) {
    const demandId = demand.id.toLowerCase();
    if (sapById.has(demandId)) continue;
    pushDifference(differences, counts, {
      kind: 'missing_in_sap',
      demandId,
      details: { title: demand.title, status: demand.status },
    });
  }

  differences.sort((left, right) => {
    if (left.demandId === right.demandId) return left.kind.localeCompare(right.kind);
    return left.demandId.localeCompare(right.demandId);
  });

  return {
    checkedAt: input.now ?? new Date().toISOString(),
    changedSince: input.changedSince,
    sapCount: input.sap.length,
    localCount: input.local.length,
    differences,
    counts,
    nextCursor: new Date(nextCursorMs).toISOString(),
  };
}

/**
 * Pull the SAP demand delta and diff it against the local snapshot. Read-only:
 * the report is meant for a daily reconcile job and the ops panel (docs/008 §6).
 */
export async function reconcileSapDemands(
  source: ReconcileDemandSource,
  local: readonly ReconcileLocalDemand[],
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const pulled = await source.listDemands({
    changedSince: options.changedSince,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return diffSapDemands({
    local,
    sap: pulled.demands,
    changedSince: options.changedSince,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
