import type { FastifyInstance, FastifyRequest } from 'fastify';
import { findIdempotencyRecord, saveIdempotencyRecord } from '../db/idempotency.js';
import type { ServerContext } from '../types.js';

const pendingKeys = new WeakMap<FastifyRequest, string>();

function headerValue(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * `Idempotency-Key` replay for POST routes (docs/003 §4.1): a repeated key
 * within the TTL returns the stored status + body instead of re-executing.
 */
export function registerIdempotency(app: FastifyInstance, ctx: ServerContext): void {
  app.addHook('onRequest', (request, reply, done) => {
    if (request.method !== 'POST') {
      done();
      return;
    }
    const key = headerValue(request);
    if (key === undefined) {
      done();
      return;
    }
    const record = findIdempotencyRecord(
      ctx.db,
      key,
      new Date(ctx.clock() - ctx.config.idempotencyTtlMs).toISOString(),
    );
    if (record === null) {
      pendingKeys.set(request, key);
      done();
      return;
    }
    const routePath = request.routeOptions.url ?? '';
    if (record.method !== request.method || record.path !== routePath) {
      done();
      return;
    }
    reply
      .code(record.status)
      .header('content-type', 'application/json; charset=utf-8')
      .header('idempotent-replay', 'true')
      .send(record.body);
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    const key = pendingKeys.get(request);
    if (key === undefined) {
      done(null, payload);
      return;
    }
    pendingKeys.delete(request);
    if (reply.statusCode >= 400 || typeof payload !== 'string') {
      done(null, payload);
      return;
    }
    saveIdempotencyRecord(
      ctx.db,
      key,
      request.method,
      request.routeOptions.url ?? '',
      reply.statusCode,
      payload,
      new Date(ctx.clock()).toISOString(),
    );
    done(null, payload);
  });
}
