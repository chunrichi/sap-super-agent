import { z } from 'zod';
import { sapAiJobStateSchema, sapAiJobResultStatusSchema, stageRunStatusSchema } from './enums.js';
import { isoDateTimeSchema } from './entities.js';
import { demandIdSchema, ulidSchema } from './ids.js';

// ---------------------------------------------------------------------------
// S5: SAP-batch AI executor contract (docs/003 §4.8, handoffs/S5 §1.1/§1.2).
//
// In M3 the control plane stops calling a model provider for delegated
// `server-ai` stages: it renders the prompt, enqueues a job here, and a SAP
// batch program (`ZCL_ZSA_AI_BATCH`) picks it up, calls the enterprise AI
// gateway and posts the raw model output back. All JSON extraction, output
// schema validation, checklist evaluation, ledger and gate/advance semantics
// stay on the control plane — SAP never validates business output.
//
// Security: every SAP -> control-plane call is a POST authenticated with the
// shared `X-SA-Signature/Timestamp/Delivery` HMAC headers (reusing the SAP
// webhook secret; docs/003 §4.1), never a Bearer token.
// ---------------------------------------------------------------------------

/** Defaults from the S5 task book §1.2 (handoff §4). */
export const DEFAULT_SAP_AI_JOB_LEASE_MS = 10 * 60 * 1_000;
export const DEFAULT_SAP_AI_JOB_MAX_AGE_MS = 30 * 60 * 1_000;
export const DEFAULT_SAP_AI_JOB_BATCH_SIZE = 5;
/**
 * Gateway call timeout hint carried in the payload (SAP `AI_TIMEOUT_MS` may
 * lower it, but the control plane never waits longer than the lease/max age).
 */
export const DEFAULT_SAP_AI_JOB_TIMEOUT_MS = 2 * 60 * 1_000;
/** Lease renewals are requested at half the lease window. */
export const SAP_AI_JOB_RENEW_FACTOR = 2;
export const MAX_SAP_AI_JOB_BATCH_SIZE = 50;
/** Second lease expiry on the same job fails the stage attempt (task book §1.2). */
export const DEFAULT_SAP_AI_JOB_MAX_LEASE_EXPIRIES = 2;
/** Keep job payloads bounded (the prompt already truncates upstream content). */
export const SAP_AI_JOB_SYSTEM_PROMPT_MAX_CHARS = 20_000;
export const SAP_AI_JOB_PROMPT_MAX_CHARS = 200_000;
export const SAP_AI_JOB_OUTPUT_MAX_CHARS = 2_000_000;
export const SAP_AI_JOB_ERROR_MAX_CHARS = 4_000;

/**
 * Dispatched job payload. The prompt is rendered by the control plane
 * (`renderAiStagePrompt`) so prompt/validation stay single-sourced; SAP only
 * transports it to the enterprise gateway. No credentials or gateway URLs are
 * ever placed here (data boundary, docs/003 §4.8).
 */
export const sapAiJobPayloadSchema = z
  .object({
    stageRunId: ulidSchema,
    demandId: demandIdSchema,
    stageKey: z.string().min(1).max(64),
    stageName: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    promptVersion: z.string().min(1).max(100),
    /** Fixed system instruction; SAP sends it as the `system` message. */
    systemPrompt: z.string().min(1).max(SAP_AI_JOB_SYSTEM_PROMPT_MAX_CHARS),
    /** Rendered stage prompt; SAP sends it as the `user` message. */
    prompt: z.string().min(1).max(SAP_AI_JOB_PROMPT_MAX_CHARS),
    /** Model the control plane pinned for this attempt (docs/005 §3.3). */
    model: z.string().min(1).max(200),
    /** Opaque reference to the control-plane output schema; SAP must not parse it. */
    outputSchema: z.string().min(1).max(100),
    /** Upper bound for one gateway call (SAP may use a shorter local timeout). */
    timeoutMs: z.number().int().positive().max(10 * 60 * 1_000),
    maxOutputTokens: z.number().int().positive().max(100_000).optional(),
  })
  .strict();
export type SapAiJobPayload = z.infer<typeof sapAiJobPayloadSchema>;

/** Usage/cost accounting reported back by SAP (gateway side does the billing). */
export const sapAiJobUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    model: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SapAiJobUsage = z.infer<typeof sapAiJobUsageSchema>;

/** Persisted job outcome summary (never the output body; docs/003 §4.8). */
export const sapAiJobResultSummarySchema = z
  .object({
    status: sapAiJobResultStatusSchema,
    error: z.string().max(SAP_AI_JOB_ERROR_MAX_CHARS).nullable(),
    usage: sapAiJobUsageSchema.nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    completedAt: isoDateTimeSchema,
  })
  .strict();
export type SapAiJobResultSummary = z.infer<typeof sapAiJobResultSummarySchema>;

/**
 * Lease/job view returned to SAP. `(stageRunId, attempt)` is unique on the
 * server: one attempt owns exactly one job, and a retry creates a new job.
 */
export const sapAiJobSchema = z
  .object({
    id: ulidSchema,
    stageRunId: ulidSchema,
    demandId: demandIdSchema,
    attempt: z.number().int().positive(),
    stageKey: z.string().min(1).max(64),
    state: sapAiJobStateSchema,
    payload: sapAiJobPayloadSchema,
    claimId: z.string().min(1).max(128).nullable(),
    leaseExpiresAt: isoDateTimeSchema.nullable(),
    result: sapAiJobResultSummarySchema.nullable(),
    lastError: z.string().max(SAP_AI_JOB_ERROR_MAX_CHARS).nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type SapAiJob = z.infer<typeof sapAiJobSchema>;

export const sapAiJobLeaseSchema = z
  .object({
    expiresAt: isoDateTimeSchema,
    renewIntervalMs: z.number().int().positive(),
  })
  .strict();
export type SapAiJobLease = z.infer<typeof sapAiJobLeaseSchema>;

// --- POST /api/v1/sap/ai-jobs/next -----------------------------------------

export const sapAiJobsNextBodySchema = z
  .object({
    limit: z.number().int().positive().max(MAX_SAP_AI_JOB_BATCH_SIZE).default(DEFAULT_SAP_AI_JOB_BATCH_SIZE),
  })
  .strict();
export type SapAiJobsNextBody = z.infer<typeof sapAiJobsNextBodySchema>;

export const sapAiJobsResponseSchema = z
  .object({
    jobs: z.array(sapAiJobSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type SapAiJobsResponse = z.infer<typeof sapAiJobsResponseSchema>;

// --- POST /api/v1/sap/ai-jobs/{id}/claim -----------------------------------

export const sapAiJobClaimBodySchema = z.object({}).strict();
export type SapAiJobClaimBody = z.infer<typeof sapAiJobClaimBodySchema>;

export const sapAiJobClaimResponseSchema = z
  .object({
    job: sapAiJobSchema,
    claimId: z.string().min(1).max(128),
    lease: sapAiJobLeaseSchema,
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type SapAiJobClaimResponse = z.infer<typeof sapAiJobClaimResponseSchema>;

// --- POST /api/v1/sap/ai-jobs/{id}/heartbeat -------------------------------

export const sapAiJobHeartbeatBodySchema = z
  .object({ claimId: z.string().min(1).max(128) })
  .strict();
export type SapAiJobHeartbeatBody = z.infer<typeof sapAiJobHeartbeatBodySchema>;

export const sapAiJobHeartbeatResponseSchema = z
  .object({
    jobId: ulidSchema,
    claimId: z.string().min(1).max(128),
    lease: sapAiJobLeaseSchema,
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type SapAiJobHeartbeatResponse = z.infer<typeof sapAiJobHeartbeatResponseSchema>;

// --- POST /api/v1/sap/ai-jobs/{id}/result ----------------------------------

const sapAiJobResultBaseShape = {
  claimId: z.string().min(1).max(128),
  usage: sapAiJobUsageSchema.optional(),
  durationMs: z.number().int().nonnegative().max(60 * 60 * 1_000).optional(),
};

export const sapAiJobResultSucceededBodySchema = z
  .object({
    ...sapAiJobResultBaseShape,
    status: z.literal('succeeded'),
    /** Raw model output (may be fenced JSON); the control plane validates it. */
    outputText: z.string().min(1).max(SAP_AI_JOB_OUTPUT_MAX_CHARS),
  })
  .strict();
export type SapAiJobResultSucceededBody = z.infer<typeof sapAiJobResultSucceededBodySchema>;

export const sapAiJobResultFailedBodySchema = z
  .object({
    ...sapAiJobResultBaseShape,
    status: z.literal('failed'),
    error: z
      .object({
        code: z.string().min(1).max(64).optional(),
        message: z.string().min(1).max(SAP_AI_JOB_ERROR_MAX_CHARS),
        retryable: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export type SapAiJobResultFailedBody = z.infer<typeof sapAiJobResultFailedBodySchema>;

export const sapAiJobResultBodySchema = z.discriminatedUnion('status', [
  sapAiJobResultSucceededBodySchema,
  sapAiJobResultFailedBodySchema,
]);
export type SapAiJobResultBody = z.infer<typeof sapAiJobResultBodySchema>;

export const sapAiJobResultResponseSchema = z
  .object({
    job: sapAiJobSchema,
    /** `true` when this request drove the stage (or failed it), `false` on no-op. */
    accepted: z.boolean(),
    /** `true` when the same job already reached a terminal state (idempotent). */
    duplicate: z.boolean(),
    stageRunId: ulidSchema,
    stageStatus: stageRunStatusSchema,
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type SapAiJobResultResponse = z.infer<typeof sapAiJobResultResponseSchema>;

// --- POST /api/v1/admin/sap/ai-jobs/{id}/requeue (admin Bearer) ------------

export const sapAiJobRequeueBodySchema = z
  .object({ reason: z.string().min(1).max(500).optional() })
  .strict();
export type SapAiJobRequeueBody = z.infer<typeof sapAiJobRequeueBodySchema>;

export const sapAiJobRequeueResponseSchema = z
  .object({
    job: sapAiJobSchema,
    /** `false` when the job was already queued/claimed (idempotent no-op). */
    requeued: z.boolean(),
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type SapAiJobRequeueResponse = z.infer<typeof sapAiJobRequeueResponseSchema>;

// --- GET /hooks/sap/status: appended aiJobs block (docs/003 §4.8) ----------

export const sapAiJobsStatusSchema = z
  .object({
    queued: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    /** Last job `lastError`, or `null` when no job failed yet. */
    lastError: z.string().max(SAP_AI_JOB_ERROR_MAX_CHARS).nullable(),
  })
  .strict();
export type SapAiJobsStatus = z.infer<typeof sapAiJobsStatusSchema>;
