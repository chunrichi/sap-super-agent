import type {
  Demand,
  SapAiJob,
  SapAiJobResultStatus,
  SapAiJobResultSummary,
  SapAiJobUsage,
  StageRun,
  StageTemplate,
  StageTemplateFile,
} from '@sap-superagent/protocol';
import { SAP_AI_JOB_ERROR_MAX_CHARS } from '@sap-superagent/protocol';
import { resolveAiStageDefinition, type AiStageDefinition } from '@sap-superagent/ai';
import { findStage } from '@sap-superagent/core';
import { getDemand } from '../db/demands.js';
import { updateSapAiJob } from '../db/sap-ai-jobs.js';
import { getStageRun } from '../db/stages.js';
import type { TransactionContext } from '../db/transaction.js';
import { failStageAttempt, type ServerAiStageLedger } from '../stage-engine.js';
import type { ServerContext } from '../types.js';

// ---------------------------------------------------------------------------
// S5: shared SAP-batch AI job helpers (docs/003 §4.8.5/§4.8.6).
//
// The stage runner (dispatch/recovery/sweeper) and the SAP → control-plane Job
// API share these helpers so the `stage.ai_job.*` event shape, the stage-failure
// semantics and the job result summary are defined exactly once.
// ---------------------------------------------------------------------------

/** `stage.ai_job.queued.reason` (docs/003 §4.8.5). */
export type SapAiJobQueuedReason = 'dispatch' | 'retry' | 'lease_expired' | 'recovered' | 'requeued';
/** `stage.ai_job.failed.reason` (docs/003 §4.8.5). */
export type SapAiJobFailureReason =
  | 'sap_failed'
  | 'invalid_output'
  | 'checklist_failed'
  | 'max_age_exceeded'
  | 'lease_expired'
  | 'stage_cancelled';

export type SapAiJobEventType =
  | 'stage.ai_job.queued'
  | 'stage.ai_job.claimed'
  | 'stage.ai_job.completed'
  | 'stage.ai_job.failed';

export function truncateSapAiJobError(value: string): string {
  return value.length <= SAP_AI_JOB_ERROR_MAX_CHARS ? value : value.slice(0, SAP_AI_JOB_ERROR_MAX_CHARS);
}

/** Append one persistent `stage.ai_job.*` event with the §4.8.5 data shape. */
export function appendSapAiJobEvent(
  tx: TransactionContext,
  job: SapAiJob,
  type: SapAiJobEventType,
  data: Record<string, unknown>,
): void {
  tx.append({
    type,
    subject: { type: 'stage_run', id: job.stageRunId },
    data: {
      jobId: job.id,
      stageRunId: job.stageRunId,
      demandId: job.demandId,
      stageKey: job.stageKey,
      attempt: job.attempt,
      ...data,
    },
    demandId: job.demandId,
  });
}

export interface SapAiJobStageContext {
  demand: Demand;
  template: StageTemplateFile;
  stageTemplate: StageTemplate;
  stageRun: StageRun;
  definition: AiStageDefinition;
}

/** Resolve everything needed to drive the stage behind one job. */
export function resolveSapAiJobStage(
  ctx: ServerContext,
  job: SapAiJob,
): SapAiJobStageContext | null {
  const stageRun = getStageRun(ctx.db, job.stageRunId);
  if (stageRun === null) return null;
  const demand = getDemand(ctx.db, stageRun.demandId);
  if (demand === null) return null;
  const template = ctx.templates.getForDemand(demand);
  if (template === undefined) return null;
  const stageTemplate = findStage(template, stageRun.stageKey);
  if (stageTemplate === undefined) return null;
  const definition = resolveAiStageDefinition(
    stageTemplate.key,
    stageTemplate.outputArtifactKind,
  );
  if (definition === undefined) return null;
  return { demand, template, stageTemplate, stageRun, definition };
}

export interface SapAiJobFailureOutcome {
  /** Stage status after `failStageAttempt` (`null` when it could not run). */
  stageStatus: StageRun['status'] | null;
  /** `true` when the stage went back to `ready` (a retry is pending). */
  willRetry: boolean;
}

/**
 * Fail the stage attempt backing a job: retry with attempt+1 while attempts
 * remain, otherwise park for a human (docs/003 §4.8.6). Does nothing when the
 * stage is no longer the same `running` attempt — the job is then cancelled by
 * the caller instead of failing a stage that already moved on.
 */
export function driveSapAiJobStageFailure(
  tx: TransactionContext,
  ctx: ServerContext,
  job: SapAiJob,
  params: {
    reason: string;
    error: string;
    ledger: ServerAiStageLedger;
    allowRetry?: boolean;
  },
): SapAiJobFailureOutcome {
  const resolved = resolveSapAiJobStage(ctx, job);
  if (resolved === null) return { stageStatus: null, willRetry: false };
  if (resolved.stageRun.status !== 'running' || resolved.stageRun.attempt !== job.attempt) {
    return { stageStatus: resolved.stageRun.status, willRetry: false };
  }
  const stageStatus = failStageAttempt(tx, ctx, {
    demand: resolved.demand,
    template: resolved.template,
    stageRun: resolved.stageRun,
    stageTemplate: resolved.stageTemplate,
    reason: params.reason,
    error: params.error,
    ...(params.allowRetry === undefined ? {} : { allowRetry: params.allowRetry }),
    ledger: {
      model: params.ledger.model,
      promptVersion: params.ledger.promptVersion,
      schemaOk: false,
      tokens: params.ledger.tokens,
      costUsd: params.ledger.costUsd,
      durationMs: params.ledger.durationMs,
      startedAt: params.ledger.startedAt,
    },
  });
  return { stageStatus, willRetry: stageStatus === 'ready' };
}

/** Build the persisted result summary (never the output body, §4.8.3). */
export function buildSapAiJobResultSummary(input: {
  status: SapAiJobResultStatus;
  error: string | null;
  usage: SapAiJobUsage | null;
  durationMs: number | null;
  completedAt: string;
}): SapAiJobResultSummary {
  return {
    status: input.status,
    error: input.error === null ? null : truncateSapAiJobError(input.error),
    usage: input.usage,
    durationMs: input.durationMs,
    completedAt: input.completedAt,
  };
}

/**
 * Terminal-ise a job as `cancelled` because its stage attempt is gone (stage
 * cancelled/advanced/finished). Writes the `stage.ai_job.failed` audit event
 * with `reason=stage_cancelled` (docs/003 §4.8.5) and never touches the stage.
 */
export function cancelSapAiJob(
  tx: TransactionContext,
  ctx: ServerContext,
  job: SapAiJob,
  params: { error: string; stageStatus: StageRun['status'] | null },
): SapAiJob {
  const error = truncateSapAiJobError(params.error);
  const updated: SapAiJob = {
    ...job,
    state: 'cancelled',
    leaseExpiresAt: null,
    lastError: error,
    result: buildSapAiJobResultSummary({
      status: 'failed',
      error,
      usage: null,
      durationMs: null,
      completedAt: tx.now,
    }),
    updatedAt: tx.now,
  };
  updateSapAiJob(ctx.db, updated);
  appendSapAiJobEvent(tx, updated, 'stage.ai_job.failed', {
    reason: 'stage_cancelled',
    error,
    willRetry: false,
    stageStatus: params.stageStatus,
  });
  return updated;
}
