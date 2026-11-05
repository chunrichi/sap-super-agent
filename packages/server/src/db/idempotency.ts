import type { DatabaseSync } from 'node:sqlite';
import { asNumber, asString } from './rows.js';

export interface IdempotencyRecord {
  status: number;
  body: string;
  method: string;
  path: string;
}

export function findIdempotencyRecord(
  db: DatabaseSync,
  key: string,
  notBeforeIso: string,
): IdempotencyRecord | null {
  const row = db
    .prepare(
      'SELECT status, body, method, path FROM idempotency WHERE idempotency_key = ? AND created_at >= ?',
    )
    .get(key, notBeforeIso) as unknown as
    | { status: number; body: string; method: string; path: string }
    | undefined;
  if (row === undefined) return null;
  return {
    status: asNumber(row.status),
    body: asString(row.body),
    method: asString(row.method),
    path: asString(row.path),
  };
}

export function saveIdempotencyRecord(
  db: DatabaseSync,
  key: string,
  method: string,
  path: string,
  status: number,
  body: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO idempotency (idempotency_key, method, path, status, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       method = excluded.method, path = excluded.path, status = excluded.status,
       body = excluded.body, created_at = excluded.created_at`,
  ).run(key, method, path, status, body, createdAt);
}

export function pruneIdempotencyRecords(db: DatabaseSync, cutoffIso: string): number {
  const result = db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(cutoffIso);
  return Number(result.changes);
}
