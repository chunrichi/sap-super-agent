import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  approvalDecisionBodySchema,
  approvalDecisionResponseSchema,
  approvalStateSchema,
  listApprovalsQuerySchema,
  listApprovalsResponseSchema,
  withdrawApprovalResponseSchema,
  type ApprovalState,
} from '@sap-superagent/protocol';
import { canTransitionApproval } from '@sap-superagent/core';
import { getApproval, listApprovals } from '../../db/approvals.js';
import { writeTransaction } from '../../db/transaction.js';
import { conflict, notFound } from '../../errors.js';
import {
  decideApprovalApprove,
  decideApprovalReject,
  withdrawApproval,
} from '../../stage-engine.js';
import { requireUserOrAdmin } from '../auth.js';
import { nowIso, paramId, publish } from '../route-utils.js';
import { parseInput, sendValidated } from '../validate.js';
import type { ServerContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Approval gate API (docs/003 §2.5, §4.3; H1 §1.2):
//   GET  /approvals?assignee=me&state=pending
//   POST /approvals/{id}/decisions   (approve/reject; terminal states -> 409)
//   POST /approvals/{id}/withdraw
// M1 does not model fine-grained permissions: any user/admin token may decide
// and `decidedBy` records the operator (HANDOFF §7).
// ---------------------------------------------------------------------------

export function registerApprovalRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get(
    '/api/v1/approvals',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      const query = parseInput(listApprovalsQuerySchema, request.query, 'listApprovals query');
      const state: ApprovalState =
        query.state === undefined
          ? 'pending'
          : parseInput(approvalStateSchema, query.state, 'approval state');
      const approvals = listApprovals(ctx.db, { state, limit: 100 });
      return sendValidated(reply, listApprovalsResponseSchema, {
        approvals,
        serverTime: nowIso(ctx),
      });
    },
  );

  app.post(
    '/api/v1/approvals/:id/decisions',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireUserOrAdmin(ctx, request);
      const approvalId = paramId(request);
      const body = parseInput(approvalDecisionBodySchema, request.body, 'approval decision body');
      const decidedBy = body.decidedBy ?? claims.sub;
      const comment = body.comment ?? null;
      const approval = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const current = getApproval(ctx.db, approvalId);
        if (current === null) throw notFound(`approval ${approvalId} not found`);
        if (current.state !== 'pending' || !canTransitionApproval(current.state, body.decision === 'approve' ? 'approved' : 'rejected')) {
          throw conflict(`approval ${approvalId} is already ${current.state}`, {
            approvalId,
            approvalState: current.state,
          });
        }
        if (body.decision === 'approve') {
          return decideApprovalApprove(tx, ctx, current, decidedBy, comment);
        }
        return decideApprovalReject(tx, ctx, current, decidedBy, comment);
      });
      return sendValidated(reply, approvalDecisionResponseSchema, {
        approval,
        serverTime: nowIso(ctx),
      });
    },
  );

  app.post(
    '/api/v1/approvals/:id/withdraw',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      const approvalId = paramId(request);
      const approval = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const current = getApproval(ctx.db, approvalId);
        if (current === null) throw notFound(`approval ${approvalId} not found`);
        if (current.state !== 'pending') {
          throw conflict(`approval ${approvalId} is already ${current.state}`, {
            approvalId,
            approvalState: current.state,
          });
        }
        return withdrawApproval(tx, ctx, current, 'withdrawn_by_operator');
      });
      return sendValidated(reply, withdrawApprovalResponseSchema, {
        approval,
        serverTime: nowIso(ctx),
      });
    },
  );
}
