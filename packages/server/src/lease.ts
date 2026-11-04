import type { Assignment, EventType, Task } from '@sap-superagent/protocol';
import { canReturnTaskToPool, isLeaseExpired } from '@sap-superagent/core';
import {
  getActiveAssignmentForTaskAndExecutor,
  listActiveAssignmentsForExecutor,
  updateAssignment,
} from './db/assignments.js';
import { getTask, updateTask, addLastHolder } from './db/tasks.js';
import type { TransactionContext } from './db/transaction.js';
import type { DatabaseSync } from 'node:sqlite';
import { leaseExpired, notFound } from './errors.js';

export interface ActiveLease {
  task: Task;
  assignment: Assignment;
}

/**
 * Every executor write must hold a live lease (docs/003 §2.3). Expiry is judged
 * only against server time, never the client clock.
 */
export function requireActiveLease(
  db: DatabaseSync,
  taskId: string,
  executorId: string,
  nowMs: number,
): ActiveLease {
  const task = getTask(db, taskId);
  if (task === null) throw notFound(`task ${taskId} not found`);
  const assignment = getActiveAssignmentForTaskAndExecutor(db, taskId, executorId);
  if (assignment === null) {
    throw leaseExpired('this executor holds no active lease for the task');
  }
  if (task.state !== 'claimed' && task.state !== 'in_progress') {
    throw leaseExpired(`task is ${task.state}; re-read the task before retrying`);
  }
  if (isLeaseExpired(assignment.leaseExpiresAt, nowMs)) {
    throw leaseExpired('lease expired; re-read the task state and claim again');
  }
  return { task, assignment };
}

/** End one assignment and (for released/expired) return its task to the pool. */
export function endAssignment(
  tx: TransactionContext,
  assignment: Assignment,
  state: 'released' | 'expired' | 'completed',
  eventType: EventType,
  extraData: Record<string, unknown> = {},
): string | null {
  const ended: Assignment = {
    ...assignment,
    state,
    updatedAt: tx.now,
    endedAt: tx.now,
  };
  updateAssignment(tx.db, ended);
  const task = getTask(tx.db, assignment.taskId);
  const data: Record<string, unknown> = {
    assignmentId: assignment.id,
    taskId: assignment.taskId,
    executorId: assignment.executorId,
    userId: assignment.userId,
    ...extraData,
  };
  tx.append({
    type: eventType,
    subject: { type: 'assignment', id: assignment.id },
    data,
    ...(task === null ? {} : { demandId: task.demandId }),
  });
  if (task === null || state === 'completed' || !canReturnTaskToPool(task.state)) return null;
  const userId = assignment.userId;
  const lastHolderUserIds =
    userId === null ? task.lastHolderUserIds : addLastHolder(task.lastHolderUserIds, userId);
  const returned: Task = {
    ...task,
    state: 'pending',
    lastHolderUserIds,
    updatedAt: tx.now,
  };
  updateTask(tx.db, returned);
  tx.append({
    type: 'task.updated',
    subject: { type: 'task', id: task.id },
    data: {
      taskId: task.id,
      demandId: task.demandId,
      state: 'pending',
      lastHolderUserIds,
    },
    demandId: task.demandId,
  });
  return task.id;
}

/** Release every active assignment held by an executor (offline / unregister). */
export function releaseAssignmentsForExecutor(
  tx: TransactionContext,
  executorId: string,
  reason: string,
): string[] {
  const active = listActiveAssignmentsForExecutor(tx.db, executorId);
  const releasedTaskIds: string[] = [];
  for (const assignment of active) {
    const taskId = endAssignment(tx, assignment, 'released', 'assignment.released', {
      reason,
    });
    if (taskId !== null) releasedTaskIds.push(taskId);
  }
  return releasedTaskIds;
}
