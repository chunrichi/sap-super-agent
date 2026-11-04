import type { FastifyRequest } from 'fastify';
import type { EventEnvelope } from '@sap-superagent/protocol';
import { badRequest } from '../errors.js';
import type { ServerContext } from '../types.js';

export function paramId(request: FastifyRequest): string {
  const params = request.params as Record<string, unknown> | undefined;
  const id = params?.['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw badRequest('missing :id path parameter');
  }
  return id;
}

export function publish(ctx: ServerContext): (events: readonly EventEnvelope[]) => void {
  return (events) => ctx.hub.broadcast(events);
}

export function nowIso(ctx: ServerContext): string {
  return new Date(ctx.clock()).toISOString();
}
