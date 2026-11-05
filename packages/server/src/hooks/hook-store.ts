import type { DatabaseSync } from 'node:sqlite';
import {
  newUlid,
  type EventType,
  type HookEnvelope,
  type HookQueueDepth,
  type HookReceiptStatus,
} from '@sap-superagent/protocol';
import type { TransactionContext } from '../db/transaction.js';
import { asNullableString, asNumber, asString, decodeJson, encodeJson } from '../db/rows.js';

// ---------------------------------------------------------------------------
// S4: persistence helpers for the generic Hook queue (docs/008 §5/§6).
//
// The queue reuses the shared `outbox` table with `target = 'hook:<id>'` so the
// SAP writeback worker (target `sap.writeback`) and the generic hooks never
// steal each other's rows. Receipts and the enqueue cursor live in the S4
// migration v6 tables. Everything here is additive; H0–S3 tables are untouched.
// ---------------------------------------------------------------------------

export const HOOK_OUTBOX_PREFIX = 'hook:';

/** Outbox statuses used by the generic hook worker (SAP uses PENDING/SENT/DEAD). */
export type HookOutboxStatus = 'PENDING' | 'SENT' | 'DEAD' | 'CANCELLED';

export interface HookOutboxRow {
  id: string;
  eventSeq: number;
  target: string;
  payload: string;
  status: HookOutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface RawOutboxRow {
  id: string;
  event_seq: number;
  target: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

export function hookTarget(hookId: string): string {
  return `${HOOK_OUTBOX_PREFIX}${hookId}`;
}

export function hookIdFromTarget(target: string): string | null {
  return target.startsWith(HOOK_OUTBOX_PREFIX) ? target.slice(HOOK_OUTBOX_PREFIX.length) : null;
}

/** One outbox row per `(eventId, hookId)`; `INSERT OR IGNORE` makes re-scans idempotent. */
export function hookOutboxId(eventId: string, hookId: string): string {
  return `${eventId}:${hookId}`;
}

function rowToOutbox(row: RawOutboxRow): HookOutboxRow {
  return {
    id: asString(row.id),
    eventSeq: asNumber(row.event_seq),
    target: asString(row.target),
    payload: asString(row.payload),
    status: asString(row.status) as HookOutboxStatus,
    attempts: asNumber(row.attempts),
    nextAttemptAt: asNullableString(row.next_attempt_at),
    lastError: asNullableString(row.last_error),
    sentAt: asNullableString(row.sent_at),
    createdAt: asString(row.created_at),
  };
}

export interface InsertHookOutboxInput {
  id: string;
  eventSeq: number;
  target: string;
  envelope: HookEnvelope;
  nextAttemptAt: string;
  now: string;
}

/** Insert a PENDING hook row; returns `false` when it already existed. */
export function insertHookOutboxRow(db: DatabaseSync, input: InsertHookOutboxInput): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO outbox (id, event_seq, target, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.eventSeq,
      input.target,
      encodeJson(input.envelope),
      input.nextAttemptAt,
      input.now,
      input.now,
    );
  return Number(result.changes) > 0;
}

const HOOK_TARGET_PREDICATE = `target LIKE 'hook:%'`;

export function listDueHookOutbox(db: DatabaseSync, nowIso: string, limit: number): HookOutboxRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM outbox WHERE ${HOOK_TARGET_PREDICATE} AND status = 'PENDING'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(nowIso, limit) as unknown as RawOutboxRow[];
  return rows.map(rowToOutbox);
}

/** Pending rows for cancellation scans (bounded batch; M1 scale). */
export function listPendingHookOutbox(db: DatabaseSync, limit = 500): HookOutboxRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM outbox WHERE ${HOOK_TARGET_PREDICATE} AND status = 'PENDING'
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as unknown as RawOutboxRow[];
  return rows.map(rowToOutbox);
}

/** All rows of one hook (or all hooks) — used by GET /hooks and reconcile. */
export function listHookOutbox(db: DatabaseSync, hookId?: string): HookOutboxRow[] {
  const rows =
    hookId === undefined
      ? (db
          .prepare(`SELECT * FROM outbox WHERE ${HOOK_TARGET_PREDICATE} ORDER BY created_at ASC, id ASC`)
          .all() as unknown as RawOutboxRow[])
      : (db
          .prepare(
            `SELECT * FROM outbox WHERE target = ? ORDER BY created_at ASC, id ASC`,
          )
          .all(hookTarget(hookId)) as unknown as RawOutboxRow[]);
  return rows.map(rowToOutbox);
}

/** Find the outbox row for one hook + source event id (replay resolves by eventId). */
export function findHookOutboxByEventId(
  db: DatabaseSync,
  hookId: string,
  eventId: string,
): HookOutboxRow | null {
  const rows = db
    .prepare(`SELECT * FROM outbox WHERE target = ? ORDER BY created_at ASC, id ASC`)
    .all(hookTarget(hookId)) as unknown as RawOutboxRow[];
  for (const row of rows.map(rowToOutbox)) {
    const envelope = parseHookEnvelope(row.payload);
    if (envelope !== null && envelope.eventId === eventId) return row;
  }
  return null;
}

/** Parse a stored envelope; `null` when the payload is corrupt (dead letter it). */
export function parseHookEnvelope(payload: string): HookEnvelope | null {
  try {
    const parsed = JSON.parse(payload) as HookEnvelope;
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function markHookOutboxSent(
  db: DatabaseSync,
  id: string,
  attempts: number,
  at: string,
): void {
  db.prepare(
    `UPDATE outbox SET status = 'SENT', attempts = ?, sent_at = ?, next_attempt_at = NULL,
       last_error = NULL, updated_at = ? WHERE id = ?`,
  ).run(attempts, at, at, id);
}

export function markHookOutboxRetry(
  db: DatabaseSync,
  id: string,
  attempts: number,
  nextAttemptAt: string,
  error: string,
  at: string,
): void {
  db.prepare(
    `UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(attempts, nextAttemptAt, error, at, id);
}

export function markHookOutboxDead(
  db: DatabaseSync,
  id: string,
  attempts: number,
  error: string,
  at: string,
): void {
  db.prepare(
    `UPDATE outbox SET status = 'DEAD', attempts = ?, next_attempt_at = NULL, last_error = ?,
       updated_at = ? WHERE id = ?`,
  ).run(attempts, error, at, id);
}

export function markHookOutboxCancelled(
  db: DatabaseSync,
  id: string,
  reason: string,
  at: string,
): void {
  db.prepare(
    `UPDATE outbox SET status = 'CANCELLED', next_attempt_at = NULL, last_error = ?,
       updated_at = ? WHERE id = ?`,
  ).run(reason, at, id);
}

/** Replay: put a SENT/DEAD/CANCELLED row back into the PENDING queue. */
export function markHookOutboxReplay(db: DatabaseSync, id: string, at: string): void {
  db.prepare(
    `UPDATE outbox SET status = 'PENDING', attempts = 0, next_attempt_at = ?, last_error = NULL,
       sent_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(at, at, id);
}

export function countHookOutbox(db: DatabaseSync, hookId: string): HookQueueDepth {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS total FROM outbox WHERE target = ? GROUP BY status`)
    .all(hookTarget(hookId)) as unknown as Array<{ status: string; total: number }>;
  const counts = new Map(rows.map((row) => [asString(row.status), asNumber(row.total)]));
  return {
    pending: counts.get('PENDING') ?? 0,
    sent: counts.get('SENT') ?? 0,
    dead: counts.get('DEAD') ?? 0,
    cancelled: counts.get('CANCELLED') ?? 0,
  };
}

export function lastHookError(db: DatabaseSync, hookId: string): string | null {
  const row = db
    .prepare(
      `SELECT last_error FROM outbox WHERE target = ? AND last_error IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(hookTarget(hookId)) as { last_error: string } | undefined;
  return row === undefined ? null : asString(row.last_error);
}

// -- enqueue cursor ---------------------------------------------------------

const HOOK_ENQUEUE_CURSOR_KEY = 'hook.enqueue.cursor';

export function getHookEnqueueCursor(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT value FROM hook_state WHERE key = ?`)
    .get(HOOK_ENQUEUE_CURSOR_KEY) as { value: string } | undefined;
  return row === undefined ? 0 : Number.parseInt(asString(row.value), 10) || 0;
}

export function setHookEnqueueCursor(db: DatabaseSync, cursor: number, at: string): void {
  db.prepare(
    `INSERT INTO hook_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(HOOK_ENQUEUE_CURSOR_KEY, String(cursor), at);
}

// -- receipts (docs/008 §4, migration v6) -----------------------------------

export interface HookReceiptRecord {
  id: string;
  hookId: string;
  idempotencyKey: string;
  deliveryId: string;
  externalId: string;
  status: HookReceiptStatus;
  body: string;
  receivedAt: string;
}

interface RawReceiptRow {
  id: string;
  hook_id: string;
  idempotency_key: string;
  delivery_id: string;
  external_id: string;
  status: string;
  body: string;
  received_at: string;
}

function rowToReceipt(row: RawReceiptRow): HookReceiptRecord {
  return {
    id: asString(row.id),
    hookId: asString(row.hook_id),
    idempotencyKey: asString(row.idempotency_key),
    deliveryId: asString(row.delivery_id),
    externalId: asString(row.external_id),
    status: asString(row.status) as HookReceiptStatus,
    body: asString(row.body),
    receivedAt: asString(row.received_at),
  };
}

export function newHookReceiptId(): string {
  return newUlid();
}

export function getHookReceiptByIdempotencyKey(
  db: DatabaseSync,
  idempotencyKey: string,
): HookReceiptRecord | null {
  const row = db
    .prepare('SELECT * FROM hook_receipts WHERE idempotency_key = ?')
    .get(idempotencyKey) as RawReceiptRow | undefined;
  return row === undefined ? null : rowToReceipt(row);
}

export function getHookReceiptByDelivery(
  db: DatabaseSync,
  hookId: string,
  deliveryId: string,
): HookReceiptRecord | null {
  const row = db
    .prepare('SELECT * FROM hook_receipts WHERE hook_id = ? AND delivery_id = ?')
    .get(hookId, deliveryId) as RawReceiptRow | undefined;
  return row === undefined ? null : rowToReceipt(row);
}

export function insertHookReceipt(tx: TransactionContext, record: HookReceiptRecord): void {
  tx.db
    .prepare(
      `INSERT INTO hook_receipts
         (id, hook_id, idempotency_key, delivery_id, external_id, status, body, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.hookId,
      record.idempotencyKey,
      record.deliveryId,
      record.externalId,
      record.status,
      record.body,
      record.receivedAt,
    );
}

export function listHookReceipts(db: DatabaseSync): HookReceiptRecord[] {
  const rows = db
    .prepare('SELECT * FROM hook_receipts ORDER BY received_at ASC, id ASC')
    .all() as unknown as RawReceiptRow[];
  return rows.map(rowToReceipt);
}

// -- event helpers ----------------------------------------------------------

/** Types that cancel not-yet-sent hooks for the same demand (docs/008 §5). */
export const HOOK_CANCEL_TRIGGER_TYPES: readonly EventType[] = [
  'demand.cancelled',
  'stage.cancelled',
  'artifact.rejected',
];

export type HookEventType =
  | 'hook.attempted'
  | 'hook.delivered'
  | 'hook.dead'
  | 'hook.cancelled'
  | 'hook.receipt';

/** Append one persisted `hook.*` event inside the caller's transaction. */
export function appendHookEvent(
  tx: TransactionContext,
  type: HookEventType,
  hookId: string,
  data: Record<string, unknown>,
  demandId?: string,
): void {
  tx.append({
    type,
    subject: { type: 'hook', id: hookId },
    data,
    ...(demandId === undefined ? {} : { demandId }),
  });
}

export interface HookAttemptSummary {
  at: string;
  attempt: number;
  ok: boolean;
  error: string | null;
}

/** Latest `hook.attempted|delivered|dead` event for one hook (GET /hooks). */
export function recentHookAttempt(db: DatabaseSync, hookId: string): HookAttemptSummary | null {
  const row = db
    .prepare(
      `SELECT type, at, data FROM events
       WHERE subject_type = 'hook' AND subject_id = ?
         AND type IN ('hook.attempted', 'hook.delivered', 'hook.dead')
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(hookId) as { type: string; at: string; data: string } | undefined;
  if (row === undefined) return null;
  const data = decodeJson<Record<string, unknown>>(row.data);
  const attempt = typeof data['attempt'] === 'number' ? data['attempt'] : 0;
  const error = typeof data['error'] === 'string' ? data['error'] : null;
  return { at: asString(row.at), attempt, ok: row.type === 'hook.delivered', error };
}

export interface HookDeliveryEvent {
  seq: number;
  eventId: string;
  hookId: string;
  target: string;
  attempt: number;
  externalId: string | null;
  at: string;
}

/** Delivered/dead hook events (reconcile joins them with receipts). */
export function listHookDeliveryEvents(db: DatabaseSync): HookDeliveryEvent[] {
  const rows = db
    .prepare(
      `SELECT seq, type, at, subject_id, data FROM events
       WHERE subject_type = 'hook' AND type IN ('hook.delivered', 'hook.dead')
       ORDER BY seq ASC`,
    )
    .all() as unknown as Array<{
    seq: number;
    type: string;
    at: string;
    subject_id: string;
    data: string;
  }>;
  return rows.map((row) => {
    const data = decodeJson<Record<string, unknown>>(row.data);
    return {
      seq: asNumber(row.seq),
      eventId: typeof data['eventId'] === 'string' ? data['eventId'] : '',
      hookId: asString(row.subject_id),
      target: typeof data['target'] === 'string' ? data['target'] : hookTarget(asString(row.subject_id)),
      attempt: typeof data['attempt'] === 'number' ? data['attempt'] : 0,
      externalId: typeof data['externalId'] === 'string' ? data['externalId'] : null,
      at: asString(row.at),
    };
  });
}
