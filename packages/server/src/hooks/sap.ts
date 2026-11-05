import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from '@sap-superagent/protocol';
import {
  mapSapDemandToControlPlane,
  verifySapHookSignature,
  type SapHookHeaders,
  type SapDemandRecord,
} from '@sap-superagent/sap-adapter';
import { canTransitionDemand, canTransitionStageRun, canTransitionTask } from '@sap-superagent/core';
import { findPendingApprovalForArtifact, getApproval, listApprovalsForDemand } from '../db/approvals.js';
import { getArtifact } from '../db/artifacts.js';
import { getActiveAssignmentForTask, updateAssignment } from '../db/assignments.js';
import { getDemand, updateDemand } from '../db/demands.js';
import { listStageRunsForDemand, updateStageRun } from '../db/stages.js';
import { listTasksForDemand, updateTask } from '../db/tasks.js';
import { writeTransaction } from '../db/transaction.js';
import { decideApprovalApprove, decideApprovalReject } from '../stage-engine.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { requireAdmin } from '../http/auth.js';
import { nowIso } from '../http/route-utils.js';
import { parseInput, sendValidated } from '../http/validate.js';
import type { ServerContext } from '../types.js';
import type { SapIntegrationConfig } from './sap-config.js';
import {
  countSapOutbox,
  createSapDemand,
  findStageArtifact,
  getSapDelivery,
  insertSapDelivery,
  upsertSapSyncVersion,
} from './sap-store.js';

// ---------------------------------------------------------------------------
// H2: inbound SAP webhook `POST /hooks/sap` (docs/003 §4.5, docs/004 §3.3).
//
// Transport: HMAC-SHA256 over the raw body (X-SA-Signature), a ±5min replay
// window (X-SA-Timestamp) and X-SA-Delivery as the idempotency key (the SAP
// outbox EVENT_ID). Deliveries are recorded in `sap_deliveries` inside the same
// transaction as the domain change, so a re-delivery after a lost response is
// answered `duplicate:true` without side effects (docs/009 #11).
// ---------------------------------------------------------------------------

const sapDemandSnapshotSchema = z
  .object({
    demandId: z.string().min(1).max(64),
    demandNo: z.string().min(1).max(64).nullable().optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(20_000).nullable().optional(),
    acceptanceCriteria: z.array(z.string().min(1)).max(50).nullable().optional(),
    requesterUserId: z.string().min(1).max(64).optional(),
    orgUnit: z.string().min(1).max(64).nullable().optional(),
    priority: z.string().min(1).max(32).nullable().optional(),
    repoKey: z.string().max(64).nullable().optional(),
    projectKey: z.string().max(40).nullable().optional(),
    templateId: z.string().max(64).nullable().optional(),
    version: z.number().int().nonnegative().optional(),
    createdAt: z.string().max(40).nullable().optional(),
    changedAt: z.string().max(40).nullable().optional(),
  })
  .passthrough();

const sapHookDataSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('demand.submitted'),
      demand: sapDemandSnapshotSchema,
      sapVersion: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('demand.updated'),
      demand: sapDemandSnapshotSchema,
      sapVersion: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('artifact.approved'),
      demandId: z.string().min(1).max(64),
      artifactId: z.string().min(1).max(64).optional(),
      version: z.number().int().positive().optional(),
      stageKey: z.string().min(1).max(64).optional(),
      gateKey: z.string().min(1).max(64).optional(),
      approvalId: z.string().min(1).max(64).optional(),
      decidedBy: z.string().min(1).max(128).optional(),
      decidedAt: z.string().max(40).optional(),
      comment: z.string().max(2_000).nullable().optional(),
      sapVersion: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('artifact.rejected'),
      demandId: z.string().min(1).max(64),
      artifactId: z.string().min(1).max(64).optional(),
      version: z.number().int().positive().optional(),
      stageKey: z.string().min(1).max(64).optional(),
      gateKey: z.string().min(1).max(64).optional(),
      approvalId: z.string().min(1).max(64).optional(),
      decidedBy: z.string().min(1).max(128).optional(),
      decidedAt: z.string().max(40).optional(),
      comment: z.string().max(2_000).nullable().optional(),
      sapVersion: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('demand.cancelled'),
      demandId: z.string().min(1).max(64),
      reason: z.string().max(1_000).nullable().optional(),
      sapVersion: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('hook.receipt'),
      demandId: z.string().min(1).max(64).optional(),
      externalId: z.string().max(128).optional(),
      status: z.string().max(32).optional(),
      detailRef: z.string().max(2_000).optional(),
    })
    .passthrough(),
]);

export const sapHookEnvelopeSchema = z
  .object({
    eventId: z.string().min(1).max(128).optional(),
    occurredAt: z.string().max(40).optional(),
    data: sapHookDataSchema,
  })
  .passthrough();

export const sapHookResponseSchema = z
  .object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    deliveryId: z.string().min(1),
    type: z.string().min(1),
    action: z.string().min(1),
    serverTime: z.string().min(1),
  })
  .strict();

export interface SapHookResult {
  type: string;
  action: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function demandRecordFromSnapshot(
  snapshot: z.infer<typeof sapDemandSnapshotSchema>,
): SapDemandRecord {
  return {
    demandId: snapshot.demandId,
    demandNo: snapshot.demandNo ?? null,
    title: snapshot.title,
    description: snapshot.description ?? null,
    acceptanceCriteria: snapshot.acceptanceCriteria ?? null,
    requesterUserId: snapshot.requesterUserId ?? null,
    orgUnit: snapshot.orgUnit ?? null,
    priority: snapshot.priority ?? null,
    repoKey: snapshot.repoKey ?? null,
    projectKey: snapshot.projectKey ?? null,
    templateId: snapshot.templateId ?? null,
    version: snapshot.version ?? null,
    createdAt: snapshot.createdAt ?? null,
    changedAt: snapshot.changedAt ?? null,
  };
}

/** Apply one verified SAP event; caller wraps it in a transaction. */
function applySapEvent(
  ctx: ServerContext,
  event: z.infer<typeof sapHookDataSchema>,
  delivery: { deliveryId: string; eventId: string; receivedAt: string },
): SapHookResult {
  return writeTransaction(ctx.db, (events) => ctx.hub.broadcast(events), (tx) => {
    const record = (type: string, action: string, demandId: string | null): SapHookResult => {
      const result: SapHookResult = { type, action };
      insertSapDelivery(tx, {
        deliveryId: delivery.deliveryId,
        eventId: delivery.eventId,
        eventType: type,
        demandId,
        receivedAt: delivery.receivedAt,
        state: 'APPLIED',
        result: JSON.stringify(result),
      });
      return result;
    };

    switch (event.type) {
      case 'demand.submitted': {
        const input = mapSapDemandToControlPlane(demandRecordFromSnapshot(event.demand));
        const created = createSapDemand(tx, ctx, input);
        const sapVersion = event.sapVersion ?? event.demand.version;
        if (sapVersion !== undefined) {
          upsertSapSyncVersion(tx.db, input.demandId, sapVersion, tx.now);
        }
        return record('demand.submitted', created.created ? 'demand_created' : 'demand_exists', input.demandId);
      }

      case 'demand.updated': {
        const mapped = mapSapDemandToControlPlane(demandRecordFromSnapshot(event.demand));
        const existing = getDemand(tx.db, mapped.demandId);
        if (existing === null) throw notFound(`demand ${mapped.demandId} not found`);
        const changedFields: string[] = [];
        const next = { ...existing };
        if (mapped.title !== existing.title) {
          next.title = mapped.title;
          changedFields.push('title');
        }
        if (mapped.description !== existing.description) {
          next.description = mapped.description;
          changedFields.push('description');
        }
        if (JSON.stringify(mapped.acceptanceCriteria) !== JSON.stringify(existing.acceptanceCriteria)) {
          next.acceptanceCriteria = mapped.acceptanceCriteria;
          changedFields.push('acceptanceCriteria');
        }
        if (mapped.priority !== existing.priority) {
          next.priority = mapped.priority;
          changedFields.push('priority');
        }
        if (
          mapped.requester.userId !== existing.requester.userId ||
          mapped.requester.orgUnit !== existing.requester.orgUnit
        ) {
          next.requester = mapped.requester;
          changedFields.push('requester');
        }
        if (JSON.stringify(mapped.workspaceBinding) !== JSON.stringify(existing.workspaceBinding)) {
          next.workspaceBinding = mapped.workspaceBinding;
          changedFields.push('workspaceBinding');
        }
        if (event.demand.version !== undefined) {
          upsertSapSyncVersion(tx.db, mapped.demandId, event.demand.version, tx.now);
        }
        if (changedFields.length > 0) {
          updateDemand(tx.db, { ...next, updatedAt: tx.now });
          tx.append({
            type: 'demand.updated',
            subject: { type: 'demand', id: mapped.demandId },
            data: {
              demandId: mapped.demandId,
              reason: 'sap_field_sync',
              changedFields,
            },
            demandId: mapped.demandId,
          });
        }
        return record('demand.updated', changedFields.length > 0 ? 'demand_updated' : 'no_op', mapped.demandId);
      }

      case 'demand.cancelled': {
        const demand = getDemand(tx.db, event.demandId);
        if (demand === null) throw notFound(`demand ${event.demandId} not found`);
        if (!canTransitionDemand(demand.status, 'cancelled')) {
          return record('demand.cancelled', 'already_terminal', demand.id);
        }
        updateDemand(tx.db, { ...demand, status: 'cancelled', updatedAt: tx.now });
        tx.append({
          type: 'demand.cancelled',
          subject: { type: 'demand', id: demand.id },
          data: { demandId: demand.id, reason: event.reason ?? 'cancelled_in_sap' },
          demandId: demand.id,
        });
        for (const stageRun of listStageRunsForDemand(tx.db, demand.id)) {
          if (!canTransitionStageRun(stageRun.status, 'cancelled')) continue;
          updateStageRun(tx.db, {
            ...stageRun,
            status: 'cancelled',
            finishedAt: tx.now,
            updatedAt: tx.now,
          });
          tx.append({
            type: 'stage.cancelled',
            subject: { type: 'stage_run', id: stageRun.id },
            data: { stageRunId: stageRun.id, demandId: demand.id, stageKey: stageRun.stageKey },
            demandId: demand.id,
          });
        }
        for (const task of listTasksForDemand(tx.db, demand.id)) {
          if (!canTransitionTask(task.state, 'cancelled')) continue;
          const assignment = getActiveAssignmentForTask(tx.db, task.id);
          if (assignment !== null) {
            updateAssignment(tx.db, {
              ...assignment,
              state: 'released',
              updatedAt: tx.now,
              endedAt: tx.now,
            });
            tx.append({
              type: 'assignment.released',
              subject: { type: 'assignment', id: assignment.id },
              data: {
                assignmentId: assignment.id,
                taskId: task.id,
                executorId: assignment.executorId,
                reason: 'demand_cancelled_in_sap',
              },
              demandId: demand.id,
            });
          }
          updateTask(tx.db, { ...task, state: 'cancelled', updatedAt: tx.now });
          tx.append({
            type: 'task.cancelled',
            subject: { type: 'task', id: task.id },
            data: { taskId: task.id, demandId: demand.id, reason: 'demand_cancelled_in_sap' },
            demandId: demand.id,
          });
        }
        return record('demand.cancelled', 'demand_cancelled', demand.id);
      }

      case 'artifact.approved':
      case 'artifact.rejected': {
        const approved = event.type === 'artifact.approved';
        const demand = getDemand(tx.db, event.demandId);
        if (demand === null) throw notFound(`demand ${event.demandId} not found`);

        // --- H1 owns the gate state machine (docs/003 §2.2/§2.5) ---
        // A SAP decision resolves the pending control-plane Approval: approve
        // ends the stage and advances the template, reject starts a new attempt
        // with a fresh artifact version. We only locate the approval; a decision
        // for an already resolved/expired gate is an idempotent no-op so a
        // repeated SAP delivery cannot double-advance the workflow (009 #11).
        const stageRuns = listStageRunsForDemand(tx.db, demand.id);
        const stageRun =
          event.stageKey === undefined
            ? stageRuns.find((run) => run.status === 'waiting_human')
            : stageRuns.find((run) => run.stageKey === event.stageKey);
        const referencedArtifact =
          event.artifactId === undefined
            ? (stageRun === undefined
                ? null
                : findStageArtifact(tx.db, demand.id, stageRun.stageKey)?.artifact ?? null)
            : getArtifact(tx.db, event.artifactId);
        // H1 binds every pending gate to an immutable artifact version; resolve
        // by that binding first (SAP sends its own approval id, not ours).
        const approval =
          (referencedArtifact === null
            ? null
            : findPendingApprovalForArtifact(
                tx.db,
                referencedArtifact.id,
                referencedArtifact.currentVersion,
              )) ??
          (stageRun === undefined
            ? null
            : (listApprovalsForDemand(tx.db, demand.id).find(
                (candidate) => candidate.stageRunId === stageRun.id && candidate.state === 'pending',
              ) ?? null)) ??
          (event.approvalId === undefined ? null : getApproval(tx.db, event.approvalId));
        if (approval === null || approval.state !== 'pending') {
          return record(event.type, 'no_pending_approval', demand.id);
        }
        const decidedBy = event.decidedBy ?? 'sap';
        const comment = event.comment ?? null;
        if (approved) {
          decideApprovalApprove(tx, ctx, approval, decidedBy, comment);
        } else {
          decideApprovalReject(tx, ctx, approval, decidedBy, comment);
        }
        // Keep the SAP optimistic-concurrency cursor in sync when the push
        // event carries the SAP VERSION (docs/004 §2.2).
        if (event.sapVersion !== undefined) {
          upsertSapSyncVersion(tx.db, demand.id, event.sapVersion, tx.now);
        }
        return record(event.type, approved ? 'stage_advanced' : 'stage_reopened', demand.id);
      }

      case 'hook.receipt': {
        const demandId = event.demandId ?? null;
        return record('hook.receipt', 'receipt_recorded', demandId);
      }
    }
  });
}

async function handleSapHook(
  ctx: ServerContext,
  sap: SapIntegrationConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const rawBody = typeof request.body === 'string' ? request.body : '';
  if (rawBody.length === 0) throw badRequest('SAP hook body must not be empty');

  const verification = verifySapHookSignature({
    secret: sap.hookSecret,
    body: rawBody,
    headers: request.headers as SapHookHeaders,
    // Transport frames point at the time they were signed; the server clock is
    // the only clock that matters for the replay window.
    now: Date.now(),
    toleranceMs: sap.hookToleranceMs,
  });
  if (!verification.ok) {
    throw unauthorized(`SAP webhook rejected (${verification.code}): ${verification.message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody) as unknown;
  } catch {
    throw badRequest('SAP hook body is not valid JSON');
  }
  const envelope = parseInput(sapHookEnvelopeSchema, parsedJson, 'sap hook body');
  const delivery = verification.delivery;
  const eventId = envelope.eventId ?? delivery;
  if (envelope.eventId !== undefined && envelope.eventId !== delivery) {
    throw badRequest('body.eventId must match the X-SA-Delivery header');
  }

  const existing = getSapDelivery(ctx.db, delivery);
  if (existing !== null) {
    const stored = parseStoredResult(existing.result);
    return sendValidated(reply, sapHookResponseSchema, {
      accepted: true,
      duplicate: true,
      deliveryId: delivery,
      type: existing.eventType,
      action: stored,
      serverTime: nowIso(ctx),
    });
  }

  let result: SapHookResult;
  try {
    result = applySapEvent(ctx, envelope.data, {
      deliveryId: delivery,
      eventId,
      receivedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('sap demandId')) {
      throw badRequest(errorMessage(error));
    }
    if (error instanceof Error && error.message.startsWith('sap demand ')) {
      throw badRequest(errorMessage(error));
    }
    throw error;
  }

  return sendValidated(reply, sapHookResponseSchema, {
    accepted: true,
    duplicate: false,
    deliveryId: delivery,
    type: result.type,
    action: result.action,
    serverTime: nowIso(ctx),
  });
}

function parseStoredResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as { action?: unknown };
    return typeof parsed.action === 'string' ? parsed.action : 'no_op';
  } catch {
    return 'no_op';
  }
}

/**
 * Register the SAP integration routes. When `SA_SAP_HOOK_SECRET` is missing the
 * inbound webhook is *not registered* (integration auto-disabled, H2 §1.5), so
 * H0/H1 behaviour is unchanged.
 */
export function registerSapRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const sap = ctx.sap;
  if (sap === undefined) return;

  if (sap.hookEnabled) {
    app.register(async (scope) => {
      scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
        done(null, body);
      });
      scope.post('/hooks/sap', async (request, reply) => handleSapHook(ctx, sap, request, reply));
    });
  }

  if (sap.enabled || sap.hookEnabled) {
    app.get('/hooks/sap/status', async (request: FastifyRequest, reply: FastifyReply) => {
      requireAdmin(ctx, request);
      const outbox = countSapOutbox(ctx.db);
      return reply.send({
        enabled: { outbound: sap.enabled, inbound: sap.hookEnabled },
        outbox,
        serverTime: nowIso(ctx),
      });
    });
  }
}
