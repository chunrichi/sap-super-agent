import { z } from 'zod';
import { eventSubjectTypeSchema, eventTypeSchema } from './enums.js';
import { isoDateTimeSchema } from './entities.js';
import { ulidSchema } from './ids.js';

// ---------------------------------------------------------------------------
// S4: generic Hook contract (docs/008, docs/003 §4.4/§4.7).
//
// A Hook subscribes a *persisted control-plane event type* (`events: [...]`)
// and delivers the uniform envelope below to an external target over `http`.
// The envelope is the authoritative machine-readable contract; adapters only
// map fields and never add business branches to the core stage graph.
// ---------------------------------------------------------------------------

/** Envelope schema version; a target may reject unknown versions into the DLQ. */
export const HOOK_ENVELOPE_VERSION = 1;

/** Only the generic `http` target ships in v1 (docs/008 §3/§6). */
export const HOOK_TARGET_KINDS = ['http'] as const;
export const hookTargetKindSchema = z.enum(HOOK_TARGET_KINDS);
export type HookTargetKind = z.infer<typeof hookTargetKindSchema>;

export const HOOK_RECEIPT_EVENT_TYPE = 'hook.receipt' as const;
export const HOOK_RECEIPT_STATUSES = ['created', 'updated', 'failed', 'cancelled'] as const;
export const hookReceiptStatusSchema = z.enum(HOOK_RECEIPT_STATUSES);
export type HookReceiptStatus = z.infer<typeof hookReceiptStatusSchema>;

/** Retry policy carried in the envelope and read from the hook config. */
export const HOOK_BACKOFF_MODES = ['exponential'] as const;
export const hookBackoffModeSchema = z.enum(HOOK_BACKOFF_MODES);

export const hookRetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().positive().max(20).default(5),
    backoff: hookBackoffModeSchema.default('exponential'),
    deadLetter: z.boolean().default(true),
  })
  .strict();
export type HookRetryPolicy = z.infer<typeof hookRetryPolicySchema>;

/** Defaults from docs/008 §5 (2s exponential backoff capped at 5min, 5 attempts). */
export const DEFAULT_HOOK_MAX_ATTEMPTS = 5;
export const DEFAULT_HOOK_BACKOFF_BASE_MS = 2_000;
export const DEFAULT_HOOK_BACKOFF_MAX_MS = 5 * 60 * 1_000;
/** Outbox poll interval; tests/env may lower it (`SA_HOOKS_POLL_MS`). */
export const DEFAULT_HOOK_POLL_MS = 500;
/** Per-request HTTP timeout for the generic `http` target (10s). */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
/** Receipt acceptance window for X-SA-Timestamp, same as the SAP webhook (±5min). */
export const DEFAULT_HOOK_RECEIPT_TOLERANCE_MS = 5 * 60 * 1_000;

/**
 * `subject` carries IDs/versions only (never bodies): the payload/body lives in
 * the source event `data`, and artifact content stays behind `contentRef`
 * (docs/008 §2). `type`/`id` identify the persisted event subject.
 */
export const hookSubjectSchema = z
  .object({
    type: eventSubjectTypeSchema,
    id: z.string().min(1).max(128),
    demandId: z.string().min(1).max(64).optional(),
    demandNo: z.string().min(1).max(64).optional(),
    stageRunId: z.string().min(1).max(64).optional(),
    artifactId: z.string().min(1).max(64).optional(),
    /** Artifact version referenced by the event, when the event carries one. */
    version: z.number().int().positive().optional(),
  })
  .strict();
export type HookSubject = z.infer<typeof hookSubjectSchema>;

/**
 * Uniform outbound envelope (docs/008 §2). `eventType` is the *persisted source
 * event type* that triggered the hook (`events: [...]` subscription); the
 * adapter-specific logical names in docs/008 §3 stay an adapter concern.
 */
export const hookEnvelopeSchema = z
  .object({
    /** Source event id: stable across replays (docs/008 §2). */
    eventId: z.string().min(1).max(128),
    eventType: eventTypeSchema,
    eventVersion: z.number().int().positive(),
    occurredAt: isoDateTimeSchema,
    subject: hookSubjectSchema,
    /** Source event `data` snapshot; adapters map fields from here. */
    payload: z.record(z.string(), z.unknown()),
    /** `<demandId|subjectId>:<hookId>:<sha256(eventId)>`; replay never changes it. */
    idempotencyKey: z.string().min(1).max(256),
    retry: hookRetryPolicySchema,
    /** Correlation id; v1 uses the source event id. */
    traceId: z.string().min(1).max(128),
  })
  .strict();
export type HookEnvelope = z.infer<typeof hookEnvelopeSchema>;

/** Hook ids are config keys, used verbatim in outbox targets and URLs. */
export const HOOK_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const hookIdSchema = z.string().regex(HOOK_ID_PATTERN, 'expected lower-kebab-case hook id');

/** `env:NAME` keeps secrets out of the config file, database and logs. */
export const HOOK_SECRET_REF_PATTERN = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
export const hookSecretRefSchema = z
  .string()
  .regex(HOOK_SECRET_REF_PATTERN, 'expected "env:NAME" (secret is read from the environment)');

function httpUrlSchema(label: string): z.ZodString {
  return z
    .string()
    .url()
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: `${label} must be an http(s) URL`,
    });
}

/**
 * One configured hook (docs/008 §6). `enabled: false` is the default so the
 * shipped example cannot affect H0–S3 behaviour; enabling is an explicit opt-in.
 * Extra cross-field rules (unique ids, no `hook.*` subscriptions, secret present
 * for enabled hooks) are enforced by the server config loader.
 */
export const hookDefinitionSchema = z
  .object({
    id: hookIdSchema,
    target: z.literal('http'),
    url: httpUrlSchema('url'),
    /** Persisted event types that trigger this hook (docs/003 §4.4). */
    events: z.array(eventTypeSchema).min(1),
    secretRef: hookSecretRefSchema,
    enabled: z.boolean().default(false),
    retry: hookRetryPolicySchema.optional(),
    /** Optional external listing endpoint used by `pnpm hooks:reconcile`. */
    reconcileUrl: httpUrlSchema('reconcileUrl').optional(),
    /**
     * Reserved: v1 always records receipts only (docs/008 §4). Setting `true`
     * is rejected at startup with an actionable error until the stage-advance
     * semantics are defined (docs/003 §2.2/§2.5).
     */
    advanceOnReceipt: z.boolean().default(false),
  })
  .strict();
export type HookDefinition = z.infer<typeof hookDefinitionSchema>;

/** Executable format of `examples/hooks.yaml` (docs/008 §6). */
export const hooksConfigFileSchema = z
  .object({
    hooks: z.array(hookDefinitionSchema).default([]),
  })
  .strict();
export type HooksConfigFile = z.infer<typeof hooksConfigFileSchema>;

// ---------------------------------------------------------------------------
// Inbound receipts (docs/003 §4.7, docs/008 §4)
// ---------------------------------------------------------------------------

/** Body of `POST /hooks/{target}/receipt`; HMAC headers follow docs/003 §4.1. */
export const hookReceiptBodySchema = z
  .object({
    eventType: z.literal(HOOK_RECEIPT_EVENT_TYPE),
    /** External id + status; duplicates are answered idempotently. */
    idempotencyKey: z.string().min(1).max(256),
    occurredAt: isoDateTimeSchema.optional(),
    payload: z
      .object({
        /** `jiraKey` / `trNumber` / `pageId` / generic external id. */
        externalId: z.string().min(1).max(256),
        status: hookReceiptStatusSchema,
        detailRef: z.string().min(1).max(2_000).optional(),
      })
      .strict(),
  })
  .strict();
export type HookReceiptBody = z.infer<typeof hookReceiptBodySchema>;

export const hookReceiptResponseSchema = z
  .object({
    accepted: z.literal(true),
    /** `true` when this idempotency key / delivery id was already recorded. */
    duplicate: z.boolean(),
    receiptId: ulidSchema,
    hookId: z.string().min(1),
    externalId: z.string().min(1),
    status: hookReceiptStatusSchema,
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type HookReceiptResponse = z.infer<typeof hookReceiptResponseSchema>;

// ---------------------------------------------------------------------------
// Management surface (docs/003 §4.7, docs/008 §6)
// ---------------------------------------------------------------------------

export const hookQueueDepthSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  })
  .strict();
export type HookQueueDepth = z.infer<typeof hookQueueDepthSchema>;

/** Latest persistable signal for one hook (derived from hook.* events). */
export const hookLastAttemptSchema = z
  .object({
    at: isoDateTimeSchema,
    attempt: z.number().int().nonnegative(),
    ok: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type HookLastAttempt = z.infer<typeof hookLastAttemptSchema>;

export const hookStatusSchema = z
  .object({
    id: z.string().min(1),
    target: hookTargetKindSchema,
    enabled: z.boolean(),
    events: z.array(eventTypeSchema),
    queue: hookQueueDepthSchema,
    lastError: z.string().nullable(),
    lastAttempt: hookLastAttemptSchema.nullable(),
  })
  .strict();
export type HookStatus = z.infer<typeof hookStatusSchema>;

export const listHooksResponseSchema = z
  .object({
    hooks: z.array(hookStatusSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type ListHooksResponse = z.infer<typeof listHooksResponseSchema>;

/** Request body of `POST /hooks/{id}/replay` (admin + Idempotency-Key). */
export const hookReplayBodySchema = z
  .object({
    eventId: z.string().min(1).max(128),
  })
  .strict();
export type HookReplayBody = z.infer<typeof hookReplayBodySchema>;

export const hookReplayResponseSchema = z
  .object({
    hookId: z.string().min(1),
    eventId: z.string().min(1),
    replayed: z.boolean(),
    status: z.enum(['queued', 'already_pending']),
    outboxId: z.string().min(1),
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type HookReplayResponse = z.infer<typeof hookReplayResponseSchema>;
