import Fastify, { type FastifyInstance } from 'fastify';
import { errorBody } from '@sap-superagent/protocol';
import { ApiHttpError } from '../errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerDemandRoutes } from './routes/demands.js';
import { registerEventRoutes } from './routes/events.js';
import { registerExecutorRoutes } from './routes/executors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTaskRoutes } from './routes/tasks.js';
// --- H1: stage template + approval gate routes (docs/003 §2.7/§2.5) ---
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerTemplateRoutes } from './routes/templates.js';
// --- H2: SAP ICF inbound webhook + writeback status (docs/003 §4.5, docs/004 §3) ---
import { registerSapRoutes } from '../hooks/sap.js';
// --- S4: generic Hook management/replay/receipt surfaces (docs/003 §4.7) ---
import { registerHookRoutes } from '../hooks/hook-routes.js';
import { registerIdempotency } from './idempotency.js';
import type { ServerContext } from '../types.js';

const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export function createApp(ctx: ServerContext): FastifyInstance {
  const app = Fastify({
    logger: ctx.config.logger,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiHttpError) {
      return reply.code(error.httpStatus).send(error.toBody());
    }
    const candidate = error as { statusCode?: unknown; message?: unknown };
    const statusCode = candidate.statusCode;
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : 'invalid request';
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(errorBody('bad_request', message));
    }
    if (ctx.config.logger) app.log.error({ err: error, url: request.url }, 'unhandled request error');
    return reply.code(500).send(errorBody('internal_error', 'internal server error'));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(errorBody('not_found', `no route for ${request.method} ${request.url}`)),
  );

  registerIdempotency(app, ctx);
  registerHealthRoutes(app, ctx);
  registerExecutorRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerDemandRoutes(app, ctx);
  // --- H1: read-only stage templates, approval gates, notifications ---
  registerTemplateRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  // --- H2: SAP ICF integration (no-op unless SA_SAP_* is configured) ---
  registerSapRoutes(app, ctx);
  // --- S4: generic Hook management + replay (root paths, docs/003 §4.7) ---
  registerHookRoutes(app, ctx);
  return app;
}
