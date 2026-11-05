import { evaluateClaimEligibility, rankTasks, type ClaimEligibility } from '@sap-superagent/core';
import type { Task } from '@sap-superagent/protocol';
import {
  countActiveAssignmentsForUser,
  listActiveAssignmentsForExecutor,
} from './db/assignments.js';
import { getTask, listPendingTasks } from './db/tasks.js';
import type { ExecutorRecord } from './db/executors.js';
import type { ServerContext } from './types.js';

/**
 * The single eligibility implementation shared by the read path (`GET /tasks`),
 * heartbeat `offers`, `claim`, and the S3 `task.offered` WS filtering. Keeping
 * one evaluator here is what makes the push path and the pull path agree.
 */
interface ExecutorLoad {
  activeAssignments: number;
  /** Demands the executor already holds an active human task for (rule 5). */
  heldDemandIds: Set<string>;
  /** Active human tasks held by this executor's user (rule 6, S3). */
  activeForUser: number;
}

function loadExecutor(ctx: ServerContext, record: ExecutorRecord): ExecutorLoad {
  const activeAssignments = listActiveAssignmentsForExecutor(ctx.db, record.executor.id);
  const heldDemandIds = new Set<string>();
  for (const assignment of activeAssignments) {
    const task = getTask(ctx.db, assignment.taskId);
    if (task !== null) heldDemandIds.add(task.demandId);
  }
  return {
    activeAssignments: activeAssignments.length,
    heldDemandIds,
    activeForUser: countActiveAssignmentsForUser(ctx.db, record.executor.user),
  };
}

function evaluate(
  ctx: ServerContext,
  record: ExecutorRecord,
  task: Task,
  nowMs: number,
  load: ExecutorLoad,
): ClaimEligibility {
  return evaluateClaimEligibility({
    task,
    executor: record.executor,
    activeWorkspaceKey: record.executor.activeWorkspaceKey,
    nowMs,
    presenceTtlMs: ctx.config.presenceTtlMs,
    lastHeartbeatAt: record.lastHeartbeatAt,
    activeAssignmentsForExecutor: load.activeAssignments,
    activeAssignmentsForSameDemand: load.heldDemandIds.has(task.demandId) ? 1 : 0,
    activeAssignmentsForUser: load.activeForUser,
    maxConcurrentPerUser: ctx.config.maxConcurrentPerUser,
    globallyPaused: false,
  });
}

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

  const load = loadExecutor(ctx, record);
  const eligible = pending.filter((task) => evaluate(ctx, record, task, nowMs, load).eligible);
  return rankTasks(eligible, { forUserId: executor.user });
}

/**
 * Whether one concrete task should be pushed to one executor connection as a
 * `task.offered` transport frame (S3, docs/003 §3/§4.4). Reuses the exact claim
 * eligibility above, so a client never receives an offer it could not claim.
 */
export function isTaskEligibleForExecutor(
  ctx: ServerContext,
  record: ExecutorRecord,
  task: Task,
  nowMs: number,
): boolean {
  if (task.state !== 'pending') return false;
  if (task.executorKind !== record.executor.kind) return false;
  return evaluate(ctx, record, task, nowMs, loadExecutor(ctx, record)).eligible;
}
