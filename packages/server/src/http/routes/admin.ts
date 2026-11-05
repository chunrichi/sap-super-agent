import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  adminCreateTaskBodySchema,
  adminCreateTaskResponseSchema,
  adminExpireApprovalResponseSchema,
  newUlid,
  type Task,
} from '@sap-superagent/protocol';
import { getApproval } from '../../db/approvals.js';
import { getDemand } from '../../db/demands.js';
import { getStageRun } from '../../db/stages.js';
import { insertTask } from '../../db/tasks.js';
import { writeTransaction } from '../../db/transaction.js';
import { badRequest, notFound } from '../../errors.js';
import { expireApproval } from '../../stage-engine.js';
import { requireAdmin } from '../auth.js';
import { nowIso, paramId, publish } from '../route-utils.js';
import { parseInput, sendValidated } from '../validate.js';
import type { ServerContext } from '../../types.js';

/** S0 verification endpoint; H1 replaces manual task creation with templates. */
export function registerAdminRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post(
    '/api/v1/admin/tasks',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireAdmin(ctx, request);
      const body = parseInput(adminCreateTaskBodySchema, request.body, 'adminCreateTask body');
      const demand = getDemand(ctx.db, body.demandId);
      if (demand === null) throw notFound(`demand ${body.demandId} not found`);
      if (body.stageRunId !== undefined) {
        const stageRun = getStageRun(ctx.db, body.stageRunId);
        if (stageRun === null) throw badRequest(`stage run ${body.stageRunId} not found`);
        if (stageRun.demandId !== body.demandId) {
          throw badRequest('stageRunId does not belong to demandId');
        }
      }
      const task = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const next: Task = {
          id: newUlid(),
          demandId: body.demandId,
          stageRunId: body.stageRunId ?? null,
          title: body.title,
          executorKind: body.executorKind,
          requiredRoles: body.requiredRoles,
          workspaceBinding: body.workspaceBinding ?? null,
          priority: body.priority,
          dueAt: body.dueAt ?? null,
          state: 'pending',
          lastHolderUserIds: [],
          createdAt: tx.now,
          updatedAt: tx.now,
        };
        insertTask(ctx.db, next);
        tx.append({
          type: 'task.created',
          subject: { type: 'task', id: next.id },
          data: {
            taskId: next.id,
            demandId: next.demandId,
            executorKind: next.executorKind,
            priority: next.priority,
            title: next.title,
          },
          demandId: next.demandId,
        });
        return next;
      });
      return sendValidated(reply, adminCreateTaskResponseSchema, {
        task,
        serverTime: nowIso(ctx),
      });
    },
  );

  // --- H1: M1 operations escalation for a stuck gate (docs/003 §2.5) ---
  app.post(
    '/api/v1/admin/approvals/:id/expire',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireAdmin(ctx, request);
      const approvalId = paramId(request);
      const approval = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const current = getApproval(ctx.db, approvalId);
        if (current === null) throw notFound(`approval ${approvalId} not found`);
        if (current.state !== 'pending') return current;
        return expireApproval(tx, ctx, current);
      });
      return sendValidated(reply, adminExpireApprovalResponseSchema, {
        approval,
        serverTime: nowIso(ctx),
      });
    },
  );
}
