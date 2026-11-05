import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  cancelDemandBodySchema,
  cancelDemandResponseSchema,
  createDemandArtifactBodySchema,
  createDemandArtifactResponseSchema,
  createDemandBodySchema,
  createDemandResponseSchema,
  demandDetailResponseSchema,
  demandStatusSchema,
  listDemandsQuerySchema,
  listDemandsResponseSchema,
  newDemandId,
  newUlid,
  type Artifact,
  type ArtifactVersion,
  type Demand,
  type StageRun,
} from '@sap-superagent/protocol';
import {
  canTransitionDemand,
  canTransitionStageRun,
  canTransitionTask,
} from '@sap-superagent/core';
import {
  artifactContentRef,
  checksumOfBytes,
  writeArtifactBytes,
} from '../../artifact-store.js';
import { getActiveAssignmentForTask, updateAssignment } from '../../db/assignments.js';
import { listApprovalsForDemand, updateApproval } from '../../db/approvals.js';
import {
  getDemand,
  insertDemand,
  listDemands,
  updateDemand,
} from '../../db/demands.js';
import { eventsForDemand } from '../../db/events.js';
import { insertStageRun, listStageRunsForDemand, updateStageRun } from '../../db/stages.js';
import { listTasksForDemand, updateTask } from '../../db/tasks.js';
import { writeTransaction } from '../../db/transaction.js';
import { badRequest, invalidState, notFound } from '../../errors.js';
import {
  artifactChainsForDemand,
  findArtifactByKind,
  insertArtifact,
  insertArtifactVersion,
  listArtifactVersionsForDemand,
  listArtifactsForDemand,
  updateArtifact,
} from '../../db/artifacts.js';
import { requireUserOrAdmin } from '../auth.js';
import { planTaskForStage, propagateStaleForArtifact } from '../../stage-engine.js';
import { nowIso, paramId, publish } from '../route-utils.js';
import { parseInput, sendValidated } from '../validate.js';
import type { ServerContext } from '../../types.js';

export function registerDemandRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post(
    '/api/v1/demands',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      const body = parseInput(createDemandBodySchema, request.body, 'createDemand body');
      const templateId = body.templateId ?? ctx.templates.defaultTemplateId;
      const template = ctx.templates.get(templateId);
      if (template === undefined) {
        throw badRequest(`unknown template "${templateId}"`);
      }
      const created = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const demandId = newDemandId();
        const demand: Demand = {
          id: demandId,
          title: body.title,
          description: body.description,
          acceptanceCriteria: body.acceptanceCriteria,
          requester: body.requester,
          priority: body.priority,
          templateId: template.templateId,
          templateVersion: template.version,
          status: 'submitted',
          workspaceBinding: body.workspaceBinding ?? null,
          source: 'local',
          createdAt: tx.now,
          updatedAt: tx.now,
        };
        insertDemand(ctx.db, demand);
        tx.append({
          type: 'demand.created',
          subject: { type: 'demand', id: demandId },
          data: {
            demandId,
            title: demand.title,
            priority: demand.priority,
            templateId: demand.templateId,
            templateVersion: demand.templateVersion,
            requester: demand.requester.userId,
          },
          demandId,
        });
        const stages: StageRun[] = template.stages.map((stageTemplate) => ({
          id: newUlid(),
          demandId,
          stageKey: stageTemplate.key,
          status: stageTemplate.inputArtifactKinds.length === 0 ? 'ready' : 'pending',
          attempt: 1,
          executorKind: stageTemplate.executorKind,
          gateKey: stageTemplate.gate === 'none' ? null : stageTemplate.gate.gateKey,
          inputRefs: [],
          outputArtifactId: null,
          startedAt: null,
          finishedAt: null,
          createdAt: tx.now,
          updatedAt: tx.now,
        }));
        for (const [stageIndex, stageRun] of stages.entries()) {
          insertStageRun(ctx.db, stageRun, stageIndex);
        }
        for (const [stageIndex, stageRun] of stages.entries()) {
          if (stageRun.status !== 'ready') continue;
          tx.append({
            type: 'stage.ready',
            subject: { type: 'stage_run', id: stageRun.id },
            data: {
              stageRunId: stageRun.id,
              demandId,
              stageKey: stageRun.stageKey,
              executorKind: stageRun.executorKind,
            },
            demandId,
          });
          const stageTemplate = template.stages[stageIndex];
          if (stageTemplate !== undefined) {
            planTaskForStage(tx, ctx, demand, stageTemplate, stageRun);
          }
        }
        return { demand, stages };
      });
      return sendValidated(reply, createDemandResponseSchema, {
        ...created,
        serverTime: nowIso(ctx),
      });
    },
  );

  app.get(
    '/api/v1/demands',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      const query = parseInput(listDemandsQuerySchema, request.query, 'listDemands query');
      const status =
        query.status === undefined
          ? undefined
          : parseInput(demandStatusSchema, query.status, 'demand status');
      const demands = listDemands(ctx.db, {
        limit: query.limit,
        ...(status !== undefined ? { status } : {}),
        ...(query.q !== undefined ? { q: query.q } : {}),
      });
      return sendValidated(reply, listDemandsResponseSchema, {
        demands,
        serverTime: nowIso(ctx),
      });
    },
  );

  app.get(
    '/api/v1/demands/:id',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      const demandId = paramId(request);
      const demand = getDemand(ctx.db, demandId);
      if (demand === null) throw notFound(`demand ${demandId} not found`);
      return sendValidated(reply, demandDetailResponseSchema, {
        demand,
        stages: listStageRunsForDemand(ctx.db, demandId),
        artifacts: listArtifactsForDemand(ctx.db, demandId),
        artifactVersions: listArtifactVersionsForDemand(ctx.db, demandId),
        artifactChains: artifactChainsForDemand(ctx.db, demandId),
        approvals: listApprovalsForDemand(ctx.db, demandId),
        events: eventsForDemand(ctx.db, demandId),
        serverTime: nowIso(ctx),
      });
    },
  );

  app.post(
    '/api/v1/demands/:id/cancel',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      const demandId = paramId(request);
      const body = parseInput(cancelDemandBodySchema, request.body, 'cancelDemand body');
      const cancelled = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const demand = getDemand(ctx.db, demandId);
        if (demand === null) throw notFound(`demand ${demandId} not found`);
        if (!canTransitionDemand(demand.status, 'cancelled')) {
          throw invalidState(`demand ${demandId} is ${demand.status} and cannot be cancelled`);
        }
        const updated: Demand = { ...demand, status: 'cancelled', updatedAt: tx.now };
        updateDemand(ctx.db, updated);
        tx.append({
          type: 'demand.cancelled',
          subject: { type: 'demand', id: demandId },
          data: { demandId, reason: body?.reason ?? null },
          demandId,
        });
        for (const stageRun of listStageRunsForDemand(ctx.db, demandId)) {
          if (!canTransitionStageRun(stageRun.status, 'cancelled')) continue;
          updateStageRun(ctx.db, {
            ...stageRun,
            status: 'cancelled',
            finishedAt: tx.now,
            updatedAt: tx.now,
          });
          tx.append({
            type: 'stage.cancelled',
            subject: { type: 'stage_run', id: stageRun.id },
            data: { stageRunId: stageRun.id, demandId, stageKey: stageRun.stageKey },
            demandId,
          });
        }
        // --- H1: pending gate approvals are withdrawn with the demand ---
        for (const approval of listApprovalsForDemand(ctx.db, demandId)) {
          if (approval.state !== 'pending') continue;
          updateApproval(ctx.db, {
            ...approval,
            state: 'withdrawn',
            comment: 'demand_cancelled',
            updatedAt: tx.now,
          });
          tx.append({
            type: 'approval.withdrawn',
            subject: { type: 'approval', id: approval.id },
            data: {
              approvalId: approval.id,
              demandId,
              gateKey: approval.gateKey,
              reason: 'demand_cancelled',
            },
            demandId,
          });
        }
        for (const task of listTasksForDemand(ctx.db, demandId)) {
          if (!canTransitionTask(task.state, 'cancelled')) continue;
          const assignment = getActiveAssignmentForTask(ctx.db, task.id);
          if (assignment !== null) {
            updateAssignment(ctx.db, {
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
                reason: 'demand_cancelled',
              },
              demandId,
            });
          }
          updateTask(ctx.db, { ...task, state: 'cancelled', updatedAt: tx.now });
          tx.append({
            type: 'task.cancelled',
            subject: { type: 'task', id: task.id },
            data: { taskId: task.id, demandId, reason: 'demand_cancelled' },
            demandId,
          });
        }
        return updated;
      });
      return sendValidated(reply, cancelDemandResponseSchema, {
        demand: cancelled,
        serverTime: nowIso(ctx),
      });
    },
  );

  // --- H1: human confirmation/adjustment creates a new immutable version ---
  app.post(
    '/api/v1/demands/:id/artifacts',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireUserOrAdmin(ctx, request);
      const demandId = paramId(request);
      const body = parseInput(createDemandArtifactBodySchema, request.body, 'demand artifact body');
      if (body.contentBase64 === undefined) {
        throw badRequest('contentUrl is not supported by the M1 control plane; send contentBase64');
      }
      const demand = getDemand(ctx.db, demandId);
      if (demand === null) throw notFound(`demand ${demandId} not found`);
      const bytes = Buffer.from(body.contentBase64, 'base64');
      const checksum = checksumOfBytes(bytes);
      if (checksum !== body.checksum) {
        throw badRequest(`checksum mismatch: declared ${body.checksum}, computed ${checksum}`);
      }
      const existing = findArtifactByKind(ctx.db, demandId, body.kind);
      const artifactId = existing === null ? newUlid() : existing.id;
      const versionNumber = existing === null ? 1 : existing.currentVersion + 1;
      writeArtifactBytes(ctx.config.stateDir, artifactId, versionNumber, bytes);
      const created = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const artifact: Artifact = {
          id: artifactId,
          demandId,
          kind: body.kind,
          stageKey: existing === null ? null : existing.stageKey,
          stageRunId: existing === null ? null : existing.stageRunId,
          state: 'generated',
          currentVersion: versionNumber,
          title: body.title ?? existing?.title ?? null,
          createdAt: existing === null ? tx.now : existing.createdAt,
          updatedAt: tx.now,
        };
        if (existing === null) insertArtifact(ctx.db, artifact);
        else updateArtifact(ctx.db, artifact);
        const contentRef = artifactContentRef(artifactId, versionNumber);
        const version: ArtifactVersion = {
          artifactId,
          version: versionNumber,
          contentRef,
          contentType: body.contentType,
          checksum,
          summary: body.summary ?? null,
          authorType: 'human',
          authorId: claims.sub,
          stale: false,
          createdAt: tx.now,
        };
        insertArtifactVersion(ctx.db, version);
        tx.append({
          type: 'artifact.created',
          subject: { type: 'artifact', id: artifactId },
          data: {
            artifactId,
            demandId,
            kind: body.kind,
            version: versionNumber,
            checksum,
            contentRef,
            authorType: 'human',
            authorId: claims.sub,
            supersedes: versionNumber > 1 ? versionNumber - 1 : null,
          },
          demandId,
        });
        if (versionNumber > 1) {
          propagateStaleForArtifact(tx, ctx, demandId, body.kind, versionNumber);
        }
        return { artifact, version };
      });
      return sendValidated(reply, createDemandArtifactResponseSchema, {
        artifact: created.artifact,
        version: created.version,
        serverTime: nowIso(ctx),
      });
    },
  );
}
