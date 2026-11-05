import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  listHooksResponseSchema,
  hookReplayBodySchema,
  hookReplayResponseSchema,
  type HookStatus,
} from '@sap-superagent/protocol';
import { writeTransaction } from '../db/transaction.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { requireAdmin } from '../http/auth.js';
import { nowIso, paramId } from '../http/route-utils.js';
import { parseInput, sendValidated } from '../http/validate.js';
import type { ServerContext } from '../types.js';
import { findHook } from './hook-config.js';
import {
  countHookOutbox,
  findHookOutboxByEventId,
  lastHookError,
  markHookOutboxReplay,
  recentHookAttempt,
} from './hook-store.js';

// ---------------------------------------------------------------------------
// S4: generic Hook management surface (docs/003 §4.7, docs/008 §6).
//
//   GET  /hooks            admin: per-hook enablement, subscriptions, outbox
//                          depth (pending/sent/dead/cancelled), lastError and
//                          the latest hook.attempted/delivered/dead summary.
//   POST /hooks/{id}/replay admin + Idempotency-Key: re-queue one dead/sent/
//                          cancelled delivery by source eventId; the envelope
//                          (and therefore idempotencyKey) is unchanged.
//
// Both live at the server root next to the SAP webhook, not under /api/v1,
// because they are the documented external-facing Hook surface.
// ---------------------------------------------------------------------------

function idempotencyKeyHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function hookStatuses(ctx: ServerContext): HookStatus[] {
  return ctx.hooks.hooks.map((hook) => ({
    id: hook.id,
    target: hook.target,
    enabled: hook.enabled,
    events: [...hook.events],
    queue: countHookOutbox(ctx.db, hook.id),
    lastError: lastHookError(ctx.db, hook.id),
    lastAttempt: recentHookAttempt(ctx.db, hook.id),
  }));
}

export function registerHookRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/hooks', async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    requireAdmin(ctx, request);
    return sendValidated(reply, listHooksResponseSchema, {
      hooks: hookStatuses(ctx),
      serverTime: nowIso(ctx),
    });
  });

  app.post(
    '/hooks/:id/replay',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireAdmin(ctx, request);
      const hookId = paramId(request);
      if (idempotencyKeyHeader(request) === undefined) {
        throw badRequest(
          'POST /hooks/{id}/replay requires an Idempotency-Key header so a repeated replay cannot create a second external delivery',
        );
      }
      const body = parseInput(hookReplayBodySchema, request.body, 'hook replay body');
      const hook = findHook(ctx.hooks, hookId);
      if (hook === undefined) {
        throw notFound(
          `hook "${hookId}" is not configured in ${ctx.hooks.configPath}; add it to SA_HOOKS_CONFIG and restart`,
        );
      }
      if (!hook.enabled) {
        throw conflict(
          `hook "${hookId}" is disabled; set enabled: true in ${ctx.hooks.configPath} and restart before replaying`,
        );
      }

      const row = findHookOutboxByEventId(ctx.db, hookId, body.eventId);
      if (row === null) {
        throw notFound(`no queued or delivered hook delivery for event "${body.eventId}" on hook "${hookId}"`);
      }
      if (row.status === 'PENDING') {
        return sendValidated(reply, hookReplayResponseSchema, {
          hookId,
          eventId: body.eventId,
          replayed: false,
          status: 'already_pending',
          outboxId: row.id,
          serverTime: nowIso(ctx),
        });
      }
      writeTransaction(ctx.db, () => undefined, (tx) => {
        markHookOutboxReplay(tx.db, row.id, tx.now);
      });
      return sendValidated(reply, hookReplayResponseSchema, {
        hookId,
        eventId: body.eventId,
        replayed: true,
        status: 'queued',
        outboxId: row.id,
        serverTime: nowIso(ctx),
      });
    },
  );

}
