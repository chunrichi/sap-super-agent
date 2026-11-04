import type { DatabaseSync } from 'node:sqlite';
import type { EventEnvelope } from '@sap-superagent/protocol';
import { insertEvent, type EventDraft } from './events.js';

export interface TransactionContext {
  readonly db: DatabaseSync;
  /** Server time captured when the transaction began (ISO-8601 UTC). */
  readonly now: string;
  append(draft: EventDraft): EventEnvelope;
}

export type EventSink = (events: readonly EventEnvelope[]) => void;

/**
 * Run `fn` inside `BEGIN IMMEDIATE`, collecting events that are broadcast only
 * after COMMIT so clients never observe uncommitted state (docs/003 §4.4).
 */
export function writeTransaction<T>(
  db: DatabaseSync,
  sink: EventSink,
  fn: (tx: TransactionContext) => T,
): T {
  const now = new Date().toISOString();
  const events: EventEnvelope[] = [];
  db.exec('BEGIN IMMEDIATE');
  let value: T;
  try {
    const tx: TransactionContext = {
      db,
      now,
      append: (draft) => {
        const event = insertEvent(db, draft, now);
        events.push(event);
        return event;
      },
    };
    value = fn(tx);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be closed; surface the original error.
    }
    throw error;
  }
  if (events.length > 0) sink(events);
  return value;
}
