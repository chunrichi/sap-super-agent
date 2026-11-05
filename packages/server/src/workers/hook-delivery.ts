import {
  HOOK_ENVELOPE_VERSION,
  hookEnvelopeSchema,
  type EventEnvelope,
  type HookEnvelope,
} from '@sap-superagent/protocol';
import { listEventsAfter } from '../db/events.js';
import { writeTransaction, type TransactionContext } from '../db/transaction.js';
import type { ServerContext } from '../types.js';
import {
  enabledHooks,
  findHook,
  type HooksRuntimeConfig,
  type ResolvedHook,
} from '../hooks/hook-config.js';
import { buildHookEnvelope } from '../hooks/hook-envelope.js';
import { buildHookSignatureHeaders } from '../hooks/hook-signature.js';
import {
  appendHookEvent,
  findHookOutboxByEventId,
  getHookEnqueueCursor,
  HOOK_CANCEL_TRIGGER_TYPES,
  hookIdFromTarget,
  hookOutboxId,
  hookTarget,
  insertHookOutboxRow,
  listDueHookOutbox,
  listPendingHookOutbox,
  markHookOutboxCancelled,
  markHookOutboxDead,
  markHookOutboxRetry,
  markHookOutboxSent,
  parseHookEnvelope,
  recentHookAttempt,
  setHookEnqueueCursor,
  type HookOutboxRow,
} from '../hooks/hook-store.js';

// ---------------------------------------------------------------------------
// S4: generic Hook worker (docs/008 §5/§6).
//
// tick() does two independent things:
//   1. enqueue: scan the persisted event log after the hook cursor and append
//      one `target='hook:<id>'` outbox row per enabled subscribed hook; on
//      demand-cancel / stage-rollback events cancel not-yet-sent rows;
//   2. deliver: drain due PENDING rows over HTTP with HMAC, 2s exponential
//      backoff capped at 5min, max 5 attempts, 4xx -> DLQ, 429 honours
//      Retry-After, and hook.attempted/delivered/dead events per attempt.
//
// The worker is only started when at least one hook is enabled; a missing hook
// config keeps `pnpm dev` byte-for-byte identical to H0–S3.
// ---------------------------------------------------------------------------

const ENQUEUE_BATCH_SIZE = 200;
const DRAIN_BATCH_SIZE = 10;
const ERROR_EXCERPT_LENGTH = 300;

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

function envelopeDemandId(envelope: HookEnvelope | null): string | undefined {
  return envelope?.subject.demandId;
}

/** 2xx bodies may carry the external id; v1 accepts these conventional fields. */
function extractExternalId(text: string): string | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    for (const key of ['externalId', 'id', 'key']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/** `Retry-After: <seconds>` or an HTTP date -> delay in ms (docs/008 §5). */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1_000;
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

export interface HookTickResult {
  enqueued: number;
  cancelled: number;
  delivered: number;
  failed: number;
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

  /** One enqueue+drain cycle (exposed for integration tests). */
  async tick(): Promise<HookTickResult> {
    const enqueue = this.enqueuePendingEvents();
    const drain = await this.drain();
    return { ...enqueue, ...drain };
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

  // -- 1. enqueue ----------------------------------------------------------

  private enqueuePendingEvents(): { enqueued: number; cancelled: number } {
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
    this.writeHookTx((tx) => {
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

  // -- 2. deliver ----------------------------------------------------------

  private async drain(): Promise<{ delivered: number; failed: number }> {
    const now = new Date(this.ctx.clock()).toISOString();
    const rows = listDueHookOutbox(this.ctx.db, now, DRAIN_BATCH_SIZE);
    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      const outcome = await this.deliver(row);
      if (outcome === 'sent') delivered += 1;
      else failed += 1;
    }
    return { delivered, failed };
  }

  private async deliver(
    row: HookOutboxRow,
  ): Promise<'sent' | 'retry' | 'dead' | 'cancelled'> {
    const hookId = hookIdFromTarget(row.target);
    const hook = hookId === null ? undefined : findHook(this.hooks, hookId);
    if (hook === undefined || !hook.enabled || hook.secret === null) {
      const reason = hook === undefined ? 'hook_not_configured' : 'hook_disabled';
      this.cancelRow(row, hookId ?? row.target, reason);
      return 'cancelled';
    }

    const envelope = parseHookEnvelope(row.payload);
    if (envelope === null) {
      return this.deadLetter(row, hook, row.attempts + 1, 'invalid_hook_envelope: payload is not JSON');
    }
    const validated = hookEnvelopeSchema.safeParse(envelope);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      return this.deadLetter(row, hook, row.attempts + 1, `invalid_hook_envelope: ${issues}`, envelope);
    }
    if (validated.data.eventVersion !== HOOK_ENVELOPE_VERSION) {
      return this.deadLetter(
        row,
        hook,
        row.attempts + 1,
        `unsupported_event_version: ${validated.data.eventVersion} (supported ${HOOK_ENVELOPE_VERSION})`,
        validated.data,
      );
    }

    const body = JSON.stringify(validated.data);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...buildHookSignatureHeaders({
        secret: hook.secret,
        body,
        delivery: validated.data.idempotencyKey,
      }),
    };

    let response: Response;
    try {
      response = await fetch(hook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.hooks.settings.timeoutMs),
      });
    } catch (error) {
      return this.retryOrDead(row, hook, validated.data, `request failed: ${errorMessage(error)}`);
    }

    const responseText = await response.text().catch(() => '');
    if (response.status >= 200 && response.status < 300) {
      const attempt = row.attempts + 1;
      const externalId = extractExternalId(responseText);
      const at = new Date(this.ctx.clock()).toISOString();
      this.writeHookTx((tx) => {
        markHookOutboxSent(tx.db, row.id, attempt, at);
        appendHookEvent(
          tx,
          'hook.delivered',
          hook.id,
          {
            hookId: hook.id,
            target: row.target,
            eventId: validated.data.eventId,
            attempt,
            externalId,
          },
          envelopeDemandId(validated.data),
        );
      });
      this.log(`delivered ${hook.id} (${validated.data.eventId}) attempt ${attempt}`);
      return 'sent';
    }

    const excerpt =
      responseText.length === 0 ? '' : `: ${responseText.slice(0, ERROR_EXCERPT_LENGTH)}`;
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.ctx.clock());
      return this.retryOrDead(
        row,
        hook,
        validated.data,
        `HTTP 429${excerpt}`,
        retryAfterMs === null ? undefined : retryAfterMs,
      );
    }
    if (response.status >= 500) {
      return this.retryOrDead(row, hook, validated.data, `HTTP ${response.status}${excerpt}`);
    }
    // docs/008 §5: 4xx is permanent -> dead letter immediately (no retry).
    return this.deadLetter(
      row,
      hook,
      row.attempts + 1,
      `HTTP ${response.status}${excerpt}`,
      validated.data,
    );
  }

  private retryOrDead(
    row: HookOutboxRow,
    hook: ResolvedHook,
    envelope: HookEnvelope,
    error: string,
    retryAfterMs?: number,
  ): 'retry' | 'dead' {
    const attempt = row.attempts + 1;
    if (attempt >= hook.retry.maxAttempts) {
      return this.deadLetter(row, hook, attempt, error, envelope);
    }
    const backoff = Math.min(
      this.hooks.settings.retryBaseMs * 2 ** (attempt - 1),
      this.hooks.settings.retryMaxMs,
    );
    // docs/008 §5: 429 is retried no earlier than Retry-After says.
    const delay = retryAfterMs === undefined ? backoff : Math.max(backoff, retryAfterMs);
    const nextAttemptAt = new Date(this.ctx.clock() + delay).toISOString();
    const at = new Date(this.ctx.clock()).toISOString();
    this.writeHookTx((tx) => {
      markHookOutboxRetry(tx.db, row.id, attempt, nextAttemptAt, error, at);
      appendHookEvent(
        tx,
        'hook.attempted',
        hook.id,
        {
          hookId: hook.id,
          target: row.target,
          eventId: envelope.eventId,
          attempt,
          error,
        },
        envelopeDemandId(envelope),
      );
    });
    this.log(`retry ${hook.id} (${envelope.eventId}) attempt ${attempt} in ${delay}ms: ${error}`);
    return 'retry';
  }

  private deadLetter(
    row: HookOutboxRow,
    hook: ResolvedHook,
    attempt: number,
    error: string,
    envelope?: HookEnvelope,
  ): 'dead' {
    const at = new Date(this.ctx.clock()).toISOString();
    const eventId = envelope?.eventId ?? row.id;
    this.writeHookTx((tx) => {
      markHookOutboxDead(tx.db, row.id, attempt, error, at);
      appendHookEvent(
        tx,
        'hook.attempted',
        hook.id,
        { hookId: hook.id, target: row.target, eventId, attempt, error },
        envelopeDemandId(envelope ?? null),
      );
      appendHookEvent(
        tx,
        'hook.dead',
        hook.id,
        { hookId: hook.id, target: row.target, eventId, attempt, error },
        envelopeDemandId(envelope ?? null),
      );
    });
    this.log(`dead ${hook.id} (${eventId}) after ${attempt} attempt(s): ${error}`);
    return 'dead';
  }

  private cancelRow(row: HookOutboxRow, hookId: string, reason: string): void {
    const at = new Date(this.ctx.clock()).toISOString();
    this.writeHookTx((tx) => {
      markHookOutboxCancelled(tx.db, row.id, reason, at);
      const envelope = parseHookEnvelope(row.payload);
      appendHookEvent(
        tx,
        'hook.cancelled',
        hookId,
        {
          hookId,
          target: row.target,
          eventId: envelope?.eventId ?? row.id,
          reason,
          delivered: false,
        },
        envelopeDemandId(envelope),
      );
    });
    this.log(`cancelled ${hookId} (${row.id}): ${reason}`);
  }

  private writeHookTx(fn: (tx: TransactionContext) => void): void {
    writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), fn);
  }

  private log(message: string): void {
    if (this.ctx.config.logger) console.error(`[hooks] ${message}`);
  }
}

// Re-exported for the management route (GET /hooks last-attempt summary).
export { findHookOutboxByEventId, recentHookAttempt };

// Keep the type export available to routes without importing the store directly.
export type { HookOutboxRow };
