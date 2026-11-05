import type { EventEnvelope } from '@sap-superagent/protocol';
import { listEventsAfter } from '../db/events.js';
import { writeTransaction } from '../db/transaction.js';
import type { ServerContext } from '../types.js';
import { enabledHooks, type HooksRuntimeConfig } from '../hooks/hook-config.js';
import { buildHookEnvelope } from '../hooks/hook-envelope.js';
import {
  appendHookEvent,
  getHookEnqueueCursor,
  HOOK_CANCEL_TRIGGER_TYPES,
  hookIdFromTarget,
  hookOutboxId,
  hookTarget,
  insertHookOutboxRow,
  listPendingHookOutbox,
  markHookOutboxCancelled,
  parseHookEnvelope,
  setHookEnqueueCursor,
} from '../hooks/hook-store.js';

// ---------------------------------------------------------------------------
// S4: generic Hook outbound worker (docs/008 §5/§6).
//
// §1.2 (this commit) implements the *trigger* half: scan the persisted event
// log after the hook cursor, append one `target='hook:<id>'` outbox row per
// enabled subscribed hook, and cancel not-yet-sent rows on demand-cancel /
// stage-rollback events. §1.3 adds HTTP delivery on top of this queue.
//
// The worker is only started when at least one hook is enabled; a missing hook
// config keeps `pnpm dev` byte-for-byte identical to H0–S3.
// ---------------------------------------------------------------------------

const ENQUEUE_BATCH_SIZE = 200;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringData(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function demandIdOf(event: EventEnvelope): string | null {
  return stringData(event.data, 'demandId') ?? (event.subject.type === 'demand' ? event.subject.id : null);
}

export interface HookTickResult {
  enqueued: number;
  cancelled: number;
}

export class HookDeliveryWorker {
  private readonly ctx: ServerContext;
  private readonly hooks: HooksRuntimeConfig;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(ctx: ServerContext, hooks: HooksRuntimeConfig) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  start(): void {
    if (!this.hooks.settings.enabled || this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.hooks.settings.pollMs);
    this.timer.unref();
    // Drain events that were committed before the process started.
    this.poll();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tickInFlight !== null) await this.tickInFlight;
  }

  /** One enqueue cycle (exposed for integration tests). */
  async tick(): Promise<HookTickResult> {
    return { ...this.enqueuePendingEvents() };
  }

  private poll(): void {
    if (this.stopped || this.tickInFlight !== null) return;
    const promise: Promise<void> = this.tick()
      .then(() => undefined)
      .catch((error: unknown) => this.log(`tick failed: ${errorMessage(error)}`))
      .finally(() => {
        this.tickInFlight = null;
      });
    this.tickInFlight = promise;
  }

  // -- enqueue -------------------------------------------------------------

  private enqueuePendingEvents(): HookTickResult {
    const cursor = getHookEnqueueCursor(this.ctx.db);
    const events = listEventsAfter(this.ctx.db, cursor, ENQUEUE_BATCH_SIZE);
    if (events.length === 0) return { enqueued: 0, cancelled: 0 };

    const hooks = enabledHooks(this.hooks);
    let enqueued = 0;
    let cancelled = 0;
    for (const event of events) {
      if (HOOK_CANCEL_TRIGGER_TYPES.includes(event.type)) {
        cancelled += this.cancelPendingForDemand(event);
      }
      for (const hook of hooks) {
        if (!hook.events.includes(event.type)) continue;
        const envelope = buildHookEnvelope(hook, event);
        const now = new Date(this.ctx.clock()).toISOString();
        const inserted = insertHookOutboxRow(this.ctx.db, {
          id: hookOutboxId(event.id, hook.id),
          eventSeq: event.seq,
          target: hookTarget(hook.id),
          envelope,
          nextAttemptAt: now,
          now,
        });
        if (inserted) {
          enqueued += 1;
          this.log(`enqueued ${hook.id} <- ${event.type} (${event.id})`);
        }
      }
    }
    const lastSeq = events[events.length - 1]?.seq ?? cursor;
    setHookEnqueueCursor(this.ctx.db, lastSeq, new Date(this.ctx.clock()).toISOString());
    return { enqueued, cancelled };
  }

  /**
   * docs/008 §5: on demand cancel / stage rollback, not-yet-sent hooks for the
   * same demand are marked CANCELLED and a `hook.cancelled` event is recorded;
   * already sent hooks are left untouched (no close action in v1).
   */
  private cancelPendingForDemand(event: EventEnvelope): number {
    const demandId = demandIdOf(event);
    if (demandId === null) return 0;
    const pending = listPendingHookOutbox(this.ctx.db).filter((row) => {
      const envelope = parseHookEnvelope(row.payload);
      return envelope !== null && envelope.subject.demandId === demandId;
    });
    if (pending.length === 0) return 0;
    const now = new Date(this.ctx.clock()).toISOString();
    writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
      for (const row of pending) {
        const hookId = hookIdFromTarget(row.target) ?? row.target;
        const envelope = parseHookEnvelope(row.payload);
        markHookOutboxCancelled(tx.db, row.id, `cancelled_by:${event.type}`, now);
        appendHookEvent(
          tx,
          'hook.cancelled',
          hookId,
          {
            hookId,
            target: row.target,
            eventId: envelope?.eventId ?? row.id,
            reason: event.type,
            delivered: false,
          },
          demandId,
        );
      }
    });
    return pending.length;
  }

  private log(message: string): void {
    if (this.ctx.config.logger) console.error(`[hooks] ${message}`);
  }
}
