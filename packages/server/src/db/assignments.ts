import type { DatabaseSync } from 'node:sqlite';
import type { Assignment } from '@sap-superagent/protocol';
import { asNullableString, asString } from './rows.js';

interface AssignmentRow {
  id: string;
  task_id: string;
  executor_id: string;
  user_id: string | null;
  state: string;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

function rowToAssignment(row: AssignmentRow): Assignment {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    executorId: asString(row.executor_id),
    userId: asNullableString(row.user_id),
    state: asString(row.state) as Assignment['state'],
    leaseExpiresAt: asNullableString(row.lease_expires_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    endedAt: asNullableString(row.ended_at),
  };
}

export function insertAssignment(db: DatabaseSync, assignment: Assignment): void {
  db.prepare(
    `INSERT INTO assignments (
      id, task_id, executor_id, user_id, state, lease_expires_at, created_at, updated_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    assignment.id,
    assignment.taskId,
    assignment.executorId,
    assignment.userId,
    assignment.state,
    assignment.leaseExpiresAt,
    assignment.createdAt,
    assignment.updatedAt,
    assignment.endedAt,
  );
}

export function updateAssignment(db: DatabaseSync, assignment: Assignment): void {
  db.prepare(
    `UPDATE assignments SET state = ?, lease_expires_at = ?, updated_at = ?, ended_at = ?
     WHERE id = ?`,
  ).run(
    assignment.state,
    assignment.leaseExpiresAt,
    assignment.updatedAt,
    assignment.endedAt,
    assignment.id,
  );
}

export function updateAssignmentLease(
  db: DatabaseSync,
  id: string,
  leaseExpiresAt: string,
  updatedAt: string,
): void {
  db.prepare('UPDATE assignments SET lease_expires_at = ?, updated_at = ? WHERE id = ?').run(
    leaseExpiresAt,
    updatedAt,
    id,
  );
}

export function getActiveAssignmentForTask(
  db: DatabaseSync,
  taskId: string,
): Assignment | null {
  const row = db
    .prepare("SELECT * FROM assignments WHERE task_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(taskId) as unknown as AssignmentRow | undefined;
  return row === undefined ? null : rowToAssignment(row);
}

export function getActiveAssignmentForTaskAndExecutor(
  db: DatabaseSync,
  taskId: string,
  executorId: string,
): Assignment | null {
  const row = db
    .prepare(
      "SELECT * FROM assignments WHERE task_id = ? AND executor_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1",
    )
    .get(taskId, executorId) as unknown as AssignmentRow | undefined;
  return row === undefined ? null : rowToAssignment(row);
}

export function listActiveAssignmentsForExecutor(
  db: DatabaseSync,
  executorId: string,
): Assignment[] {
  const rows = db
    .prepare("SELECT * FROM assignments WHERE executor_id = ? AND state = 'active'")
    .all(executorId) as unknown as AssignmentRow[];
  return rows.map(rowToAssignment);
}

export function countActiveAssignmentsForUserOnDemand(
  db: DatabaseSync,
  userId: string,
  demandId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM assignments a JOIN tasks t ON t.id = a.task_id
       WHERE a.state = 'active' AND a.user_id = ? AND t.demand_id = ?`,
    )
    .get(userId, demandId) as unknown as { count: number };
  return Number(row.count);
}

/**
 * Active assignments held by one user across all of their executors
 * (docs/003 §3 rule 6, S3 per-user concurrency cap).
 */
export function countActiveAssignmentsForUser(db: DatabaseSync, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM assignments WHERE state = 'active' AND user_id = ?")
    .get(userId) as unknown as { count: number };
  return Number(row.count);
}

export function listExpiredActiveAssignments(
  db: DatabaseSync,
  cutoffIso: string,
): Assignment[] {
  const rows = db
    .prepare(
      "SELECT * FROM assignments WHERE state = 'active' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? ORDER BY created_at ASC",
    )
    .all(cutoffIso) as unknown as AssignmentRow[];
  return rows.map(rowToAssignment);
}
