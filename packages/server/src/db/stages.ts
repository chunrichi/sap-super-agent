import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactRef, StageAttempt, StageRun } from '@sap-superagent/protocol';
import { asNullableString, asNumber, asString, decodeJson, encodeJson } from './rows.js';

interface StageRunRow {
  id: string;
  demand_id: string;
  stage_key: string;
  status: string;
  attempt: number;
  executor_kind: string;
  gate_key: string | null;
  input_refs: string;
  output_artifact_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToStageRun(row: StageRunRow): StageRun {
  return {
    id: asString(row.id),
    demandId: asString(row.demand_id),
    stageKey: asString(row.stage_key),
    status: asString(row.status) as StageRun['status'],
    attempt: asNumber(row.attempt),
    executorKind: asString(row.executor_kind) as StageRun['executorKind'],
    gateKey: asNullableString(row.gate_key),
    inputRefs: decodeJson<ArtifactRef[]>(row.input_refs),
    outputArtifactId: asNullableString(row.output_artifact_id),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function insertStageRun(
  db: DatabaseSync,
  stageRun: StageRun,
  stageIndex: number,
): void {
  db.prepare(
    `INSERT INTO stage_runs (
      id, demand_id, stage_key, stage_index, status, attempt, executor_kind, gate_key,
      input_refs, output_artifact_id, started_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stageRun.id,
    stageRun.demandId,
    stageRun.stageKey,
    stageIndex,
    stageRun.status,
    stageRun.attempt,
    stageRun.executorKind,
    stageRun.gateKey,
    encodeJson(stageRun.inputRefs),
    stageRun.outputArtifactId,
    stageRun.startedAt,
    stageRun.finishedAt,
    stageRun.createdAt,
    stageRun.updatedAt,
  );
}

export function updateStageRun(db: DatabaseSync, stageRun: StageRun): void {
  db.prepare(
    `UPDATE stage_runs SET status = ?, attempt = ?, gate_key = ?, input_refs = ?,
      output_artifact_id = ?, started_at = ?, finished_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    stageRun.status,
    stageRun.attempt,
    stageRun.gateKey,
    encodeJson(stageRun.inputRefs),
    stageRun.outputArtifactId,
    stageRun.startedAt,
    stageRun.finishedAt,
    stageRun.updatedAt,
    stageRun.id,
  );
}

export function getStageRun(db: DatabaseSync, id: string): StageRun | null {
  const row = db.prepare('SELECT * FROM stage_runs WHERE id = ?').get(id) as unknown as
    | StageRunRow
    | undefined;
  return row === undefined ? null : rowToStageRun(row);
}

export function getStageRunByKey(
  db: DatabaseSync,
  demandId: string,
  stageKey: string,
): StageRun | null {
  const row = db
    .prepare('SELECT * FROM stage_runs WHERE demand_id = ? AND stage_key = ?')
    .get(demandId, stageKey) as unknown as StageRunRow | undefined;
  return row === undefined ? null : rowToStageRun(row);
}

export function listStageRunsForDemand(db: DatabaseSync, demandId: string): StageRun[] {
  const rows = db
    .prepare('SELECT * FROM stage_runs WHERE demand_id = ? ORDER BY stage_index ASC, created_at ASC')
    .all(demandId) as unknown as StageRunRow[];
  return rows.map(rowToStageRun);
}

export function selectReadyServerAiStageRuns(db: DatabaseSync, limit: number): StageRun[] {
  const rows = db
    .prepare(
      `SELECT * FROM stage_runs
       WHERE status = 'ready' AND executor_kind = 'server-ai'
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as unknown as StageRunRow[];
  return rows.map(rowToStageRun);
}

export function recoverRunningServerAiStages(db: DatabaseSync): number {
  const result = db
    .prepare(
      `UPDATE stage_runs SET status = 'ready', started_at = NULL, finished_at = NULL
       WHERE status = 'running' AND executor_kind = 'server-ai'`,
    )
    .run();
  return Number(result.changes);
}

export function insertStageAttempt(db: DatabaseSync, attempt: StageAttempt): void {
  db.prepare(
    `INSERT INTO stage_attempts (
      stage_run_id, attempt, model, prompt_version, input_refs, schema_ok, tokens, cost_usd,
      duration_ms, error, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attempt.stageRunId,
    attempt.attempt,
    attempt.model,
    attempt.promptVersion,
    encodeJson(attempt.inputRefs),
    attempt.schemaOk ? 1 : 0,
    attempt.tokens,
    attempt.costUsd,
    attempt.durationMs,
    attempt.error,
    attempt.startedAt,
    attempt.finishedAt,
  );
}
