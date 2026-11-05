import { z } from 'zod';
import {
  artifactKindSchema,
  artifactStateSchema,
  approvalDecisionSchema,
  approvalStateSchema,
  assignmentStateSchema,
  authorTypeSchema,
  demandSourceSchema,
  demandStatusSchema,
  executorKindSchema,
  notificationKindSchema,
  prioritySchema,
  presenceStateSchema,
  roleSchema,
  stageRunStatusSchema,
  taskStateSchema,
} from './enums.js';
import { demandIdSchema, ulidSchema } from './ids.js';

// ---------------------------------------------------------------------------
// Shared scalars
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp, always with a `Z` suffix (docs/003 §4.1). */
export const isoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** `sha256:<64 lowercase hex>` (docs/003 §4.6). */
export const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const checksumSchema = z
  .string()
  .regex(CHECKSUM_PATTERN, 'expected "sha256:<64 lowercase hex>"');

/** Opaque artifact content reference, e.g. `artifact://01J.../v1`. */
export const contentRefSchema = z.string().min(1);

export const workspaceBindingSchema = z
  .object({
    repo: z.string().min(1),
    projectKey: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
  })
  .strict();
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;

export const executorWorkspaceSchema = z
  .object({
    workspaceKey: z.string().min(1),
    repo: z.string().min(1).optional(),
    projectKey: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    localPathHint: z.string().min(1).optional(),
  })
  .strict();
export type ExecutorWorkspace = z.infer<typeof executorWorkspaceSchema>;

export const leaseSchema = z
  .object({
    expiresAt: isoDateTimeSchema,
    renewIntervalMs: z.number().int().positive(),
  })
  .strict();
export type Lease = z.infer<typeof leaseSchema>;

// ---------------------------------------------------------------------------
// Demand (docs/003 §2.1)
// ---------------------------------------------------------------------------

export const demandRequesterSchema = z
  .object({
    userId: z.string().min(1),
    orgUnit: z.string().min(1).optional(),
  })
  .strict();
export type DemandRequester = z.infer<typeof demandRequesterSchema>;

export const demandSchema = z
  .object({
    id: demandIdSchema,
    /** Human-readable number, e.g. `R-2041`; SAP number range in S2. */
    no: z.string().min(1).optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(20_000),
    acceptanceCriteria: z.array(z.string().min(1)).max(50),
    requester: demandRequesterSchema,
    priority: prioritySchema,
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive(),
    status: demandStatusSchema,
    /** `null`/absent = unbound demand: tasks land in the general inbox. */
    workspaceBinding: workspaceBindingSchema.nullable(),
    source: demandSourceSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type Demand = z.infer<typeof demandSchema>;

// ---------------------------------------------------------------------------
// StageRun (docs/003 §2.2)
// ---------------------------------------------------------------------------

export const artifactRefSchema = z
  .object({
    artifactId: ulidSchema,
    version: z.number().int().positive(),
  })
  .strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const stageRunSchema = z
  .object({
    id: ulidSchema,
    demandId: demandIdSchema,
    stageKey: z.string().min(1),
    status: stageRunStatusSchema,
    /** 1-based; retries/rejections bump the attempt on the same StageRun. */
    attempt: z.number().int().positive(),
    executorKind: executorKindSchema,
    /** Gate declared by the template, `null` when the stage is fully automatic. */
    gateKey: z.string().min(1).nullable(),
    inputRefs: z.array(artifactRefSchema),
    outputArtifactId: ulidSchema.nullable(),
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type StageRun = z.infer<typeof stageRunSchema>;

/** Run-ledger row recorded for every server-ai stage attempt (docs/003 §2.2). */
export const stageAttemptSchema = z
  .object({
    stageRunId: ulidSchema,
    attempt: z.number().int().positive(),
    model: z.string().nullable(),
    promptVersion: z.string().nullable(),
    inputRefs: z.array(artifactRefSchema),
    schemaOk: z.boolean(),
    tokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    error: z.string().nullable(),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema,
  })
  .strict();
export type StageAttempt = z.infer<typeof stageAttemptSchema>;

// ---------------------------------------------------------------------------
// Task + Assignment (docs/003 §2.3)
// ---------------------------------------------------------------------------

export const taskSchema = z
  .object({
    id: ulidSchema,
    /** External demand primary key; the control plane never re-generates it. */
    demandId: demandIdSchema,
    stageRunId: ulidSchema.nullable(),
    title: z.string().min(1).max(200),
    executorKind: executorKindSchema,
    requiredRoles: z.array(roleSchema),
    /** `null` = general inbox task. Never contains a local path. */
    workspaceBinding: workspaceBindingSchema.nullable(),
    priority: prioritySchema,
    dueAt: isoDateTimeSchema.nullable(),
    state: taskStateSchema,
    /** Up to 3 users who most recently released/expired this task. */
    lastHolderUserIds: z.array(z.string().min(1)).max(3),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;

/** WS/REST summary pushed on `task.offered` (no artifact contents). */
export const taskSummarySchema = z
  .object({
    id: ulidSchema,
    demandId: demandIdSchema,
    title: z.string().min(1),
    executorKind: executorKindSchema,
    requiredRoles: z.array(roleSchema),
    workspaceBinding: workspaceBindingSchema.nullable(),
    priority: prioritySchema,
    dueAt: isoDateTimeSchema.nullable(),
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const assignmentSchema = z
  .object({
    id: ulidSchema,
    taskId: ulidSchema,
    executorId: ulidSchema,
    userId: z.string().min(1).nullable(),
    state: assignmentStateSchema,
    leaseExpiresAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema.nullable(),
  })
  .strict();
export type Assignment = z.infer<typeof assignmentSchema>;

// ---------------------------------------------------------------------------
// Artifact (docs/003 §2.4)
// ---------------------------------------------------------------------------

export const artifactSchema = z
  .object({
    id: ulidSchema,
    demandId: demandIdSchema,
    kind: artifactKindSchema,
    stageKey: z.string().min(1).nullable(),
    stageRunId: ulidSchema.nullable(),
    state: artifactStateSchema,
    currentVersion: z.number().int().positive(),
    title: z.string().min(1).nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;

export const artifactVersionSchema = z
  .object({
    artifactId: ulidSchema,
    version: z.number().int().positive(),
    contentRef: contentRefSchema,
    contentType: z.string().min(1),
    checksum: checksumSchema,
    summary: z.string().nullable(),
    authorType: authorTypeSchema,
    authorId: z.string().min(1),
    /** Set when an upstream artifact got a newer version (docs/003 §2.2). */
    stale: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

/**
 * Version chain grouped by stage for `GET /demands/{id}` (docs/003 §2.4):
 * artifacts are immutable, so prior versions stay in the chain and keep their
 * `stale` markers.
 */
export const artifactChainSchema = z
  .object({
    stageKey: z.string().min(1).nullable(),
    artifacts: z.array(artifactSchema),
    versions: z.array(artifactVersionSchema),
  })
  .strict();
export type ArtifactChain = z.infer<typeof artifactChainSchema>;

// ---------------------------------------------------------------------------
// Approval (docs/003 §2.5)
// ---------------------------------------------------------------------------

export const approvalSchema = z
  .object({
    id: ulidSchema,
    demandId: demandIdSchema,
    stageRunId: ulidSchema,
    gateKey: z.string().min(1),
    /** The gate is bound to one immutable artifact version (docs/003 §2.5). */
    artifactId: ulidSchema,
    artifactVersion: z.number().int().positive(),
    state: approvalStateSchema,
    requiredRole: roleSchema,
    decision: approvalDecisionSchema.nullable(),
    decidedBy: z.string().min(1).nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    comment: z.string().nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type Approval = z.infer<typeof approvalSchema>;

// ---------------------------------------------------------------------------
// Notification (docs/003 §2.5, docs/005 §2.2): in-product "必须你处理" alerts.
// v1 does not model users/roles; `requiredRole` records who should act and the
// local mode surfaces every unread notification to user/admin tokens.
// ---------------------------------------------------------------------------

export const notificationSchema = z
  .object({
    id: ulidSchema,
    demandId: demandIdSchema,
    stageRunId: ulidSchema.nullable(),
    approvalId: ulidSchema.nullable(),
    kind: notificationKindSchema,
    requiredRole: roleSchema.nullable(),
    title: z.string().min(1).max(200),
    body: z.string().nullable(),
    createdAt: isoDateTimeSchema,
    readAt: isoDateTimeSchema.nullable(),
  })
  .strict();
export type Notification = z.infer<typeof notificationSchema>;


// ---------------------------------------------------------------------------
// Executor (docs/003 §2.6)
// ---------------------------------------------------------------------------

export const executorSchema = z
  .object({
    id: ulidSchema,
    kind: executorKindSchema,
    user: z.string().min(1),
    machineIdHash: z.string().min(1).nullable(),
    capabilities: z.array(z.string().min(1)),
    roles: z.array(roleSchema),
    workspaces: z.array(executorWorkspaceSchema),
    /** Workspace the executor currently has open; null = no folder / not bindable. */
    activeWorkspaceKey: z.string().min(1).nullable(),
    presence: presenceStateSchema,
    accepting: z.boolean(),
    maxConcurrent: z.number().int().positive(),
    protocolVersion: z.string().min(1),
    cliVersion: z.string().min(1).nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type Executor = z.infer<typeof executorSchema>;
