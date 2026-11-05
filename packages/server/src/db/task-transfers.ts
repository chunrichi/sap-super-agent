import type { DatabaseSync } from 'node:sqlite';
import type { Role, TaskTransfer } from '@sap-superagent/protocol';
import { asNullableString, asString } from './rows.js';

// ---------------------------------------------------------------------------
// Task transfer audit trail (docs/003 §2.3/§4.2, S3). The task itself goes back
// to the pool; this table records who handed it over, to which role pool/user
// hint, and why. Append-only: rows are never updated.
// ---------------------------------------------------------------------------

interface TaskTransferRow {
  id: string;
  task_id: string;
  assignment_id: string;
  from_executor_id: string;
  from_user_id: string | null;
  target_user_id: string | null;
  target_role: string | null;
  comment: string | null;
  created_at: string;
}

function rowToTaskTransfer(row: TaskTransferRow): TaskTransfer {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    assignmentId: asString(row.assignment_id),
    fromExecutorId: asString(row.from_executor_id),
    fromUserId: asNullableString(row.from_user_id),
    targetUserId: asNullableString(row.target_user_id),
    targetRole: asNullableString(row.target_role) as Role | null,
    comment: asNullableString(row.comment),
    createdAt: asString(row.created_at),
  };
}

export function insertTaskTransfer(db: DatabaseSync, transfer: TaskTransfer): void {
  db.prepare(
    `INSERT INTO task_transfers (
      id, task_id, assignment_id, from_executor_id, from_user_id,
      target_user_id, target_role, comment, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transfer.id,
    transfer.taskId,
    transfer.assignmentId,
    transfer.fromExecutorId,
    transfer.fromUserId,
    transfer.targetUserId,
    transfer.targetRole,
    transfer.comment,
    transfer.createdAt,
  );
}

export function listTaskTransfersForTask(db: DatabaseSync, taskId: string): TaskTransfer[] {
  const rows = db
    .prepare('SELECT * FROM task_transfers WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as unknown as TaskTransferRow[];
  return rows.map(rowToTaskTransfer);
}
