import Fastify, { type FastifyInstance } from 'fastify';
import { errorBody } from '@sap-superagent/protocol';
import { ApiHttpError } from '../errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerDemandRoutes } from './routes/demands.js';
import { registerEventRoutes } from './routes/events.js';
import { registerExecutorRoutes } from './routes/executors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTaskRoutes } from './routes/tasks.js';
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
  registerAdminRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  return app;
}
