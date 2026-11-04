import type { DatabaseSync } from 'node:sqlite';
import {
  newUlid,
  type EventEnvelope,
  type EventSubjectType,
  type EventType,
} from '@sap-superagent/protocol';
import { asNumber, asString, decodeJson, encodeJson } from './rows.js';

export interface EventDraft {
  type: EventType;
  subject: { type: EventSubjectType; id: string };
  data: Record<string, unknown>;
  /** Denormalized for fast demand timelines; also keeps 002's demand audit cheap. */
  demandId?: string;
}

interface EventRow {
  seq: number;
  id: string;
  type: string;
  at: string;
  subject_type: string;
  subject_id: string;
  data: string;
  demand_id: string | null;
}

function rowToEvent(row: EventRow): EventEnvelope {
  return {
    seq: asNumber(row.seq),
    id: asString(row.id),
    type: asString(row.type) as EventType,
    at: asString(row.at),
    subject: {
      type: asString(row.subject_type) as EventSubjectType,
      id: asString(row.subject_id),
    },
    data: decodeJson<Record<string, unknown>>(row.data),
  };
}

export function insertEvent(db: DatabaseSync, draft: EventDraft, at: string): EventEnvelope {
  const id = newUlid();
  const row = db
    .prepare(
      `INSERT INTO events (id, type, at, subject_type, subject_id, data, demand_id)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
    )
    .get(
      id,
      draft.type,
      at,
      draft.subject.type,
      draft.subject.id,
      encodeJson(draft.data),
      draft.demandId ?? null,
    ) as unknown as { seq: number };
  return {
    seq: asNumber(row.seq),
    id,
    type: draft.type,
    at,
    subject: { type: draft.subject.type, id: draft.subject.id },
    data: draft.data,
  };
}

export interface EventSeqWindow {
  earliestSeq: number;
  lastSeq: number;
}

export function eventSeqWindow(db: DatabaseSync): EventSeqWindow {
  const row = db.prepare('SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM events').get() as
    | { minSeq: number | null; maxSeq: number | null }
    | undefined;
  const minSeq = row?.minSeq ?? null;
  const maxSeq = row?.maxSeq ?? null;
  return {
    earliestSeq: minSeq === null ? 0 : asNumber(minSeq),
    lastSeq: maxSeq === null ? 0 : asNumber(maxSeq),
  };
}

export function listEventsAfter(
  db: DatabaseSync,
  after: number,
  limit: number,
): EventEnvelope[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    .all(after, limit) as unknown as EventRow[];
  return rows.map(rowToEvent);
}

export function eventsForDemand(db: DatabaseSync, demandId: string): EventEnvelope[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE demand_id = ? ORDER BY seq ASC')
    .all(demandId) as unknown as EventRow[];
  return rows.map(rowToEvent);
}

/** Retention pruning keeps the newest event so cursors outside the window stay detectable. */
export function pruneEvents(db: DatabaseSync, cutoffIso: string): number {
  const result = db
    .prepare('DELETE FROM events WHERE at < ? AND seq < (SELECT MAX(seq) FROM events)')
    .run(cutoffIso);
  return Number(result.changes);
}

