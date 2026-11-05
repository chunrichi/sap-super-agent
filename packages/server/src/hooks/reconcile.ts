import type { DatabaseSync } from 'node:sqlite';
import type { HookQueueDepth } from '@sap-superagent/protocol';
import type { HooksRuntimeConfig, ResolvedHook } from './hook-config.js';
import {
  hookTarget,
  listHookDeliveryEvents,
  listHookOutbox,
  listHookReceipts,
  parseHookEnvelope,
  type HookDeliveryEvent,
  type HookOutboxRow,
  type HookReceiptRecord,
} from './hook-store.js';

// ---------------------------------------------------------------------------
// S4: `pnpm hooks:reconcile` core (docs/008 §7, task book §1.6).
//
// Read-only daily reconcile. Two difference classes:
//   A. external list has ids the control plane does not know
//      (`external_only`) — compared only when the hook configures reconcileUrl;
//   B. control plane expects work the external system has not acknowledged
//      (`delivered_without_receipt`, `dead_letter`, `unknown_receipt`).
// It NEVER repairs or replays creation actions; a difference is a human task.
// ---------------------------------------------------------------------------

export const DEFAULT_HOOK_RECONCILE_SLA_MS = 24 * 60 * 60 * 1_000;
export const HOOK_RECONCILE_FETCH_TIMEOUT_MS = 10_000;

export type HookReconcileClass = 'external_only' | 'control_plane_only';
export type HookReconcileDifferenceKind =
  | 'external_only'
  | 'delivered_without_receipt'
  | 'dead_letter'
  | 'unknown_receipt';

export interface HookReconcileDifference {
  class: HookReconcileClass;
  kind: HookReconcileDifferenceKind;
  hookId: string;
  /** Source event id when the difference came from an outbox row. */
  eventId?: string;
  externalId?: string;
  details: Record<string, unknown>;
}

export interface HookReconcileExternalCheck {
  hookId: string;
  ok: boolean;
  /** Human-readable reason when the external list could not be compared. */
  reason: string;
  externalCount: number;
}

export interface HookReconcileReport {
  checkedAt: string;
  slaMs: number;
  hooks: number;
  external: HookReconcileExternalCheck[];
  differences: HookReconcileDifference[];
  counts: Record<HookReconcileDifferenceKind, number>;
  queue: Record<string, HookQueueDepth>;
  summary: string;
}

export interface HookReconcileOptions {
  checkedAt?: string;
  slaMs?: number;
  nowMs?: number;
  /** Injected for tests; defaults to global fetch + 10s timeout. */
  fetchExternal?: (url: string) => Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyCounts(): Record<HookReconcileDifferenceKind, number> {
  return {
    external_only: 0,
    delivered_without_receipt: 0,
    dead_letter: 0,
    unknown_receipt: 0,
  };
}

/** External listings may be a bare array or `{items|demands|records|issues: []}`. */
function extractExternalIds(payload: unknown): string[] {
  const candidates = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object'
      ? (['items', 'demands', 'records', 'issues'] as const)
          .map((key) => (payload as Record<string, unknown>)[key])
          .find((value) => Array.isArray(value))
      : undefined;
  if (!Array.isArray(candidates)) return [];
  const ids: string[] = [];
  for (const entry of candidates) {
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      for (const key of ['externalId', 'id', 'key']) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
          ids.push(value);
          break;
        }
      }
    } else if (typeof entry === 'string' && entry.length > 0) {
      ids.push(entry);
    }
  }
  return ids;
}

async function fetchExternalList(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(HOOK_RECONCILE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return (await response.json()) as unknown;
}

function outboxQueue(rows: readonly HookOutboxRow[]): HookQueueDepth {
  const queue: HookQueueDepth = { pending: 0, sent: 0, dead: 0, cancelled: 0 };
  for (const row of rows) {
    if (row.status === 'PENDING') queue.pending += 1;
    else if (row.status === 'SENT') queue.sent += 1;
    else if (row.status === 'DEAD') queue.dead += 1;
    else queue.cancelled += 1;
  }
  return queue;
}

interface HookSlice {
  hook: ResolvedHook;
  rows: HookOutboxRow[];
  deliveries: HookDeliveryEvent[];
  receipts: HookReceiptRecord[];
  /** External ids the control plane learned from 2xx deliveries. */
  deliveredExternalIds: Set<string>;
  /** Delivered ids plus receipt ids: everything the control plane knows about. */
  knownExternalIds: Set<string>;
}

function sliceHook(
  hook: ResolvedHook,
  outbox: readonly HookOutboxRow[],
  deliveries: readonly HookDeliveryEvent[],
  receipts: readonly HookReceiptRecord[],
): HookSlice {
  const rows = outbox.filter((row) => row.target === hookTarget(hook.id));
  const hookDeliveries = deliveries.filter((event) => event.hookId === hook.id);
  const hookReceipts = receipts.filter((receipt) => receipt.hookId === hook.id);
  const deliveredExternalIds = new Set<string>();
  for (const delivery of hookDeliveries) {
    if (delivery.externalId !== null) deliveredExternalIds.add(delivery.externalId);
  }
  const knownExternalIds = new Set(deliveredExternalIds);
  for (const receipt of hookReceipts) knownExternalIds.add(receipt.externalId);
  return {
    hook,
    rows,
    deliveries: hookDeliveries,
    receipts: hookReceipts,
    deliveredExternalIds,
    knownExternalIds,
  };
}

function controlPlaneDifferences(slice: HookSlice, slaMs: number, nowMs: number): HookReconcileDifference[] {
  const differences: HookReconcileDifference[] = [];
  const deliveryByEvent = new Map<string, HookDeliveryEvent>();
  for (const delivery of slice.deliveries) {
    if (delivery.eventId.length > 0) deliveryByEvent.set(delivery.eventId, delivery);
  }
  const receiptExternalIds = new Set(slice.receipts.map((receipt) => receipt.externalId));

  for (const row of slice.rows) {
    const envelope = parseHookEnvelope(row.payload);
    if (row.status === 'DEAD') {
      differences.push({
        class: 'control_plane_only',
        kind: 'dead_letter',
        hookId: slice.hook.id,
        ...(envelope === null ? {} : { eventId: envelope.eventId }),
        details: {
          outboxId: row.id,
          attempts: row.attempts,
          lastError: row.lastError,
          eventType: envelope?.eventType ?? null,
        },
      });
      continue;
    }
    if (row.status !== 'SENT' || row.sentAt === null) continue;
    const sentAtMs = Date.parse(row.sentAt);
    if (Number.isNaN(sentAtMs) || nowMs - sentAtMs < slaMs) continue;
    const delivery = envelope === null ? undefined : deliveryByEvent.get(envelope.eventId);
    const externalId = delivery?.externalId ?? null;
    if (externalId !== null && receiptExternalIds.has(externalId)) continue;
    differences.push({
      class: 'control_plane_only',
      kind: 'delivered_without_receipt',
      hookId: slice.hook.id,
      ...(envelope === null ? {} : { eventId: envelope.eventId }),
      ...(externalId === null ? {} : { externalId }),
      details: {
        outboxId: row.id,
        sentAt: row.sentAt,
        slaMs,
        note:
          externalId === null
            ? '2xx response carried no externalId, so no receipt can be matched'
            : 'no hook.receipt recorded for this externalId',
      },
    });
  }

  for (const receipt of slice.receipts) {
    // An externalId the control plane never delivered cannot come from us —
    // unless it was learned from a delivery, the receipt is orphaned.
    if (slice.deliveredExternalIds.has(receipt.externalId)) continue;
    differences.push({
      class: 'control_plane_only',
      kind: 'unknown_receipt',
      hookId: slice.hook.id,
      externalId: receipt.externalId,
      details: {
        receiptId: receipt.id,
        idempotencyKey: receipt.idempotencyKey,
        status: receipt.status,
        receivedAt: receipt.receivedAt,
      },
    });
  }
  return differences;
}

async function externalDifferences(
  slice: HookSlice,
  fetcher: (url: string) => Promise<unknown>,
): Promise<{ check: HookReconcileExternalCheck; differences: HookReconcileDifference[] }> {
  const url = slice.hook.reconcileUrl;
  if (url === undefined) {
    return {
      check: {
        hookId: slice.hook.id,
        ok: false,
        externalCount: 0,
        reason: 'no reconcileUrl configured; cannot compare the external list',
      },
      differences: [],
    };
  }
  let payload: unknown;
  try {
    payload = await fetcher(url);
  } catch (error) {
    return {
      check: {
        hookId: slice.hook.id,
        ok: false,
        externalCount: 0,
        reason: `cannot fetch external list: ${errorMessage(error)}`,
      },
      differences: [],
    };
  }
  const externalIds = extractExternalIds(payload);
  const differences: HookReconcileDifference[] = [];
  for (const externalId of new Set(externalIds)) {
    if (slice.knownExternalIds.has(externalId)) continue;
    differences.push({
      class: 'external_only',
      kind: 'external_only',
      hookId: slice.hook.id,
      externalId,
      details: { reconcileUrl: url },
    });
  }
  return {
    check: { hookId: slice.hook.id, ok: true, externalCount: externalIds.length, reason: 'compared' },
    differences,
  };
}

/**
 * Build the read-only Hook reconcile report (docs/008 §7). Loads the S4
 * tables from the control-plane SQLite database; never writes and never repairs.
 */
export async function reconcileHooks(
  db: DatabaseSync,
  hooks: HooksRuntimeConfig,
  options: HookReconcileOptions = {},
): Promise<HookReconcileReport> {
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = options.checkedAt ?? new Date(nowMs).toISOString();
  const slaMs = options.slaMs ?? DEFAULT_HOOK_RECONCILE_SLA_MS;
  const fetcher = options.fetchExternal ?? fetchExternalList;

  const outbox = listHookOutbox(db);
  const deliveries = listHookDeliveryEvents(db);
  const receipts = listHookReceipts(db);

  const differences: HookReconcileDifference[] = [];
  const external: HookReconcileExternalCheck[] = [];
  const queue: Record<string, HookQueueDepth> = {};

  for (const hook of hooks.hooks) {
    const slice = sliceHook(hook, outbox, deliveries, receipts);
    queue[hook.id] = outboxQueue(slice.rows);
    differences.push(...controlPlaneDifferences(slice, slaMs, nowMs));
    const externalResult = await externalDifferences(slice, fetcher);
    external.push(externalResult.check);
    differences.push(...externalResult.differences);
  }

  const counts = emptyCounts();
  for (const difference of differences) counts[difference.kind] += 1;

  const externalOnly = counts.external_only;
  const controlPlaneOnly =
    counts.delivered_without_receipt + counts.dead_letter + counts.unknown_receipt;
  const summary =
    hooks.hooks.length === 0
      ? 'no hooks configured (nothing to reconcile)'
      : `${hooks.hooks.length} hook(s), ${differences.length} difference(s) ` +
        `(external only: ${externalOnly}, control plane only: ${controlPlaneOnly})`;

  return { checkedAt, slaMs, hooks: hooks.hooks.length, external, differences, counts, queue, summary };
}
