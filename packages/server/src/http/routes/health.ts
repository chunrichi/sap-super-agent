import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { healthResponseSchema } from '@sap-superagent/protocol';
import { sendValidated } from '../validate.js';
import { nowIso } from '../route-utils.js';
import type { ServerContext } from '../../types.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const handler = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    sendValidated(reply, healthResponseSchema, {
      status: 'ok',
      version: ctx.config.version,
      uptimeMs: Math.max(0, ctx.clock() - ctx.startedAtMs),
      serverTime: nowIso(ctx),
      aiProvider: ctx.aiProvider.name,
      persistence: 'sqlite',
      mode: 'm1',
    });

  app.get('/healthz', handler);
  app.get('/api/v1/healthz', handler);
}
