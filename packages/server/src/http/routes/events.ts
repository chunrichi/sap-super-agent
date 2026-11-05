import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eventsQuerySchema, eventsResponseSchema } from '@sap-superagent/protocol';
import { eventSeqWindow, listEventsAfter } from '../../db/events.js';
import { resyncRequired } from '../../errors.js';
import { requireKinds } from '../auth.js';
import { parseInput, sendValidated } from '../validate.js';
import type { ServerContext } from '../../types.js';

const MAX_EVENT_LIMIT = 500;

/**
 * Clients may ask for more than the protocol page size; serving the maximum
 * page is friendlier than a 400 and never changes what the cursor means.
 */
function clampLimit(rawQuery: unknown): unknown {
  if (typeof rawQuery !== 'object' || rawQuery === null) return rawQuery;
  const record = rawQuery as Record<string, unknown>;
  const rawLimit = record['limit'];
  if (typeof rawLimit !== 'string') return rawQuery;
  const numeric = Number(rawLimit);
  if (Number.isInteger(numeric) && numeric > MAX_EVENT_LIMIT) {
    return { ...record, limit: MAX_EVENT_LIMIT };
  }
  return rawQuery;
}

export function registerEventRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get(
    '/api/v1/events',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireKinds(ctx, request, ['user', 'executor', 'admin']);
      const query = parseInput(eventsQuerySchema, clampLimit(request.query), 'events query');
      const window = eventSeqWindow(ctx.db);
      const outsideRetention =
        (query.after > 0 && query.after < window.earliestSeq - 1) ||
        (query.after === 0 && window.earliestSeq > 1);
      if (outsideRetention) {
        throw resyncRequired('event cursor is older than the retention window', {
          earliestSeq: window.earliestSeq,
          lastSeq: window.lastSeq,
        });
      }
      return sendValidated(reply, eventsResponseSchema, {
        events: listEventsAfter(ctx.db, query.after, query.limit),
        lastSeq: window.lastSeq,
        earliestSeq: window.earliestSeq,
      });
    },
  );
}
