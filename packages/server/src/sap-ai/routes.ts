import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  newUlid,
  sapAiJobClaimBodySchema,
  sapAiJobClaimResponseSchema,
  sapAiJobHeartbeatBodySchema,
  sapAiJobHeartbeatResponseSchema,
  sapAiJobRequeueBodySchema,
  sapAiJobRequeueResponseSchema,
  sapAiJobResultBodySchema,
  sapAiJobResultResponseSchema,
  sapAiJobsNextBodySchema,
  sapAiJobsResponseSchema,
  type SapAiJob,
  type SapAiJobResultResponse,
  type SapAiJobUsage,
  type StageRun,
} from '@sap-superagent/protocol';
import { StageOutputError, parseStageOutput } from '@sap-superagent/ai';
import { verifySapHookSignature, type SapHookHeaders } from '@sap-superagent/sap-adapter';
import {
  getSapAiJob,
  listQueuedSapAiJobs,
  updateSapAiJob,
} from '../db/sap-ai-jobs.js';
import { getStageRun } from '../db/stages.js';
import { writeTransaction } from '../db/transaction.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { requireAdmin } from '../http/auth.js';
import { nowIso, paramId, publish } from '../http/route-utils.js';
import { parseInput, sendValidated } from '../http/validate.js';
import { completeServerAiStage } from '../stage-engine.js';
import {
  appendSapAiJobEvent,
  buildSapAiJobResultSummary,
  cancelSapAiJob,
  driveSapAiJobStageFailure,
  resolveSapAiJobStage,
  truncateSapAiJobError,
  type SapAiJobFailureReason,
} from './jobs.js';
import type { ServerContext } from '../types.js';

// ---------------------------------------------------------------------------
// S5: SAP → control-plane batch AI job API (docs/003 §4.8.4).
//
// Every endpoint below is a POST authenticated with the shared SAP webhook
// HMAC (`X-SA-Signature/Timestamp/Delivery`, ±`toleranceMs`), never a Bearer
// token: SAP batch jobs have no user identity. The raw body is captured with a
// scoped `application/json` parser so the signature covers the exact bytes SAP
// signed, then the JSON is validated against the frozen protocol schema.
//
// All state changes run inside `writeTransaction` and append the §4.8.5 events.
// The admin requeue endpoint uses an admin Bearer token instead and is
// registered separately (docs/003 §4.8.4 last table row).
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renewIntervalMs(ctx: ServerContext): number {
  return Math.max(1_000, Math.floor(ctx.config.sapAi.leaseTtlMs / 2));
}

function leaseExpiryFromNow(ctx: ServerContext): string {
  return new Date(ctx.clock() + ctx.config.sapAi.leaseTtlMs).toISOString();
}

/** Parse an HMAC-verified raw body as a JSON object (empty body = `{}`). */
function parseRawJson(rawBody: string, label: string): unknown {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw badRequest(`${label} is not valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verify the `X-SA-*` signature over the exact request body and return it.
 * A failure is a 401 (docs/003 §4.8.4), never a 400.
 */
function verifySapAiRequest(ctx: ServerContext, request: FastifyRequest): string {
  const secret = ctx.config.sapAi.hookSecret;
  if (secret === null) throw unauthorized('SAP batch AI job API is not configured');
  const rawBody = typeof request.body === 'string' ? request.body : '';
  const verification = verifySapHookSignature({
    secret,
    body: rawBody,
    headers: request.headers as SapHookHeaders,
    now: ctx.clock(),
    toleranceMs: ctx.config.sapAi.toleranceMs,
  });
  if (!verification.ok) {
    throw unauthorized(
      `SAP AI job request rejected (${verification.code}): ${verification.message}`,
    );
  }
  return rawBody;
}

/** Ledger for a SAP-reported failure (gateway usage may still be present). */
function sapResultLedger(
  job: SapAiJob,
  stageRun: StageRun | null,
  usage: SapAiJobUsage | null,
  durationMs: number,
): {
  model: string | null;
  promptVersion: string | null;
  tokens: number;
  costUsd: number;
  durationMs: number;
  startedAt: string;
} {
  return {
    model: job.payload.model,
    promptVersion: job.payload.promptVersion,
    tokens: usage?.totalTokens ?? 0,
    // The enterprise gateway bills; the control plane never fabricates cost.
    costUsd: 0,
    durationMs,
    startedAt: stageRun?.startedAt ?? job.createdAt,
  };
}

interface ResultOutcome {
  job: SapAiJob;
  accepted: boolean;
  duplicate: boolean;
  stageStatus: StageRun['status'];
}

/**
 * Register the SAP job API. Only called when `ctx.config.sapAi.enabled`; the
 * scoped content-type parser makes Fastify hand us the raw body as a string.
 */
export function registerSapAiJobRoutes(app: FastifyInstance, ctx: ServerContext): void {
  if (!ctx.config.sapAi.enabled) return;

  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    // --- POST /api/v1/sap/ai-jobs/next (read-only) -------------------------
    scope.post('/api/v1/sap/ai-jobs/next', async (request, reply) => {
      const rawBody = verifySapAiRequest(ctx, request);
      const value = parseRawJson(rawBody, 'sap ai jobs next body');
      parseInput(sapAiJobsNextBodySchema, value, 'sap ai jobs next body');
      const requested =
        isRecord(value) && typeof value['limit'] === 'number'
          ? Math.min(value['limit'], ctx.config.sapAi.batchSize)
          : ctx.config.sapAi.batchSize;
      const jobs = listQueuedSapAiJobs(ctx.db, requested);
      return sendValidated(reply, sapAiJobsResponseSchema, {
        jobs,
        serverTime: nowIso(ctx),
      });
    });

    // --- POST /api/v1/sap/ai-jobs/{id}/claim -------------------------------
    scope.post('/api/v1/sap/ai-jobs/:id/claim', async (request, reply) => {
      const rawBody = verifySapAiRequest(ctx, request);
      parseInput(
        sapAiJobClaimBodySchema,
        parseRawJson(rawBody, 'sap ai job claim body'),
        'sap ai job claim body',
      );
      const id = paramId(request);
      const claimId = newUlid();
      const leaseExpiresAt = leaseExpiryFromNow(ctx);
      const job = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const fresh = getSapAiJob(ctx.db, id);
        if (fresh === null) throw notFound(`sap ai job ${id} not found`);
        if (fresh.state !== 'queued') {
          throw conflict(`sap ai job ${id} is ${fresh.state}, not claimable`, {
            reason: 'job_not_queued',
            state: fresh.state,
          });
        }
        const claimedJob: SapAiJob = {
          ...fresh,
          state: 'claimed',
          claimId,
          leaseExpiresAt,
          updatedAt: tx.now,
        };
        updateSapAiJob(ctx.db, claimedJob);
        appendSapAiJobEvent(tx, claimedJob, 'stage.ai_job.claimed', {
          claimId,
          leaseExpiresAt,
        });
        return claimedJob;
      });
      return sendValidated(reply, sapAiJobClaimResponseSchema, {
        job,
        claimId,
        lease: { expiresAt: leaseExpiresAt, renewIntervalMs: renewIntervalMs(ctx) },
        serverTime: nowIso(ctx),
      });
    });

    // --- POST /api/v1/sap/ai-jobs/{id}/heartbeat ---------------------------
    scope.post('/api/v1/sap/ai-jobs/:id/heartbeat', async (request, reply) => {
      const rawBody = verifySapAiRequest(ctx, request);
      const body = parseInput(
        sapAiJobHeartbeatBodySchema,
        parseRawJson(rawBody, 'sap ai job heartbeat body'),
        'sap ai job heartbeat body',
      );
      const id = paramId(request);
      const leaseExpiresAt = leaseExpiryFromNow(ctx);
      const job = writeTransaction(ctx.db, publish(ctx), (tx) => {
        const fresh = getSapAiJob(ctx.db, id);
        if (fresh === null) throw notFound(`sap ai job ${id} not found`);
        if (fresh.state !== 'claimed') {
          throw conflict(`sap ai job ${id} is ${fresh.state}, not claimed`, {
            reason: 'job_not_claimed',
            state: fresh.state,
          });
        }
        if (fresh.claimId === null || fresh.claimId !== body.claimId) {
          throw conflict(`claimId does not match the active claim of sap ai job ${id}`, {
            reason: 'claim_id_mismatch',
          });
        }
        if (fresh.leaseExpiresAt === null || fresh.leaseExpiresAt <= tx.now) {
          throw conflict(`lease for sap ai job ${id} has expired`, { reason: 'lease_expired' });
        }
        const renewed: SapAiJob = { ...fresh, leaseExpiresAt, updatedAt: tx.now };
        updateSapAiJob(ctx.db, renewed);
        return renewed;
      });
      return sendValidated(reply, sapAiJobHeartbeatResponseSchema, {
        jobId: job.id,
        claimId: body.claimId,
        lease: { expiresAt: leaseExpiresAt, renewIntervalMs: renewIntervalMs(ctx) },
        serverTime: nowIso(ctx),
      });
    });

    // --- POST /api/v1/sap/ai-jobs/{id}/result ------------------------------
    scope.post('/api/v1/sap/ai-jobs/:id/result', async (request, reply) => {
      const rawBody = verifySapAiRequest(ctx, request);
      const body = parseInput(
        sapAiJobResultBodySchema,
        parseRawJson(rawBody, 'sap ai job result body'),
        'sap ai job result body',
      );
      const id = paramId(request);
      const now = nowIso(ctx);
      const usage: SapAiJobUsage | null = body.usage ?? null;

      const outcome = writeTransaction(ctx.db, publish(ctx), (tx): ResultOutcome => {
        const job = getSapAiJob(ctx.db, id);
        if (job === null) throw notFound(`sap ai job ${id} not found`);
        const stageRun = getStageRun(ctx.db, job.stageRunId);
        if (stageRun === null) throw notFound(`stage run ${job.stageRunId} not found`);
        // Terminal job: idempotent duplicate (no event/artifact/ledger writes).
        if (job.state !== 'queued' && job.state !== 'claimed') {
          return { job, accepted: false, duplicate: true, stageStatus: stageRun.status };
        }
        if (job.state === 'queued') {
          throw conflict(`sap ai job ${id} is queued, claim it before posting a result`, {
            reason: 'job_not_claimed',
            state: job.state,
          });
        }
        if (job.claimId === null || job.claimId !== body.claimId) {
          throw conflict(`claimId does not match the active claim of sap ai job ${id}`, {
            reason: 'claim_id_mismatch',
          });
        }
        // The stage may have been cancelled/advanced while the job ran: cancel
        // the job and tell SAP to stop retrying (§4.8.2/§4.8.4).
        if (stageRun.status !== 'running' || stageRun.attempt !== job.attempt) {
          const cancelled = cancelSapAiJob(tx, ctx, job, {
            error:
              `stage is ${stageRun.status} at attempt ${stageRun.attempt}` +
              ` (job attempt ${job.attempt})`,
            stageStatus: stageRun.status,
          });
          return { job: cancelled, accepted: false, duplicate: false, stageStatus: stageRun.status };
        }
        const resolved = resolveSapAiJobStage(ctx, job);
        if (resolved === null) {
          const cancelled = cancelSapAiJob(tx, ctx, job, {
            error: 'stage context is unavailable (template or AI stage definition missing)',
            stageStatus: stageRun.status,
          });
          return { job: cancelled, accepted: false, duplicate: false, stageStatus: stageRun.status };
        }
        const durationMs = body.durationMs ?? Math.max(0, Date.parse(tx.now) - Date.parse(job.createdAt));
        const ledger = sapResultLedger(job, stageRun, usage, durationMs);

        const failJob = (
          reason: SapAiJobFailureReason,
          message: string,
          stageStatus: StageRun['status'],
        ): ResultOutcome => {
          const updated: SapAiJob = {
            ...job,
            state: 'failed',
            leaseExpiresAt: null,
            lastError: truncateSapAiJobError(message),
            result: buildSapAiJobResultSummary({
              status: 'failed',
              error: message,
              usage,
              durationMs,
              completedAt: tx.now,
            }),
            updatedAt: tx.now,
          };
          updateSapAiJob(ctx.db, updated);
          appendSapAiJobEvent(tx, updated, 'stage.ai_job.failed', {
            reason,
            error: truncateSapAiJobError(message),
            willRetry: stageStatus === 'ready',
            stageStatus,
          });
          return { job: updated, accepted: true, duplicate: false, stageStatus };
        };

        if (body.status === 'failed') {
          const message = `SAP gateway reported failure: ${body.error.message}`;
          const failure = driveSapAiJobStageFailure(tx, ctx, job, {
            reason: 'sap_failed',
            error: message,
            ledger,
          });
          return failJob(
            'sap_failed',
            message,
            failure.stageStatus ?? stageRun.status,
          );
        }

        let output: unknown;
        try {
          output = parseStageOutput(
            resolved.definition.outputSchema,
            body.outputText,
            resolved.definition.name,
          );
        } catch (error) {
          const message =
            error instanceof StageOutputError
              ? error.message
              : `stage output could not be parsed: ${errorMessage(error)}`;
          const failure = driveSapAiJobStageFailure(tx, ctx, job, {
            reason: 'invalid_output',
            error: message,
            ledger,
          });
          return failJob('invalid_output', message, failure.stageStatus ?? stageRun.status);
        }

        const completion = completeServerAiStage(tx, ctx, {
          demand: resolved.demand,
          template: resolved.template,
          stageTemplate: resolved.stageTemplate,
          stageRun,
          output,
          ledger,
        });
        if (!completion.ok) {
          const message = `checklist: ${completion.failures.join('; ')}`;
          return failJob(
            'checklist_failed',
            message,
            completion.status ?? stageRun.status,
          );
        }
        const stageStatus = completion.status ?? stageRun.status;
        const succeeded: SapAiJob = {
          ...job,
          state: 'succeeded',
          leaseExpiresAt: null,
          lastError: null,
          result: buildSapAiJobResultSummary({
            status: 'succeeded',
            error: null,
            usage,
            durationMs,
            completedAt: tx.now,
          }),
          updatedAt: tx.now,
        };
        updateSapAiJob(ctx.db, succeeded);
        appendSapAiJobEvent(tx, succeeded, 'stage.ai_job.completed', {
          artifactId: completion.artifactId,
          artifactVersion: completion.artifactVersion,
          stageStatus,
          tokens: ledger.tokens,
          durationMs,
        });
        return { job: succeeded, accepted: true, duplicate: false, stageStatus };
      });

      const response: SapAiJobResultResponse = {
        job: outcome.job,
        accepted: outcome.accepted,
        duplicate: outcome.duplicate,
        stageRunId: outcome.job.stageRunId,
        stageStatus: outcome.stageStatus,
        serverTime: now,
      };
      return sendValidated(reply, sapAiJobResultResponseSchema, response);
    });
  });
}

/** Register the admin-only operational requeue endpoint (docs/003 §4.8.4). */
export function registerSapAiAdminRoutes(app: FastifyInstance, ctx: ServerContext): void {
  if (!ctx.config.sapAi.enabled) return;

  app.post('/api/v1/admin/sap/ai-jobs/:id/requeue', async (request: FastifyRequest, reply: FastifyReply) => {
    requireAdmin(ctx, request);
    const id = paramId(request);
    const rawBody: unknown = request.body === undefined || request.body === null ? {} : request.body;
    const body = parseInput(sapAiJobRequeueBodySchema, rawBody, 'sap ai job requeue body');

    const outcome = writeTransaction(ctx.db, publish(ctx), (tx) => {
      const job = getSapAiJob(ctx.db, id);
      if (job === null) throw notFound(`sap ai job ${id} not found`);
      if (job.state === 'queued') return { job, requeued: false };
      if (job.state === 'claimed') {
        throw conflict(`sap ai job ${id} is claimed; wait for its lease or result`, {
          reason: 'job_claimed',
          state: job.state,
        });
      }
      const stageRun = getStageRun(ctx.db, job.stageRunId);
      if (stageRun === null || stageRun.status !== 'running' || stageRun.attempt !== job.attempt) {
        throw conflict(
          `stage ${job.stageKey} is ${stageRun?.status ?? 'missing'};` +
            ` only a running stage at attempt ${job.attempt} can be requeued`,
          { reason: 'stage_not_running', stageStatus: stageRun?.status ?? null },
        );
      }
      const requeued: SapAiJob = {
        ...job,
        state: 'queued',
        claimId: null,
        leaseExpiresAt: null,
        updatedAt: tx.now,
      };
      updateSapAiJob(ctx.db, requeued);
      appendSapAiJobEvent(tx, requeued, 'stage.ai_job.queued', { reason: 'requeued' });
      if (body.reason !== undefined && ctx.config.logger) {
        console.error(`[sap-ai] requeued job ${requeued.id}: ${body.reason}`);
      }
      return { job: requeued, requeued: true };
    });

    return sendValidated(reply, sapAiJobRequeueResponseSchema, {
      job: outcome.job,
      requeued: outcome.requeued,
      serverTime: nowIso(ctx),
    });
  });
}
