import { evaluateClaimEligibility, rankTasks } from '@sap-superagent/core';
import type { Task } from '@sap-superagent/protocol';
import { listActiveAssignmentsForExecutor } from './db/assignments.js';
import { getTask, listPendingTasks } from './db/tasks.js';
import type { ExecutorRecord } from './db/executors.js';
import type { ServerContext } from './types.js';

/**
 * Pending tasks the executor is currently allowed to claim (docs/003 §3),
 * ranked by priority → dueAt → createdAt.
 */
export function listEligiblePendingTasks(
  ctx: ServerContext,
  record: ExecutorRecord,
  nowMs: number,
): Task[] {
  const executor = record.executor;
  const pending = listPendingTasks(ctx.db, executor.kind);
  if (pending.length === 0) return [];

  const activeAssignments = listActiveAssignmentsForExecutor(ctx.db, executor.id);
  const heldDemandIds = new Set<string>();
  for (const assignment of activeAssignments) {
    const task = getTask(ctx.db, assignment.taskId);
    if (task !== null) heldDemandIds.add(task.demandId);
  }

  const eligible = pending.filter((task) => {
    const eligibility = evaluateClaimEligibility({
      task,
      executor,
      activeWorkspaceKey: executor.activeWorkspaceKey,
      nowMs,
      presenceTtlMs: ctx.config.presenceTtlMs,
      lastHeartbeatAt: record.lastHeartbeatAt,
      activeAssignmentsForExecutor: activeAssignments.length,
      activeAssignmentsForSameDemand: heldDemandIds.has(task.demandId) ? 1 : 0,
      globallyPaused: false,
    });
    return eligibility.eligible;
  });
  return rankTasks(eligible, { forUserId: executor.user });
}
