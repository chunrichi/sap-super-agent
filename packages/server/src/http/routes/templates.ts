import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listTemplatesResponseSchema } from '@sap-superagent/protocol';
import { requireUserOrAdmin } from '../auth.js';
import { nowIso } from '../route-utils.js';
import { sendValidated } from '../validate.js';
import type { ServerContext } from '../../types.js';

/**
 * `GET /templates` (docs/003 §2.7): read-only view of every template version
 * loaded at startup plus the default template id used by `POST /demands`.
 */
export function registerTemplateRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get(
    '/api/v1/templates',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      return sendValidated(reply, listTemplatesResponseSchema, {
        templates: ctx.templates.list(),
        defaultTemplateId: ctx.templates.defaultTemplateId,
        serverTime: nowIso(ctx),
      });
    },
  );
}
