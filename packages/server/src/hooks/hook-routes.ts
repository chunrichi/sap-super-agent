import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_HOOK_RECEIPT_TOLERANCE_MS,
  hookReceiptBodySchema,
  hookReceiptResponseSchema,
  listHooksResponseSchema,
  hookReplayBodySchema,
  hookReplayResponseSchema,
  type HookStatus,
} from '@sap-superagent/protocol';
import { writeTransaction } from '../db/transaction.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { requireAdmin } from '../http/auth.js';
import { nowIso, paramId } from '../http/route-utils.js';
import { parseInput, sendValidated } from '../http/validate.js';
import type { ServerContext } from '../types.js';
import { findHook } from './hook-config.js';
import { verifyHookSignature } from './hook-signature.js';
import {
  appendHookEvent,
  countHookOutbox,
  findHookOutboxByEventId,
  getHookReceiptByDelivery,
  getHookReceiptByIdempotencyKey,
  insertHookReceipt,
  lastHookError,
  markHookOutboxReplay,
  newHookReceiptId,
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

  // Receipts verify the HMAC over the raw request bytes, so they need their own
  // encapsulated scope with a string JSON parser (same pattern as `/hooks/sap`).
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });
    scope.post(
      '/hooks/:target/receipt',
      async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
        handleHookReceipt(ctx, request, reply),
    );
  });
}

// ---------------------------------------------------------------------------
// S4 §1.5: inbound receipts (docs/008 §4).
//
//   POST /hooks/{target}/receipt   HMAC X-SA-* (same rule as SAP), no bearer
//                                  token. v1 records the receipt (hook_receipts,
//                                  migration v6) and a `hook.receipt` event; it
//                                  does NOT advance stages (advanceOnReceipt is
//                                  reserved and rejected by config validation).
//                                  Duplicate idempotencyKey/X-SA-Delivery is
//                                  answered `duplicate:true` without a second
//                                  event. Unknown externalId is recorded too.
// ---------------------------------------------------------------------------

async function handleHookReceipt(
  ctx: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const target = (request.params as Record<string, unknown>)['target'];
  if (typeof target !== 'string' || target.length === 0) {
    throw badRequest('missing :target path parameter');
  }
  const hook = findHook(ctx.hooks, target);
  if (hook === undefined) {
    throw notFound(
      `hook "${target}" is not configured in ${ctx.hooks.configPath}; add it to SA_HOOKS_CONFIG and restart`,
    );
  }
  if (hook.secret === null) {
    throw unauthorized(
      `hook "${target}" has no receipt secret; export ${hook.secretRef.slice('env:'.length)} and restart`,
    );
  }

  const rawBody = typeof request.body === 'string' ? request.body : '';
  if (rawBody.length === 0) throw badRequest('hook receipt body must not be empty');
  const verification = verifyHookSignature({
    secret: hook.secret,
    body: rawBody,
    headers: request.headers,
    now: ctx.clock(),
    toleranceMs: DEFAULT_HOOK_RECEIPT_TOLERANCE_MS,
  });
  if (!verification.ok) {
    throw unauthorized(`hook receipt rejected (${verification.code}): ${verification.message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody) as unknown;
  } catch {
    throw badRequest('hook receipt body is not valid JSON');
  }
  const body = parseInput(hookReceiptBodySchema, parsedJson, 'hook receipt body');

  const existing =
    getHookReceiptByIdempotencyKey(ctx.db, body.idempotencyKey) ??
    getHookReceiptByDelivery(ctx.db, hook.id, verification.delivery);
  if (existing !== null) {
    return sendValidated(reply, hookReceiptResponseSchema, {
      accepted: true,
      duplicate: true,
      receiptId: existing.id,
      hookId: existing.hookId,
      externalId: existing.externalId,
      status: existing.status,
      serverTime: nowIso(ctx),
    });
  }

  const receiptId = newHookReceiptId();
  writeTransaction(ctx.db, (events) => ctx.hub.broadcast(events), (tx) => {
    insertHookReceipt(tx, {
      id: receiptId,
      hookId: hook.id,
      idempotencyKey: body.idempotencyKey,
      deliveryId: verification.delivery,
      externalId: body.payload.externalId,
      status: body.payload.status,
      body: rawBody,
      receivedAt: tx.now,
    });
    appendHookEvent(tx, 'hook.receipt', hook.id, {
      hookId: hook.id,
      receiptId,
      idempotencyKey: body.idempotencyKey,
      deliveryId: verification.delivery,
      externalId: body.payload.externalId,
      status: body.payload.status,
      duplicate: false,
      // v1 has no artifact links store: receipts are recorded, not linked.
      linked: false,
    });
  });

  return sendValidated(reply, hookReceiptResponseSchema, {
    accepted: true,
    duplicate: false,
    receiptId,
    hookId: hook.id,
    externalId: body.payload.externalId,
    status: body.payload.status,
    serverTime: nowIso(ctx),
  });
}
