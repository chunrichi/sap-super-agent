import type { DatabaseSync } from 'node:sqlite';
import {
  newUlid,
  type Artifact,
  type ArtifactVersion,
  type Demand,
  type StageRun,
} from '@sap-superagent/protocol';
import {
  getArtifact,
  getArtifactVersion,
  listArtifactVersionsForDemand,
  listArtifactsForDemand,
} from '../db/artifacts.js';
import { getDemand, insertDemand } from '../db/demands.js';
import { insertStageRun, listStageRunsForDemand } from '../db/stages.js';
import type { TransactionContext } from '../db/transaction.js';
import { asNullableString, asNumber, asString, decodeJson, encodeJson } from '../db/rows.js';
import type { ServerContext } from '../types.js';
import type { SapDemandCreateInput } from '@sap-superagent/sap-adapter';

// ---------------------------------------------------------------------------
// H2 persistence helpers that live outside the H2-owned `hooks/` + `workers/`
// files: inbound webhook idempotency records, SAP sync versions, the writeback
// outbox and the small amount of SQL that the existing db/ layer does not
// expose yet. Everything is additive (migration v4, H2 §1.5).
// ---------------------------------------------------------------------------

export interface SapDeliveryRecord {
  deliveryId: string;
  eventId: string;
  eventType: string;
  demandId: string | null;
  receivedAt: string;
  state: string;
  result: string;
}

export function getSapDelivery(db: DatabaseSync, deliveryId: string): SapDeliveryRecord | null {
  const row = db.prepare('SELECT * FROM sap_deliveries WHERE delivery_id = ?').get(deliveryId) as
    | {
        delivery_id: string;
        event_id: string;
        event_type: string;
        demand_id: string | null;
        received_at: string;
        state: string;
        result: string;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    deliveryId: asString(row.delivery_id),
    eventId: asString(row.event_id),
    eventType: asString(row.event_type),
    demandId: asNullableString(row.demand_id),
    receivedAt: asString(row.received_at),
    state: asString(row.state),
    result: asString(row.result),
  };
}

export function insertSapDelivery(tx: TransactionContext, record: SapDeliveryRecord): void {
  tx.db
    .prepare(
      `INSERT INTO sap_deliveries (delivery_id, event_id, event_type, demand_id, received_at, state, result)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.deliveryId,
      record.eventId,
      record.eventType,
      record.demandId,
      record.receivedAt,
      record.state,
      record.result,
    );
}

/** Latest SAP optimistic-concurrency version observed for a demand. */
export function getSapSyncVersion(db: DatabaseSync, demandId: string): number | null {
  const row = db
    .prepare('SELECT sap_version FROM sap_sync_state WHERE demand_id = ?')
    .get(demandId) as { sap_version: number } | undefined;
  return row === undefined ? null : asNumber(row.sap_version);
}

export function upsertSapSyncVersion(
  db: DatabaseSync,
  demandId: string,
  sapVersion: number,
  at: string,
): void {
  db.prepare(
    `INSERT INTO sap_sync_state (demand_id, sap_version, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(demand_id) DO UPDATE SET sap_version = excluded.sap_version, updated_at = excluded.updated_at`,
  ).run(demandId, sapVersion, at);
}

// -- demand creation from a SAP webhook (SAP is the record system, docs/004 §1) --

export interface SapDemandCreationResult {
  demand: Demand;
  stages: StageRun[];
  /** `false` when the demand already existed (duplicate/retried delivery). */
  created: boolean;
}

/**
 * Create a control-plane demand from a SAP `demand.submitted` event. `demandId`
 * stays the SAP UUID C32 (docs/003 §4.1) and the template is pinned at creation
 * time (docs/003 §2.7). Duplicate deliveries are resolved by the caller via
 * `sap_deliveries`; this function is still defensive when the demand exists.
 */
export function createSapDemand(
  tx: TransactionContext,
  ctx: ServerContext,
  input: SapDemandCreateInput,
): SapDemandCreationResult {
  const existing = getDemand(tx.db, input.demandId);
  if (existing !== null) {
    return {
      demand: existing,
      stages: listStageRunsForDemand(tx.db, input.demandId),
      created: false,
    };
  }
  const templateId = input.templateId ?? ctx.templates.defaultTemplateId;
  const template = ctx.templates.get(templateId);
  if (template === undefined) throw new Error(`unknown template "${templateId}"`);

  const demand: Demand = {
    id: input.demandId,
    ...(input.no === undefined ? {} : { no: input.no }),
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria,
    requester: input.requester,
    priority: input.priority,
    templateId: template.templateId,
    templateVersion: template.version,
    status: 'submitted',
    workspaceBinding: input.workspaceBinding,
    source: 'sap',
    createdAt: tx.now,
    updatedAt: tx.now,
  };
  insertDemand(tx.db, demand);
  tx.append({
    type: 'demand.created',
    subject: { type: 'demand', id: demand.id },
    data: {
      demandId: demand.id,
      title: demand.title,
      priority: demand.priority,
      templateId: demand.templateId,
      templateVersion: demand.templateVersion,
      requester: demand.requester.userId,
      source: 'sap',
      ...(demand.no === undefined ? {} : { no: demand.no }),
    },
    demandId: demand.id,
  });

  const stages: StageRun[] = template.stages.map((stageTemplate) => ({
    id: newUlid(),
    demandId: demand.id,
    stageKey: stageTemplate.key,
    status: stageTemplate.inputArtifactKinds.length === 0 ? 'ready' : 'pending',
    attempt: 1,
    executorKind: stageTemplate.executorKind,
    gateKey: stageTemplate.gate === 'none' ? null : stageTemplate.gate.gateKey,
    inputRefs: [],
    outputArtifactId: null,
    startedAt: null,
    finishedAt: null,
    createdAt: tx.now,
    updatedAt: tx.now,
  }));
  for (const [stageIndex, stageRun] of stages.entries()) {
    insertStageRun(tx.db, stageRun, stageIndex);
  }
  for (const stageRun of stages) {
    if (stageRun.status !== 'ready') continue;
    tx.append({
      type: 'stage.ready',
      subject: { type: 'stage_run', id: stageRun.id },
      data: {
        stageRunId: stageRun.id,
        demandId: demand.id,
        stageKey: stageRun.stageKey,
        executorKind: stageRun.executorKind,
        source: 'sap',
      },
      demandId: demand.id,
    });
  }
  return { demand, stages, created: true };
}

export interface SapGateArtifact {
  artifact: Artifact;
  version: ArtifactVersion;
}

/** Latest artifact of a stage (for gate approval / writeback metadata). */
export function findStageArtifact(
  db: DatabaseSync,
  demandId: string,
  stageKey: string,
  artifactId?: string,
): SapGateArtifact | null {
  if (artifactId !== undefined) {
    const artifact = getArtifact(db, artifactId);
    if (artifact !== null && artifact.demandId === demandId) {
      const version = getArtifactVersion(db, artifact.id, artifact.currentVersion);
      if (version !== null) return { artifact, version };
    }
  }
  const artifacts = listArtifactsForDemand(db, demandId).filter(
    (artifact) => artifact.stageKey === stageKey,
  );
  const artifact = artifacts.at(-1);
  if (artifact === undefined) return null;
  const version = getArtifactVersion(db, artifact.id, artifact.currentVersion);
  return version === null ? null : { artifact, version };
}

// -- writeback outbox + worker cursor ---------------------------------------

export interface SapOutboxRow {
  id: string;
  eventSeq: number;
  payload: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

interface OutboxRow {
  id: string;
  event_seq: number;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

export function insertSapOutboxRow(
  db: DatabaseSync,
  row: { id: string; eventSeq: number; payload: string; nextAttemptAt: string; now: string },
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO outbox (id, event_seq, target, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'sap.writeback', ?, 'PENDING', 0, ?, ?, ?)`,
    )
    .run(row.id, row.eventSeq, row.payload, row.nextAttemptAt, row.now, row.now);
  return Number(result.changes) > 0;
}

export function listDueSapOutbox(db: DatabaseSync, nowIso: string, limit: number): SapOutboxRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM outbox WHERE target = 'sap.writeback' AND status = 'PENDING'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(nowIso, limit) as unknown as OutboxRow[];
  return rows.map((row) => ({
    id: asString(row.id),
    eventSeq: asNumber(row.event_seq),
    payload: asString(row.payload),
    status: asString(row.status),
    attempts: asNumber(row.attempts),
    nextAttemptAt: asNullableString(row.next_attempt_at),
    lastError: asNullableString(row.last_error),
  }));
}

export function markSapOutboxSent(db: DatabaseSync, id: string, at: string): void {
  db.prepare(
    `UPDATE outbox SET status = 'SENT', sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
  ).run(at, at, id);
}

export function markSapOutboxRetry(
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

export function markSapOutboxDead(
  db: DatabaseSync,
  id: string,
  attempts: number,
  error: string,
  at: string,
): void {
  db.prepare(
    `UPDATE outbox SET status = 'DEAD', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(attempts, error, at, id);
}

export function countSapOutbox(db: DatabaseSync): {
  pending: number;
  sent: number;
  dead: number;
  lastError: string | null;
} {
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS total FROM outbox WHERE target = 'sap.writeback' GROUP BY status`,
    )
    .all() as unknown as Array<{ status: string; total: number }>;
  const byStatus = new Map(counts.map((row) => [row.status, asNumber(row.total)]));
  const lastErrorRow = db
    .prepare(
      `SELECT last_error FROM outbox WHERE target = 'sap.writeback' AND last_error IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get() as { last_error: string } | undefined;
  return {
    pending: byStatus.get('PENDING') ?? 0,
    sent: byStatus.get('SENT') ?? 0,
    dead: byStatus.get('DEAD') ?? 0,
    lastError: lastErrorRow === undefined ? null : asString(lastErrorRow.last_error),
  };
}

/** Worker scan cursor stored in the SAP integration state table. */
export function getWritebackCursor(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT value FROM sap_integration_state WHERE key = 'writeback.cursor'`)
    .get() as { value: string } | undefined;
  return row === undefined ? 0 : Number.parseInt(asString(row.value), 10) || 0;
}

export function setWritebackCursor(db: DatabaseSync, cursor: number, at: string): void {
  db.prepare(
    `INSERT INTO sap_integration_state (key, value, updated_at) VALUES ('writeback.cursor', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(String(cursor), at);
}

export function maxEventSeq(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(seq) AS maxSeq FROM events').get() as
    | { maxSeq: number | null }
    | undefined;
  return row?.maxSeq === null || row?.maxSeq === undefined ? 0 : asNumber(row.maxSeq);
}

export interface SapEventRow {
  seq: number;
  id: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
  demandId: string | null;
}

/** Events after the writeback cursor, filtered to the SAP-relevant types. */
export function listEventsForWriteback(
  db: DatabaseSync,
  cursor: number,
  types: readonly string[],
  limit: number,
): SapEventRow[] {
  const placeholders = types.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT seq, id, type, at, data, demand_id FROM events
       WHERE seq > ? AND type IN (${placeholders}) ORDER BY seq ASC LIMIT ?`,
    )
    .all(cursor, ...types, limit) as unknown as Array<{
    seq: number;
    id: string;
    type: string;
    at: string;
    data: string;
    demand_id: string | null;
  }>;
  return rows.map((row) => ({
    seq: asNumber(row.seq),
    id: asString(row.id),
    type: asString(row.type),
    at: asString(row.at),
    data: decodeJson<Record<string, unknown>>(row.data),
    demandId: asNullableString(row.demand_id),
  }));
}

/** Serialized artifact metadata for the docs/008 §3 SAP writeback payload. */
export function listArtifactMetadata(db: DatabaseSync, demandId: string, stageKey?: string): Array<{
  artifactId: string;
  stageKey: string | null;
  stageRunId: string | null;
  kind: string;
  version: number;
  checksum: string;
  contentRef: string;
  contentType: string;
  status: string;
}> {
  const artifacts = listArtifactsForDemand(db, demandId);
  const versions = listArtifactVersionsForDemand(db, demandId);
  const latest = new Map<string, ArtifactVersion>();
  for (const version of versions) latest.set(version.artifactId, version);
  return artifacts
    .filter((artifact) => stageKey === undefined || artifact.stageKey === stageKey)
    .map((artifact) => {
      const version = latest.get(artifact.id);
      return {
        artifactId: artifact.id,
        stageKey: artifact.stageKey,
        stageRunId: artifact.stageRunId,
        kind: artifact.kind,
        version: artifact.currentVersion,
        checksum: version?.checksum ?? '',
        contentRef: version?.contentRef ?? '',
        contentType: version?.contentType ?? 'application/json',
        status: artifact.state,
      };
    });
}

/** Raw JSON payload helper (outbox payload column). */
export function encodeOutboxPayload(payload: Record<string, unknown>): string {
  return encodeJson(payload);
}
