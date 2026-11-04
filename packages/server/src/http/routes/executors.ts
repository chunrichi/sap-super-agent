import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_LEASE_RENEW_INTERVAL_MS,
  DEFAULT_MAX_CONCURRENT,
  heartbeatBodySchema,
  heartbeatResponseSchema,
  newUlid,
  registerExecutorBodySchema,
  registerExecutorResponseSchema,
  unregisterExecutorResponseSchema,
  type Executor,
} from '@sap-superagent/protocol';
import { DEFAULT_TOKEN_TTL_MS, issueToken } from '../../auth.js';
import { getExecutor, insertExecutor, updateExecutor } from '../../db/executors.js';
import { taskToSummary } from '../../db/tasks.js';
import { writeTransaction } from '../../db/transaction.js';
import { forbidden, notFound } from '../../errors.js';
import { requireExecutor, requireKinds } from '../auth.js';
import { nowIso, paramId, publish } from '../route-utils.js';
import { parseInput, sendValidated } from '../validate.js';
import { releaseAssignmentsForExecutor } from '../../lease.js';
import { listEligiblePendingTasks } from '../../offers.js';
import type { ServerContext } from '../../types.js';

const HEARTBEAT_OFFER_LIMIT = 20;

export function registerExecutorRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post(
    '/api/v1/executors/register',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireKinds(ctx, request, ['user', 'admin']);
      const body = parseInput(registerExecutorBodySchema, request.body, 'registerExecutor body');
      const nowMs = ctx.clock();
      const executor = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const next: Executor = {
          id: newUlid(),
          kind: body.kind,
          user: body.user,
          machineIdHash: body.machineIdHash ?? null,
          capabilities: body.capabilities,
          roles: body.roles,
          workspaces: body.workspaces,
          activeWorkspaceKey: null,
          presence: 'offline',
          accepting: true,
          maxConcurrent: body.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
          protocolVersion: body.protocolVersion,
          cliVersion: body.cliVersion ?? null,
          createdAt: tx.now,
          updatedAt: tx.now,
        };
        insertExecutor(ctx.db, next, null);
        tx.append({
          type: 'executor.registered',
          subject: { type: 'executor', id: next.id },
          data: { executorId: next.id, kind: next.kind, user: next.user, presence: next.presence },
        });
        return next;
      });
      const executorToken = issueToken({
        kind: 'executor',
        sub: executor.user,
        executorId: executor.id,
        secret: ctx.secret,
        ttlMs: DEFAULT_TOKEN_TTL_MS,
      });
      return sendValidated(reply, registerExecutorResponseSchema, {
        executor,
        executorToken,
        tokenExpiresAt: new Date(nowMs + DEFAULT_TOKEN_TTL_MS).toISOString(),
        serverTime: nowIso(ctx),
      });
    },
  );

  app.post(
    '/api/v1/executors/:id/heartbeat',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireExecutor(ctx, request);
      const id = paramId(request);
      if (claims.executorId !== id) {
        throw forbidden('executor token does not match the executor id in the path');
      }
      const body = parseInput(heartbeatBodySchema, request.body, 'heartbeat body');
      const record = getExecutor(ctx.db, id);
      if (record === null) throw notFound(`executor ${id} not found`);
      const nowMs = ctx.clock();
      const at = new Date(nowMs).toISOString();
      const executor: Executor = {
        ...record.executor,
        presence: body.status,
        workspaces: body.workspaces ?? record.executor.workspaces,
        activeWorkspaceKey:
          body.activeWorkspaceKey === undefined
            ? record.executor.activeWorkspaceKey
            : body.activeWorkspaceKey,
        updatedAt: at,
      };
      updateExecutor(ctx.db, executor, at);
      const offers = listEligiblePendingTasks(ctx, { executor, lastHeartbeatAt: at }, nowMs)
        .slice(0, HEARTBEAT_OFFER_LIMIT)
        .map(taskToSummary);
      return sendValidated(reply, heartbeatResponseSchema, {
        serverTime: at,
        leaseTtlMs: ctx.config.leaseTtlMs,
        renewIntervalMs: DEFAULT_LEASE_RENEW_INTERVAL_MS,
        offers,
      });
    },
  );

  app.delete(
    '/api/v1/executors/:id',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const claims = requireKinds(ctx, request, ['executor', 'admin']);
      const id = paramId(request);
      if (claims.kind === 'executor' && claims.executorId !== id) {
        throw forbidden('executor token does not match the executor id in the path');
      }
      const releasedTaskIds = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const record = getExecutor(ctx.db, id);
        if (record === null) throw notFound(`executor ${id} not found`);
        const offline: Executor = { ...record.executor, presence: 'offline', updatedAt: tx.now };
        updateExecutor(ctx.db, offline, record.lastHeartbeatAt);
        const released = releaseAssignmentsForExecutor(tx, id, 'executor_unregistered');
        tx.append({
          type: 'executor.offline',
          subject: { type: 'executor', id },
          data: { executorId: id, user: offline.user, reason: 'unregistered' },
        });
        return released;
      });
      return sendValidated(reply, unregisterExecutorResponseSchema, {
        releasedTaskIds,
        serverTime: nowIso(ctx),
      });
    },
  );
}
