import type { DatabaseSync } from 'node:sqlite';
import type { Approval, ApprovalState, Role } from '@sap-superagent/protocol';
import { asNullableString, asNumber, asString } from './rows.js';

// ---------------------------------------------------------------------------
// Approval persistence (docs/003 §2.5, H1). Rows created before H1 have no
// bound artifact version; the runtime always binds one (migration v3).
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  demand_id: string;
  stage_run_id: string;
  gate_key: string;
  artifact_id: string | null;
  artifact_version: number | null;
  state: string;
  required_role: string;
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToApproval(row: ApprovalRow): Approval {
  const artifactId = asNullableString(row.artifact_id);
  const artifactVersion = row.artifact_version === null ? null : asNumber(row.artifact_version);
  if (artifactId === null || artifactVersion === null) {
    throw new Error(
      `approval ${asString(row.id)} has no bound artifact version; recreate it via the gate runtime`,
    );
  }
  return {
    id: asString(row.id),
    demandId: asString(row.demand_id),
    stageRunId: asString(row.stage_run_id),
    gateKey: asString(row.gate_key),
    artifactId,
    artifactVersion,
    state: asString(row.state) as ApprovalState,
    requiredRole: asString(row.required_role) as Role,
    decision: asNullableString(row.decision) as Approval['decision'],
    decidedBy: asNullableString(row.decided_by),
    decidedAt: asNullableString(row.decided_at),
    comment: asNullableString(row.comment),
    expiresAt: asNullableString(row.expires_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function insertApproval(db: DatabaseSync, approval: Approval): void {
  db.prepare(
    `INSERT INTO approvals (
      id, demand_id, stage_run_id, gate_key, artifact_id, artifact_version, state,
      required_role, decision, decided_by, decided_at, comment, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    approval.id,
    approval.demandId,
    approval.stageRunId,
    approval.gateKey,
    approval.artifactId,
    approval.artifactVersion,
    approval.state,
    approval.requiredRole,
    approval.decision,
    approval.decidedBy,
    approval.decidedAt,
    approval.comment,
    approval.expiresAt,
    approval.createdAt,
    approval.updatedAt,
  );
}

export function updateApproval(db: DatabaseSync, approval: Approval): void {
  db.prepare(
    `UPDATE approvals SET state = ?, decision = ?, decided_by = ?, decided_at = ?,
       comment = ?, expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    approval.state,
    approval.decision,
    approval.decidedBy,
    approval.decidedAt,
    approval.comment,
    approval.expiresAt,
    approval.updatedAt,
    approval.id,
  );
}

export function getApproval(db: DatabaseSync, id: string): Approval | null {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as
    | ApprovalRow
    | undefined;
  return row === undefined ? null : rowToApproval(row);
}

export interface ListApprovalsOptions {
  state?: ApprovalState;
  demandId?: string;
  limit: number;
}

export function listApprovals(db: DatabaseSync, options: ListApprovalsOptions): Approval[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.state !== undefined) {
    clauses.push('state = ?');
    params.push(options.state);
  }
  if (options.demandId !== undefined) {
    clauses.push('demand_id = ?');
    params.push(options.demandId);
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
  params.push(options.limit);
  const rows = db
    .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at ASC LIMIT ?`)
    .all(...params) as unknown as ApprovalRow[];
  return rows.map(rowToApproval);
}

export function listApprovalsForDemand(db: DatabaseSync, demandId: string): Approval[] {
  const rows = db
    .prepare('SELECT * FROM approvals WHERE demand_id = ? ORDER BY created_at ASC')
    .all(demandId) as unknown as ApprovalRow[];
  return rows.map(rowToApproval);
}

/** Pending gates whose `expiresAt` has passed (sweeper input). */
export function listExpiredPendingApprovals(db: DatabaseSync, nowIso: string): Approval[] {
  const rows = db
    .prepare(
      `SELECT * FROM approvals
       WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
       ORDER BY expires_at ASC`,
    )
    .all(nowIso) as unknown as ApprovalRow[];
  return rows.map(rowToApproval);
}

/** Pending gate bound to one artifact version, if any (revision guard). */
export function findPendingApprovalForArtifact(
  db: DatabaseSync,
  artifactId: string,
  version: number,
): Approval | null {
  const row = db
    .prepare(
      `SELECT * FROM approvals
       WHERE artifact_id = ? AND artifact_version = ? AND state = 'pending'
       LIMIT 1`,
    )
    .get(artifactId, version) as unknown as ApprovalRow | undefined;
  return row === undefined ? null : rowToApproval(row);
}
