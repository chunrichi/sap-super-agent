import {
  SapIcfClient,
  SapIcfError,
  buildSapWritebackPatch,
  projectSapStatus,
  type SapStatusProjection,
  type SapWritebackPatch,
} from '@sap-superagent/sap-adapter';
import { getDemand } from '../db/demands.js';
import { listStageRunsForDemand } from '../db/stages.js';
import type { ServerContext } from '../types.js';
import type { SapIntegrationConfig } from '../hooks/sap-config.js';
import {
  getSapSyncVersion,
  getWritebackCursor,
  insertSapOutboxRow,
  listApprovalsForDemand,
  listArtifactMetadata,
  listDueSapOutbox,
  listEventsForWriteback,
  markSapOutboxDead,
  markSapOutboxRetry,
  markSapOutboxSent,
  maxEventSeq,
  setWritebackCursor,
  upsertSapSyncVersion,
  type SapOutboxRow,
} from '../hooks/sap-store.js';

// ---------------------------------------------------------------------------
// H2: SAP writeback worker (docs/004 §3.1, docs/008 §3 "SAP 回写", docs/009 #12).
//
// 1. Enqueue: scan new control-plane events and append one `sap.writeback`
//    outbox row each (id = event id, so re-scans are idempotent).
// 2. Deliver: PATCH the ICF API with the whitelisted status projection /
//    artifact metadata, `If-Match: <SAP version>`.
// 3. Retry: 2s exponential backoff capped at 5min, max 5 attempts, permanent
//    failures (4xx) go straight to the dead letter (docs/008 §5).
// 4. 409/precondition: re-pull the SAP demand, refresh the version and replay
//    once immediately, so a concurrent SAP edit does not lose the projection.
// ---------------------------------------------------------------------------

/** Events that must be projected into SAP (docs/008 §3 SAP 回写 row). */
export const SAP_WRITEBACK_EVENT_TYPES: readonly string[] = [
  'demand.updated',
  'demand.cancelled',
  'artifact.created',
  'artifact.approved',
  'artifact.rejected',
];

interface SapWritebackPayload {
  eventId: string;
  eventType: string;
  demandId: string;
  occurredAt: string;
  ifMatchVersion: number | null;
  patch: SapWritebackPatch;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringData(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class SapWritebackWorker {
  private readonly ctx: ServerContext;
  private readonly sap: SapIntegrationConfig;
  /** Lazily created so a disabled integration never validates/reaches SAP. */
  private client: SapIcfClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(ctx: ServerContext, sap: SapIntegrationConfig) {
    this.ctx = ctx;
    this.sap = sap;
  }

  private icfClient(): SapIcfClient {
    if (this.client === null) {
      this.client = new SapIcfClient({
        baseUrl: this.sap.baseUrl,
        timeoutMs: this.sap.timeoutMs,
        getRetries: 1,
        retryDelayMs: Math.min(50, this.sap.writeback.backoffBaseMs),
        ...(this.sap.token === undefined ? {} : { token: this.sap.token }),
        ...(this.sap.username === undefined ? {} : { username: this.sap.username }),
        ...(this.sap.password === undefined ? {} : { password: this.sap.password }),
      });
    }
    return this.client;
  }

  start(): void {
    if (!this.sap.enabled || this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.sap.writeback.pollMs);
    this.timer.unref();
    // Drain anything that piled up while the process was down.
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

  /** Process one enqueue+drain cycle (exposed for integration tests). */
  async tick(): Promise<{ enqueued: number; delivered: number; failed: number }> {
    const enqueued = this.enqueuePendingEvents();
    const outcome = await this.drain();
    return { enqueued, ...outcome };
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

  private enqueuePendingEvents(): number {
    const cursor = getWritebackCursor(this.ctx.db);
    const events = listEventsForWriteback(
      this.ctx.db,
      cursor,
      SAP_WRITEBACK_EVENT_TYPES,
      this.sap.writeback.batchSize,
    );
    if (events.length === 0) {
      const maxSeq = maxEventSeq(this.ctx.db);
      if (maxSeq > cursor) setWritebackCursor(this.ctx.db, maxSeq, new Date().toISOString());
      return 0;
    }
    let enqueued = 0;
    for (const event of events) {
      if (this.isEchoOfSapWrite(event)) continue;
      const payload = this.buildPayload(event);
      if (payload === null) continue;
      const inserted = insertSapOutboxRow(this.ctx.db, {
        id: event.id,
        eventSeq: event.seq,
        payload: JSON.stringify(payload),
        nextAttemptAt: new Date().toISOString(),
        now: new Date().toISOString(),
      });
      if (inserted) enqueued += 1;
    }
    setWritebackCursor(this.ctx.db, events[events.length - 1]?.seq ?? cursor, new Date().toISOString());
    return enqueued;
  }

  /** Skip events that only echo a SAP-originated field change (no loop). */
  private isEchoOfSapWrite(event: { type: string; data: Record<string, unknown> }): boolean {
    return event.type === 'demand.updated' && stringData(event.data, 'reason') === 'sap_field_sync';
  }

  private buildPayload(event: {
    id: string;
    type: string;
    at: string;
    demandId: string | null;
    data: Record<string, unknown>;
  }): SapWritebackPayload | null {
    const demandId =
      stringData(event.data, 'demandId') ?? (event.demandId === null ? null : event.demandId);
    if (demandId === null) return null;
    const demand = getDemand(this.ctx.db, demandId);
    if (demand === null) return null;
    const stages = listStageRunsForDemand(this.ctx.db, demandId);
    const approvals = listApprovalsForDemand(this.ctx.db, demandId);
    const projection: SapStatusProjection = projectSapStatus({
      demand: { status: demand.status },
      stages,
      approvals,
    });
    const eventStageKey = stringData(event.data, 'stageKey');
    const artifactId = stringData(event.data, 'artifactId');
    const artifactStageKey =
      artifactId === null
        ? null
        : listArtifactMetadata(this.ctx.db, demandId).find((entry) => entry.artifactId === artifactId)
            ?.stageKey ?? null;
    const stageKey = eventStageKey ?? artifactStageKey ?? this.latestStageKey(stages);
    const artifacts =
      event.type === 'artifact.created' ||
      event.type === 'artifact.approved' ||
      event.type === 'artifact.rejected'
        ? listArtifactMetadata(this.ctx.db, demandId)
        : undefined;
    const approval =
      event.type === 'artifact.approved' || event.type === 'artifact.rejected'
        ? {
            gateKey: stringData(event.data, 'gateKey'),
            state: event.type === 'artifact.approved' ? ('approved' as const) : ('rejected' as const),
            decidedBy: stringData(event.data, 'decidedBy'),
            comment: stringData(event.data, 'comment'),
            decidedAt: stringData(event.data, 'decidedAt'),
          }
        : undefined;
    const patch = buildSapWritebackPatch({
      projection,
      stageKey,
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(approval === undefined ? {} : { approval }),
    });
    return {
      eventId: event.id,
      eventType: event.type,
      demandId,
      occurredAt: event.at,
      ifMatchVersion: getSapSyncVersion(this.ctx.db, demandId),
      patch,
    };
  }

  private latestStageKey(stages: ReturnType<typeof listStageRunsForDemand>): string | null {
    const relevant = stages.filter(
      (stage) => stage.status !== 'pending' && stage.status !== 'cancelled',
    );
    return relevant.at(-1)?.stageKey ?? null;
  }

  // -- 2./3./4. deliver with backoff, dead letter and 409 replay ------------

  private async drain(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    const now = new Date().toISOString();
    const rows = listDueSapOutbox(this.ctx.db, now, this.sap.writeback.batchSize);
    for (const row of rows) {
      const outcome = await this.deliver(row);
      if (outcome === 'sent') delivered += 1;
      else failed += 1;
    }
    return { delivered, failed };
  }

  private async deliver(row: SapOutboxRow): Promise<'sent' | 'retry' | 'dead'> {
    const payload = JSON.parse(row.payload) as SapWritebackPayload;
    let ifMatch: number | undefined =
      payload.ifMatchVersion === null ? undefined : payload.ifMatchVersion;
    try {
      if (ifMatch === undefined) {
        ifMatch = await this.pullSapVersion(payload.demandId);
      }
      const result = await this.icfClient().patchDemand(
        payload.demandId,
        payload.patch,
        ifMatch === undefined ? {} : { ifMatch },
      );
      this.markSent(row, result.demand.version);
      return 'sent';
    } catch (error) {
      if (
        error instanceof SapIcfError &&
        (error.kind === 'conflict' || error.kind === 'precondition_required')
      ) {
        return await this.replayAfterConflict(row, payload);
      }
      return this.handleFailure(row, error);
    }
  }

  /**
   * docs/009 #12: on 409 re-pull the demand, refresh the SAP version and replay
   * the same patch once. If the replay also fails we fall back to the normal
   * retry/dead-letter path.
   */
  private async replayAfterConflict(
    row: SapOutboxRow,
    payload: SapWritebackPayload,
  ): Promise<'sent' | 'retry' | 'dead'> {
    try {
      const version = await this.pullSapVersion(payload.demandId);
      const result = await this.icfClient().patchDemand(
        payload.demandId,
        payload.patch,
        version === undefined ? {} : { ifMatch: version },
      );
      this.markSent(row, result.demand.version);
      return 'sent';
    } catch (error) {
      return this.handleFailure(row, error);
    }
  }

  /** GET the SAP demand and refresh the locally tracked optimistic version. */
  private async pullSapVersion(demandId: string): Promise<number | undefined> {
    const detail = await this.icfClient().getDemand(demandId);
    const version = detail.demand.version;
    if (typeof version !== 'number') return undefined;
    upsertSapSyncVersion(this.ctx.db, demandId, version, new Date().toISOString());
    return version;
  }

  private markSent(row: SapOutboxRow, sapVersion: number | null | undefined): void {
    const at = new Date().toISOString();
    if (typeof sapVersion === 'number') {
      const payload = JSON.parse(row.payload) as SapWritebackPayload;
      upsertSapSyncVersion(this.ctx.db, payload.demandId, sapVersion, at);
    }
    markSapOutboxSent(this.ctx.db, row.id, at);
  }

  private handleFailure(row: SapOutboxRow, error: unknown): 'retry' | 'dead' {
    const attempts = row.attempts + 1;
    const message = errorMessage(error);
    const retryable = error instanceof SapIcfError ? error.retryable : false;
    if (!retryable || attempts >= this.sap.writeback.maxAttempts) {
      markSapOutboxDead(this.ctx.db, row.id, attempts, message, new Date().toISOString());
      this.log(`writeback ${row.id} dead after ${attempts} attempt(s): ${message}`);
      return 'dead';
    }
    const delay = Math.min(
      this.sap.writeback.backoffBaseMs * 2 ** (attempts - 1),
      this.sap.writeback.backoffMaxMs,
    );
    const nextAttemptAt = new Date(Date.now() + delay).toISOString();
    markSapOutboxRetry(this.ctx.db, row.id, attempts, nextAttemptAt, message, new Date().toISOString());
    this.log(
      `writeback ${row.id} attempt ${attempts}/${this.sap.writeback.maxAttempts} failed (${message}); retry at ${nextAttemptAt}`,
    );
    return 'retry';
  }

  private log(message: string): void {
    if (this.ctx.config.logger) console.error(`[sap-writeback] ${message}`);
  }
}
