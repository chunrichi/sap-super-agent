import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  listNotificationsQuerySchema,
  listNotificationsResponseSchema,
  markNotificationReadResponseSchema,
} from '@sap-superagent/protocol';
import {
  listNotifications,
  markNotificationRead,
} from '../../db/notifications.js';
import { writeTransaction } from '../../db/transaction.js';
import { notFound } from '../../errors.js';
import { requireUserOrAdmin } from '../auth.js';
import { nowIso, paramId } from '../route-utils.js';
import { parseInput, sendValidated } from '../validate.js';
import type { ServerContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Notification API (docs/003 §2.5, docs/005 §2.2). Only "must act" alerts are
// recorded; M1 has no user/role table, so unread notifications are surfaced to
// user/admin tokens and `requiredRole` tells the operator who should act.
// ---------------------------------------------------------------------------

export function registerNotificationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get(
    '/api/v1/notifications',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      const query = parseInput(
        listNotificationsQuerySchema,
        request.query,
        'listNotifications query',
      );
      return sendValidated(reply, listNotificationsResponseSchema, {
        notifications: listNotifications(ctx.db, {
          unreadOnly: query.state === 'unread',
          limit: query.limit,
        }),
        serverTime: nowIso(ctx),
      });
    },
  );

  app.post(
    '/api/v1/notifications/:id/read',
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      requireUserOrAdmin(ctx, request);
      const notificationId = paramId(request);
      const updated = writeTransaction(ctx.db, () => undefined, (tx) => {
        const notification = markNotificationRead(ctx.db, notificationId, tx.now);
        if (notification === null) throw notFound(`notification ${notificationId} not found`);
        return notification;
      });
      return sendValidated(reply, markNotificationReadResponseSchema, {
        notification: updated,
        serverTime: nowIso(ctx),
      });
    },
  );
}
