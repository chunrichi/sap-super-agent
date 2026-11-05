import type { DatabaseSync } from 'node:sqlite';
import type { Notification } from '@sap-superagent/protocol';
import { asNullableString, asString } from './rows.js';

// ---------------------------------------------------------------------------
// In-product notifications (docs/003 §2.5): only "must act" events are stored.
// ---------------------------------------------------------------------------

interface NotificationRow {
  id: string;
  demand_id: string;
  stage_run_id: string | null;
  approval_id: string | null;
  kind: string;
  required_role: string | null;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
}

function rowToNotification(row: NotificationRow): Notification {
  return {
    id: asString(row.id),
    demandId: asString(row.demand_id),
    stageRunId: asNullableString(row.stage_run_id),
    approvalId: asNullableString(row.approval_id),
    kind: asString(row.kind) as Notification['kind'],
    requiredRole: asNullableString(row.required_role) as Notification['requiredRole'],
    title: asString(row.title),
    body: asNullableString(row.body),
    createdAt: asString(row.created_at),
    readAt: asNullableString(row.read_at),
  };
}

export function insertNotification(db: DatabaseSync, notification: Notification): void {
  db.prepare(
    `INSERT INTO notifications (
      id, demand_id, stage_run_id, approval_id, kind, required_role, title, body, created_at, read_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    notification.id,
    notification.demandId,
    notification.stageRunId,
    notification.approvalId,
    notification.kind,
    notification.requiredRole,
    notification.title,
    notification.body,
    notification.createdAt,
    notification.readAt,
  );
}

export function getNotification(db: DatabaseSync, id: string): Notification | null {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as unknown as
    | NotificationRow
    | undefined;
  return row === undefined ? null : rowToNotification(row);
}

export function markNotificationRead(db: DatabaseSync, id: string, readAt: string): Notification | null {
  const row = db
    .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL RETURNING *')
    .get(readAt, id) as unknown as NotificationRow | undefined;
  if (row !== undefined) return rowToNotification(row);
  return getNotification(db, id);
}

export function listNotifications(
  db: DatabaseSync,
  options: { unreadOnly: boolean; limit: number },
): Notification[] {
  const where = options.unreadOnly ? 'WHERE read_at IS NULL' : '';
  const rows = db
    .prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(options.limit) as unknown as NotificationRow[];
  return rows.map(rowToNotification);
}
