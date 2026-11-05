import type { DatabaseSync } from 'node:sqlite';
import type {
  SapAiJob,
  SapAiJobPayload,
  SapAiJobResultSummary,
  SapAiJobState,
} from '@sap-superagent/protocol';
import { asNullableString, asNumber, asString, decodeJson, encodeJson } from './rows.js';

// ---------------------------------------------------------------------------
// S5: `sap_ai_jobs` store (docs/003 §4.8.2, migration v7).
//
// `(stage_run_id, attempt)` is unique: one attempt owns exactly one job. A
// retry bumps the attempt and produces a new job; terminal jobs are kept as
// audit records. Payload/result are JSON text via the shared rows.ts helpers.
// `lease_expiries` is an internal counter (not part of the wire `SapAiJob`
// schema) used by the lease sweeper and the restart recovery path.
// ---------------------------------------------------------------------------

interface SapAiJobRow {
  id: string;
  stage_run_id: string;
  demand_id: string;
  attempt: number;
  stage_key: string;
  state: string;
  payload: string;
  claim_id: string | null;
  lease_expires_at: string | null;
  result: string | null;
  last_error: string | null;
  lease_expiries: number;
  created_at: string;
  updated_at: string;
}

/** Job states that never transition again (docs/003 §4.8.2). */
export const SAP_AI_JOB_TERMINAL_STATES: readonly SapAiJobState[] = [
  'succeeded',
  'failed',
  'expired',
  'cancelled',
];

export function isSapAiJobTerminal(state: SapAiJobState): boolean {
  return SAP_AI_JOB_TERMINAL_STATES.includes(state);
}

function rowToJob(row: SapAiJobRow): SapAiJob {
  return {
    id: asString(row.id),
    stageRunId: asString(row.stage_run_id),
    demandId: asString(row.demand_id),
    attempt: asNumber(row.attempt),
    stageKey: asString(row.stage_key),
    state: asString(row.state) as SapAiJobState,
    payload: decodeJson<SapAiJobPayload>(row.payload),
    claimId: asNullableString(row.claim_id),
    leaseExpiresAt: asNullableString(row.lease_expires_at),
    result: row.result === null ? null : decodeJson<SapAiJobResultSummary>(row.result),
    lastError: asNullableString(row.last_error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function insertSapAiJob(db: DatabaseSync, job: SapAiJob, leaseExpiries = 0): void {
  db.prepare(
    `INSERT INTO sap_ai_jobs (
      id, stage_run_id, demand_id, attempt, stage_key, state, payload, claim_id,
      lease_expires_at, result, last_error, lease_expiries, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.stageRunId,
    job.demandId,
    job.attempt,
    job.stageKey,
    job.state,
    encodeJson(job.payload),
    job.claimId,
    job.leaseExpiresAt,
    job.result === null ? null : encodeJson(job.result),
    job.lastError,
    leaseExpiries,
    job.createdAt,
    job.updatedAt,
  );
}

/**
 * Persist the mutable job columns. `lease_expiries` is intentionally *not*
 * touched here: it only changes through {@link incrementSapAiJobLeaseExpiries}
 * so a lease expiry can never be lost by an unrelated state update.
 */
export function updateSapAiJob(db: DatabaseSync, job: SapAiJob): void {
  db.prepare(
    `UPDATE sap_ai_jobs SET state = ?, claim_id = ?, lease_expires_at = ?, result = ?,
      last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    job.state,
    job.claimId,
    job.leaseExpiresAt,
    job.result === null ? null : encodeJson(job.result),
    job.lastError,
    job.updatedAt,
    job.id,
  );
}

export function getSapAiJob(db: DatabaseSync, id: string): SapAiJob | null {
  const row = db.prepare('SELECT * FROM sap_ai_jobs WHERE id = ?').get(id) as unknown as
    | SapAiJobRow
    | undefined;
  return row === undefined ? null : rowToJob(row);
}

export function getSapAiJobForAttempt(
  db: DatabaseSync,
  stageRunId: string,
  attempt: number,
): SapAiJob | null {
  const row = db
    .prepare('SELECT * FROM sap_ai_jobs WHERE stage_run_id = ? AND attempt = ?')
    .get(stageRunId, attempt) as unknown as SapAiJobRow | undefined;
  return row === undefined ? null : rowToJob(row);
}

/** Current lease-expiry counter of one job (`null` when the job is gone). */
export function getSapAiJobLeaseExpiries(db: DatabaseSync, id: string): number | null {
  const row = db.prepare('SELECT lease_expiries FROM sap_ai_jobs WHERE id = ?').get(id) as
    | { lease_expiries?: number }
    | undefined;
  return row === undefined || row.lease_expiries === undefined ? null : asNumber(row.lease_expiries);
}

/**
 * Increment (and return) the lease-expiry counter for one job. The caller is
 * expected to persist the accompanying state change with `updateSapAiJob` in
 * the same transaction; the counter itself is independent of that update.
 */
export function incrementSapAiJobLeaseExpiries(db: DatabaseSync, id: string): number {
  db.prepare('UPDATE sap_ai_jobs SET lease_expiries = lease_expiries + 1 WHERE id = ?').run(id);
  return getSapAiJobLeaseExpiries(db, id) ?? 0;
}

/** Jobs the SAP batch executor may claim, oldest first (docs/003 §4.8.2). */
export function listQueuedSapAiJobs(db: DatabaseSync, limit: number): SapAiJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM sap_ai_jobs WHERE state = 'queued'
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as unknown as SapAiJobRow[];
  return rows.map(rowToJob);
}

/** Non-terminal jobs (queued/claimed) — the cancellation sweep works on these. */
export function listActiveSapAiJobs(db: DatabaseSync): SapAiJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM sap_ai_jobs WHERE state IN ('queued', 'claimed')
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as unknown as SapAiJobRow[];
  return rows.map(rowToJob);
}

export function countSapAiJobsByState(db: DatabaseSync): Record<SapAiJobState, number> {
  const counts: Record<SapAiJobState, number> = {
    queued: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    expired: 0,
    cancelled: 0,
  };
  const rows = db
    .prepare('SELECT state, COUNT(*) AS total FROM sap_ai_jobs GROUP BY state')
    .all() as unknown as Array<{ state: string; total: number }>;
  for (const row of rows) {
    const state = asString(row.state) as SapAiJobState;
    if (state in counts) counts[state] = asNumber(row.total);
  }
  return counts;
}

/** Most recent job error for the ops status endpoint (`null` when clean). */
export function lastSapAiJobError(db: DatabaseSync): string | null {
  const row = db
    .prepare(
      `SELECT last_error FROM sap_ai_jobs WHERE last_error IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get() as { last_error?: string } | undefined;
  return row === undefined || row.last_error === undefined ? null : asString(row.last_error);
}

/** `claimed` jobs whose lease already expired (`lease_expires_at <= now`). */
export function listClaimedExpiredSapAiJobs(db: DatabaseSync, nowIso: string): SapAiJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM sap_ai_jobs
       WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
       ORDER BY lease_expires_at ASC, id ASC`,
    )
    .all(nowIso) as unknown as SapAiJobRow[];
  return rows.map(rowToJob);
}

/** Non-terminal jobs created before `cutoffIso` (max-age expiry, §4.8.2). */
export function listOverAgeSapAiJobs(db: DatabaseSync, cutoffIso: string): SapAiJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM sap_ai_jobs
       WHERE state IN ('queued', 'claimed') AND created_at < ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(cutoffIso) as unknown as SapAiJobRow[];
  return rows.map(rowToJob);
}
