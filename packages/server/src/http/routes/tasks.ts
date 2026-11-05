import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_LEASE_RENEW_INTERVAL_MS,
  claimTaskResponseSchema,
  completeTaskBodySchema,
  completeTaskResponseSchema,
  failTaskBodySchema,
  failTaskResponseSchema,
  leaseRenewResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
  newUlid,
  progressBodySchema,
  releaseTaskResponseSchema,
  submitArtifactBodySchema,
  submitArtifactResponseSchema,
  taskContextResponseSchema,
  taskDetailResponseSchema,
  taskStateSchema,
  type Artifact,
  type ArtifactVersion,
  type Assignment,
  type StageRun,
  type Task,
  type TaskContext,
} from '@sap-superagent/protocol';
import {
  buildTaskContextMarkdown,
  canTransitionStageRun,
  canTransitionTask,
  evaluateClaimEligibility,
  findStage,
  isLeaseExpired,
  rankTasks,
} from '@sap-superagent/core';
import {
  artifactContentRef,
  checksumOfBytes,
  writeArtifactBytes,
} from '../../artifact-store.js';
import {
  countActiveAssignmentsForUser,
  getActiveAssignmentForTask,
  getActiveAssignmentForTaskAndExecutor,
  insertAssignment,
  listActiveAssignmentsForExecutor,
  updateAssignment,
  updateAssignmentLease,
} from '../../db/assignments.js';
import {
  findArtifactByKind,
  insertArtifact,
  insertArtifactVersion,
  latestVersionsByKind,
  listArtifactsForDemand,
  updateArtifact,
} from '../../db/artifacts.js';
import { getDemand } from '../../db/demands.js';
import { getExecutor } from '../../db/executors.js';
import { getStageRun, updateStageRun } from '../../db/stages.js';
import { addLastHolder, getTask, listTasksByState, updateTask } from '../../db/tasks.js';
import { writeTransaction, type TransactionContext } from '../../db/transaction.js';
import {
  badRequest,
  conflict,
  invalidState,
  leaseExpired,
  notFound,
  unauthorized,
} from '../../errors.js';
import { requireExecutor, requireKinds } from '../auth.js';
import { nowIso, paramId, publish } from '../route-utils.js';
import { parseInput, sendValidated } from '../validate.js';
import { requireActiveLease } from '../../lease.js';
import {
  completeVscodeTaskStage,
  failVscodeTaskStage,
  propagateStaleForArtifact,
} from '../../stage-engine.js';
import { listEligiblePendingTasks } from '../../offers.js';
import type { ServerContext } from '../../types.js';

export const ALLOWED_TASK_ACTIONS: readonly string[] = [
  'edit_workspace',
  'run_abap_check',
  'submit_artifact',
  'report_progress',
];

export const FORBIDDEN_TASK_ACTIONS: readonly string[] = [
  'write_production_sap',
  'push_to_main',
  'delete_sap_objects',
];

function buildTaskContext(
  ctx: ServerContext,
  task: Task,
  demand: NonNullable<ReturnType<typeof getDemand>>,
): TaskContext {
  const template = ctx.templates.get(demand.templateId);
  let stage: TaskContext['stage'] = null;
  const inputArtifacts: TaskContext['inputArtifacts'] = [];
  if (task.stageRunId !== null && template !== undefined) {
    const stageRun = getStageRun(ctx.db, task.stageRunId);
    const stageTemplate = stageRun === null ? undefined : findStage(template, stageRun.stageKey);
    if (stageTemplate !== undefined) {
      stage = {
        key: stageTemplate.key,
        name: stageTemplate.name,
        outputArtifactKind: stageTemplate.outputArtifactKind,
      };
      const latest = latestVersionsByKind(ctx.db, demand.id);
      for (const kind of stageTemplate.inputArtifactKinds) {
        const entry = latest.get(kind);
        if (entry === undefined) continue;
        inputArtifacts.push({
          artifactId: entry.artifact.id,
          version: entry.version.version,
          kind,
          summary: entry.version.summary,
          contentRef: entry.version.contentRef,
        });
      }
    }
  }
  return {
    task,
    demand: {
      id: demand.id,
      title: demand.title,
      description: demand.description,
      acceptanceCriteria: demand.acceptanceCriteria,
      priority: demand.priority,
      requester: demand.requester,
    },
    stage,
    inputArtifacts,
    workspaceBinding: task.workspaceBinding,
    allowedActions: [...ALLOWED_TASK_ACTIONS],
    forbiddenActions: [...FORBIDDEN_TASK_ACTIONS],
    generatedAt: nowIso(ctx),
  };
}

function finishTask(
  ctx: ServerContext,
  taskId: string,
  executorId: string,
  target: 'completed' | 'failed',
  appendEvents: (tx: TransactionContext, task: Task) => void,
): Task {
  const lease = requireActiveLease(ctx.db, taskId, executorId, ctx.clock());
  if (!canTransitionTask(lease.task.state, target)) {
    throw invalidState(`cannot change task ${taskId} from ${lease.task.state} to ${target}`);
  }
  return writeTransaction(ctx.db, publish(ctx), (tx) => {
    const current = getTask(ctx.db, taskId);
    if (current === null) throw notFound(`task ${taskId} not found`);
    const updated: Task = { ...current, state: target, updatedAt: tx.now };
    updateTask(ctx.db, updated);
    appendEvents(tx, current);
    return updated;
  });
}

function endAssignmentForTask(
  ctx: ServerContext,
  tx: TransactionContext,
  taskId: string,
  executorId: string,
  task: Task,
): void {
  const assignment = getActiveAssignmentForTaskAndExecutor(ctx.db, taskId, executorId);
  if (assignment === null) return;
  updateAssignment(ctx.db, {
    ...assignment,
    state: 'completed',
    updatedAt: tx.now,
    endedAt: tx.now,
  });
  tx.append({
    type: 'assignment.completed',
    subject: { type: 'assignment', id: assignment.id },
    data: { assignmentId: assignment.id, taskId, executorId },
    demandId: task.demandId,
  });
}

export function registerTaskRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get(
    '/api/v1/tasks',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireKinds(ctx, request, ['executor', 'admin']);
      const query = parseInput(listTasksQuerySchema, request.query, 'listTasks query');
      const nowMs = ctx.clock();
      let tasks: Task[];
      if (claims.kind === 'executor') {
        if (claims.executorId === undefined) {
          throw unauthorized('executor token is missing its executorId');
        }
        const record = getExecutor(ctx.db, claims.executorId);
        if (record === null) throw unauthorized('unknown executor; register again');
        tasks = listEligiblePendingTasks(ctx, record, nowMs).slice(0, query.limit);
      } else {
        const state = parseInput(taskStateSchema, query.state ?? 'pending', 'task state');
        tasks = rankTasks(listTasksByState(ctx.db, state, query.limit));
      }
      return sendValidated(reply, listTasksResponseSchema, {
        tasks,
        serverTime: new Date(nowMs).toISOString(),
      });
    },
  );

  app.get(
    '/api/v1/tasks/:id',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireKinds(ctx, request, ['executor', 'admin']);
      const taskId = paramId(request);
      const task = getTask(ctx.db, taskId);
      if (task === null) throw notFound(`task ${taskId} not found`);
      const demand = getDemand(ctx.db, task.demandId);
      if (demand === null) throw notFound(`demand ${task.demandId} not found`);
      return sendValidated(reply, taskDetailResponseSchema, {
        task,
        demand: {
          id: demand.id,
          title: demand.title,
          status: demand.status,
          priority: demand.priority,
        },
        artifacts: listArtifactsForDemand(ctx.db, demand.id),
        serverTime: nowIso(ctx),
      });
    },
  );

  app.get(
    '/api/v1/tasks/:id/context',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireKinds(ctx, request, ['executor', 'admin']);
      const taskId = paramId(request);
      const task = getTask(ctx.db, taskId);
      if (task === null) throw notFound(`task ${taskId} not found`);
      const demand = getDemand(ctx.db, task.demandId);
      if (demand === null) throw notFound(`demand ${task.demandId} not found`);
      const context = buildTaskContext(ctx, task, demand);
      return sendValidated(reply, taskContextResponseSchema, {
        markdown: buildTaskContextMarkdown(context),
        json: context,
      });
    },
  );

  app.post(
    '/api/v1/tasks/:id/claim',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireExecutor(ctx, request);
      const taskId = paramId(request);
      const nowMs = ctx.clock();
      const result = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const task = getTask(ctx.db, taskId);
        if (task === null) throw notFound(`task ${taskId} not found`);
        const record = getExecutor(ctx.db, claims.executorId);
        if (record === null) throw unauthorized('unknown executor; register again');
        if (task.state !== 'pending') {
          const holder = getActiveAssignmentForTask(ctx.db, taskId);
          throw conflict(`task ${taskId} is no longer pending`, {
            taskId,
            state: task.state,
            holder:
              holder === null
                ? null
                : {
                    executorId: holder.executorId,
                    userId: holder.userId,
                    leaseExpiresAt: holder.leaseExpiresAt,
                  },
          });
        }
        const activeAssignments = listActiveAssignmentsForExecutor(ctx.db, claims.executorId);
        let activeForSameDemand = 0;
        if (record.executor.kind === 'vscode') {
          for (const assignment of activeAssignments) {
            const heldTask = getTask(ctx.db, assignment.taskId);
            if (heldTask !== null && heldTask.demandId === task.demandId) activeForSameDemand += 1;
          }
        }
        const eligibility = evaluateClaimEligibility({
          task,
          executor: record.executor,
          activeWorkspaceKey: record.executor.activeWorkspaceKey,
          nowMs,
          presenceTtlMs: ctx.config.presenceTtlMs,
          lastHeartbeatAt: record.lastHeartbeatAt,
          activeAssignmentsForExecutor: activeAssignments.length,
          activeAssignmentsForSameDemand: activeForSameDemand,
          // --- S3: per-user cap for human tasks (docs/003 §3 rule 6) ---
          activeAssignmentsForUser: countActiveAssignmentsForUser(
            ctx.db,
            record.executor.user,
          ),
          maxConcurrentPerUser: ctx.config.maxConcurrentPerUser,
          globallyPaused: false,
        });
        if (!eligibility.eligible) {
          throw conflict(`task ${taskId} is not claimable by this executor`, {
            taskId,
            state: task.state,
            holder: null,
            reasons: eligibility.reasons,
          });
        }
        const claimed: Task = { ...task, state: 'claimed', updatedAt: tx.now };
        updateTask(ctx.db, claimed);
        const leaseExpiresAt = new Date(nowMs + ctx.config.leaseTtlMs).toISOString();
        const assignment: Assignment = {
          id: newUlid(),
          taskId,
          executorId: claims.executorId,
          userId: record.executor.user,
          state: 'active',
          leaseExpiresAt,
          createdAt: tx.now,
          updatedAt: tx.now,
          endedAt: null,
        };
        insertAssignment(ctx.db, assignment);
        tx.append({
          type: 'task.claimed',
          subject: { type: 'task', id: taskId },
          data: {
            taskId,
            demandId: task.demandId,
            executorId: claims.executorId,
            userId: record.executor.user,
            assignmentId: assignment.id,
            leaseExpiresAt,
          },
          demandId: task.demandId,
        });
        tx.append({
          type: 'assignment.created',
          subject: { type: 'assignment', id: assignment.id },
          data: {
            assignmentId: assignment.id,
            taskId,
            executorId: claims.executorId,
            leaseExpiresAt,
          },
          demandId: task.demandId,
        });
        // --- H1: a claimed stage task moves its StageRun ready -> running ---
        if (task.stageRunId !== null) {
          const stageRun = getStageRun(ctx.db, task.stageRunId);
          if (stageRun !== null && canTransitionStageRun(stageRun.status, 'running')) {
            const running: StageRun = {
              ...stageRun,
              status: 'running',
              startedAt: tx.now,
              updatedAt: tx.now,
            };
            updateStageRun(ctx.db, running);
            tx.append({
              type: 'stage.started',
              subject: { type: 'stage_run', id: running.id },
              data: {
                stageRunId: running.id,
                demandId: task.demandId,
                stageKey: running.stageKey,
                attempt: running.attempt,
                executorKind: running.executorKind,
                executorId: claims.executorId,
              },
              demandId: task.demandId,
            });
          }
        }
        return { task: claimed, leaseExpiresAt };
      });
      return sendValidated(reply, claimTaskResponseSchema, {
        task: result.task,
        lease: {
          expiresAt: result.leaseExpiresAt,
          renewIntervalMs: DEFAULT_LEASE_RENEW_INTERVAL_MS,
        },
        contextUrl: `/api/v1/tasks/${taskId}/context`,
        serverTime: new Date(nowMs).toISOString(),
      });
    },
  );

  app.post(
    '/api/v1/tasks/:id/lease/renew',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireExecutor(ctx, request);
      const taskId = paramId(request);
      const nowMs = ctx.clock();
      const task = getTask(ctx.db, taskId);
      if (task === null) throw notFound(`task ${taskId} not found`);
      const assignment = getActiveAssignmentForTaskAndExecutor(ctx.db, taskId, claims.executorId);
      if (assignment === null) {
        throw leaseExpired('this executor holds no active lease for the task');
      }
      if (task.state !== 'claimed' && task.state !== 'in_progress') {
        throw leaseExpired(`task is ${task.state}; re-read the task before renewing`);
      }
      if (isLeaseExpired(assignment.leaseExpiresAt, nowMs)) {
        throw leaseExpired('lease expired; re-read the task state and claim again');
      }
      const expiresAt = new Date(nowMs + ctx.config.leaseTtlMs).toISOString();
      updateAssignmentLease(ctx.db, assignment.id, expiresAt, new Date(nowMs).toISOString());
      return sendValidated(reply, leaseRenewResponseSchema, {
        lease: { expiresAt, renewIntervalMs: DEFAULT_LEASE_RENEW_INTERVAL_MS },
        serverTime: new Date(nowMs).toISOString(),
      });
    },
  );

  app.post(
    '/api/v1/tasks/:id/progress',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireExecutor(ctx, request);
      const taskId = paramId(request);
      const lease = requireActiveLease(ctx.db, taskId, claims.executorId, ctx.clock());
      const body = parseInput(progressBodySchema, request.body, 'progress body');
      const serverTime = nowIso(ctx);
      writeTransaction(ctx.db, publish(ctx), (tx) => {
        tx.append({
          type: 'task.progress',
          subject: { type: 'task', id: taskId },
          data: { taskId, demandId: lease.task.demandId, executorId: claims.executorId, ...body },
          demandId: lease.task.demandId,
        });
      });
      return reply.send({ ok: true, serverTime });
    },
  );

  app.post(
    '/api/v1/tasks/:id/artifacts',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireExecutor(ctx, request);
      const taskId = paramId(request);
      const lease = requireActiveLease(ctx.db, taskId, claims.executorId, ctx.clock());
      const body = parseInput(submitArtifactBodySchema, request.body, 'artifact body');
      if (body.contentBase64 === undefined) {
        throw badRequest('contentUrl is not supported by the M1 control plane; send contentBase64');
      }
      const bytes = Buffer.from(body.contentBase64, 'base64');
      const checksum = checksumOfBytes(bytes);
      if (checksum !== body.checksum) {
        throw badRequest(`checksum mismatch: declared ${body.checksum}, computed ${checksum}`);
      }
      // --- H1: revisions of the same kind create new immutable versions ---
      const existing = findArtifactByKind(ctx.db, lease.task.demandId, body.kind);
      const artifactId = existing === null ? newUlid() : existing.id;
      const versionNumber = existing === null ? 1 : existing.currentVersion + 1;
      const contentRef = artifactContentRef(artifactId, versionNumber);
      writeArtifactBytes(ctx.config.stateDir, artifactId, versionNumber, bytes);
      const stageRun =
        lease.task.stageRunId === null ? null : getStageRun(ctx.db, lease.task.stageRunId);
      const stageKey = stageRun === null ? null : stageRun.stageKey;
      const result = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const artifact: Artifact = {
          id: artifactId,
          demandId: lease.task.demandId,
          kind: body.kind,
          stageKey,
          stageRunId: lease.task.stageRunId,
          state: 'generated',
          currentVersion: versionNumber,
          title: body.title ?? null,
          createdAt: existing === null ? tx.now : existing.createdAt,
          updatedAt: tx.now,
        };
        if (existing === null) insertArtifact(ctx.db, artifact);
        else updateArtifact(ctx.db, artifact);
        const version: ArtifactVersion = {
          artifactId,
          version: versionNumber,
          contentRef,
          contentType: body.contentType,
          checksum,
          summary: body.summary ?? null,
          authorType: 'agent',
          authorId: claims.sub,
          stale: false,
          createdAt: tx.now,
        };
        insertArtifactVersion(ctx.db, version);
        let taskState = lease.task.state;
        if (taskState === 'claimed') {
          const inProgress: Task = { ...lease.task, state: 'in_progress', updatedAt: tx.now };
          updateTask(ctx.db, inProgress);
          taskState = 'in_progress';
        }
        tx.append({
          type: 'artifact.created',
          subject: { type: 'artifact', id: artifactId },
          data: {
            artifactId,
            demandId: lease.task.demandId,
            kind: body.kind,
            version: versionNumber,
            checksum,
            contentRef,
            taskId,
            authorType: 'agent',
            authorId: claims.sub,
            supersedes: versionNumber > 1 ? versionNumber - 1 : null,
          },
          demandId: lease.task.demandId,
        });
        if (versionNumber > 1) {
          propagateStaleForArtifact(tx, ctx, lease.task.demandId, body.kind, versionNumber);
        }
        return { artifact, version, taskState };
      });
      return sendValidated(reply, submitArtifactResponseSchema, {
        artifact: result.artifact,
        version: result.version,
        taskState: result.taskState,
        serverTime: nowIso(ctx),
      });
    },
  );

  app.post(
    '/api/v1/tasks/:id/complete',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireExecutor(ctx, request);
      const taskId = paramId(request);
      const body = parseInput(completeTaskBodySchema, request.body, 'complete body');
      const lease = requireActiveLease(ctx.db, taskId, claims.executorId, ctx.clock());
      if (!canTransitionTask(lease.task.state, 'completed')) {
        throw invalidState(`cannot change task ${taskId} from ${lease.task.state} to completed`);
      }
      const task = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const current = getTask(ctx.db, taskId);
        if (current === null) throw notFound(`task ${taskId} not found`);
        const updated: Task = { ...current, state: 'completed', updatedAt: tx.now };
        updateTask(ctx.db, updated);
        endAssignmentForTask(ctx, tx, taskId, claims.executorId, current);
        tx.append({
          type: 'task.completed',
          subject: { type: 'task', id: taskId },
          data: {
            taskId,
            demandId: current.demandId,
            executorId: claims.executorId,
            summary: body.summary,
            artifactIds: body.artifactIds,
            links: body.links,
            openQuestions: body.openQuestions,
          },
          demandId: current.demandId,
        });
        // --- H1: completing a stage task evaluates schema + checklist ---
        completeVscodeTaskStage(tx, ctx, { task: current, artifactIds: body.artifactIds });
        return updated;
      });
      return sendValidated(reply, completeTaskResponseSchema, {
        task,
        serverTime: nowIso(ctx),
      });
    },
  );

  app.post(
    '/api/v1/tasks/:id/fail',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireExecutor(ctx, request);
      const taskId = paramId(request);
      const body = parseInput(failTaskBodySchema, request.body, 'fail body');
      const task = finishTask(ctx, taskId, claims.executorId, 'failed', (tx, current) => {
        endAssignmentForTask(ctx, tx, taskId, claims.executorId, current);
        tx.append({
          type: 'task.failed',
          subject: { type: 'task', id: taskId },
          data: {
            taskId,
            demandId: current.demandId,
            executorId: claims.executorId,
            reason: body.reason,
            retryable: body.retryable,
          },
          demandId: current.demandId,
        });
        // --- H1: a failed stage task retries (or parks) the stage attempt ---
        failVscodeTaskStage(tx, ctx, {
          task: current,
          reason: body.reason,
          allowRetry: body.retryable,
        });
      });
      return sendValidated(reply, failTaskResponseSchema, { task, serverTime: nowIso(ctx) });
    },
  );

  app.post(
    '/api/v1/tasks/:id/release',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireExecutor(ctx, request);
      const taskId = paramId(request);
      const lease = requireActiveLease(ctx.db, taskId, claims.executorId, ctx.clock());
      if (!canTransitionTask(lease.task.state, 'pending')) {
        throw invalidState(`cannot return task ${taskId} to the pool from ${lease.task.state}`);
      }
      const task = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const userId = lease.assignment.userId ?? claims.sub;
        const updated: Task = {
          ...lease.task,
          state: 'pending',
          lastHolderUserIds: addLastHolder(lease.task.lastHolderUserIds, userId),
          updatedAt: tx.now,
        };
        updateTask(ctx.db, updated);
        updateAssignment(ctx.db, {
          ...lease.assignment,
          state: 'released',
          updatedAt: tx.now,
          endedAt: tx.now,
        });
        tx.append({
          type: 'task.released',
          subject: { type: 'task', id: taskId },
          data: {
            taskId,
            demandId: updated.demandId,
            executorId: claims.executorId,
            lastHolderUserIds: updated.lastHolderUserIds,
          },
          demandId: updated.demandId,
        });
        tx.append({
          type: 'assignment.released',
          subject: { type: 'assignment', id: lease.assignment.id },
          data: {
            assignmentId: lease.assignment.id,
            taskId,
            executorId: claims.executorId,
            reason: 'released_by_executor',
          },
          demandId: updated.demandId,
        });
        return updated;
      });
      return sendValidated(reply, releaseTaskResponseSchema, {
        task,
        serverTime: nowIso(ctx),
      });
    },
  );
}
