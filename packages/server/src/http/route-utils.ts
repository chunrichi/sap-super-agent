import type { FastifyRequest } from 'fastify';
import type { EventEnvelope } from '@sap-superagent/protocol';
import { getTask } from '../db/tasks.js';
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

/**
 * Post-commit publisher: persist events to WS subscribers, then emit transient
 * `task.offered` hints for tasks that just became claimable (newly created or
 * returned to the pool). The hint is a transport frame, never an event-log row.
 */
export function publish(ctx: ServerContext): (events: readonly EventEnvelope[]) => void {
  return (events) => {
    ctx.hub.broadcast(events);
    for (const event of events) {
      const isNewTask = event.type === 'task.created';
      const isPooledTask =
        event.type === 'task.released' ||
        // --- S3: a transferred task is back in the pool (docs/003 §2.3) ---
        event.type === 'task.transferred' ||
        (event.type === 'task.updated' && event.data['state'] === 'pending');
      if (!isNewTask && !isPooledTask) continue;
      const task = getTask(ctx.db, event.subject.id);
      if (task !== null && task.state === 'pending') {
        ctx.hub.broadcastTaskOffered(task, event.at);
      }
    }
  };
}

export function nowIso(ctx: ServerContext): string {
  return new Date(ctx.clock()).toISOString();
}
