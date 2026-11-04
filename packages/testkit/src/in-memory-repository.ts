import { newUlid, type EventEnvelope, type EventSubject, type EventType } from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// In-memory repositories for unit-level fakes (H0 §1.8). The control plane
// itself always uses SQLite; these are the harness-side "内存仓库" used by
// tests and by the H2 fake SAP/executor stubs.
// ---------------------------------------------------------------------------

export interface Identified {
  id: string;
}

export class InMemoryRepository<T extends Identified> {
  private readonly rows = new Map<string, T>();

  constructor(seed: Iterable<T> = []) {
    for (const row of seed) this.rows.set(row.id, row);
  }

  get size(): number {
    return this.rows.size;
  }

  create(row: T): T {
    if (this.rows.has(row.id)) {
      throw new Error(`duplicate id: ${row.id}`);
    }
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): T | undefined {
    return this.rows.get(id);
  }

  require(id: string): T {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`missing id: ${id}`);
    return row;
  }

  list(): T[] {
    return [...this.rows.values()];
  }

  update(row: T): T {
    if (!this.rows.has(row.id)) throw new Error(`missing id: ${row.id}`);
    this.rows.set(row.id, row);
    return row;
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  snapshot(): T[] {
    return this.list();
  }

  reset(): void {
    this.rows.clear();
  }
}

export interface AppendEventInput {
  type: EventType;
  subject: EventSubject;
  data?: Record<string, unknown>;
  at?: string;
  id?: string;
}

export interface EventPage {
  events: EventEnvelope[];
  lastSeq: number;
  earliestSeq: number;
  resyncRequired: boolean;
}

/**
 * In-memory mirror of the append-only event log semantics used by the server:
 * global seq, replay cursor, retention pruning (always keeps the newest event)
 * and the docs/003 §4.4 resync rule.
 */
export class InMemoryEventLog {
  private readonly entries: EventEnvelope[] = [];
  private sequence = 0;

  get size(): number {
    return this.entries.length;
  }

  get lastSeq(): number {
    return this.entries.at(-1)?.seq ?? 0;
  }

  get earliestSeq(): number {
    return this.entries[0]?.seq ?? 0;
  }

  append(input: AppendEventInput): EventEnvelope {
    this.sequence += 1;
    const event: EventEnvelope = {
      seq: this.sequence,
      id: input.id ?? newUlid(),
      type: input.type,
      at: input.at ?? new Date().toISOString(),
      subject: input.subject,
      data: input.data ?? {},
    };
    this.entries.push(event);
    return event;
  }

  /** Replay after a cursor; too-old cursors receive `resyncRequired: true`. */
  after(cursor: number, limit = 200): EventPage {
    const earliestSeq = this.earliestSeq;
    const lastSeq = this.lastSeq;
    const resyncRequired =
      (cursor > 0 && cursor < earliestSeq - 1) || (cursor === 0 && earliestSeq > 1);
    const events = resyncRequired
      ? []
      : this.entries.filter((event) => event.seq > cursor).slice(0, limit);
    return { events, lastSeq, earliestSeq, resyncRequired };
  }

  /** Drop entries older than `cutoffIso`, but always keep the newest event. */
  pruneBefore(cutoffIso: string): number {
    if (this.entries.length <= 1) return 0;
    const newest = this.entries.at(-1);
    const kept = this.entries.filter((event) => event.at >= cutoffIso);
    const survivors = kept.length > 0 ? kept : newest === undefined ? [] : [newest];
    const removed = this.entries.length - survivors.length;
    this.entries.length = 0;
    this.entries.push(...survivors);
    return removed;
  }

  reset(): void {
    this.entries.length = 0;
    this.sequence = 0;
  }
}
