import { z } from 'zod';
import {
  artifactKindSchema,
  approvalDecisionSchema,
  demandStatusSchema,
  executorKindSchema,
  prioritySchema,
  reportablePresenceSchema,
  roleSchema,
} from './enums.js';
import {
  approvalSchema,
  artifactSchema,
  artifactVersionSchema,
  checksumSchema,
  demandRequesterSchema,
  demandSchema,
  executorSchema,
  executorWorkspaceSchema,
  isoDateTimeSchema,
  leaseSchema,
  stageRunSchema,
  taskSchema,
  taskSummarySchema,
  workspaceBindingSchema,
} from './entities.js';
import { eventEnvelopeSchema } from './events.js';
import { demandIdSchema, ulidSchema } from './ids.js';

// ===========================================================================
// Executors (docs/003 §4.2)
// ===========================================================================

export const registerExecutorBodySchema = z
  .object({
    kind: executorKindSchema,
    user: z.string().min(1),
    machineIdHash: z.string().min(1).optional(),
    capabilities: z.array(z.string().min(1)).default([]),
    roles: z.array(roleSchema).default([]),
    workspaces: z.array(executorWorkspaceSchema).default([]),
    protocolVersion: z.string().min(1),
    cliVersion: z.string().min(1).optional(),
    maxConcurrent: z.number().int().positive().max(16).optional(),
  })
  .strict();
export type RegisterExecutorBody = z.infer<typeof registerExecutorBodySchema>;

export const registerExecutorResponseSchema = z
  .object({
    executor: executorSchema,
    executorToken: z.string().min(1),
    tokenExpiresAt: isoDateTimeSchema,
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type RegisterExecutorResponse = z.infer<typeof registerExecutorResponseSchema>;

export const heartbeatBodySchema = z
  .object({
    status: reportablePresenceSchema,
    load: z.number().int().nonnegative(),
    workspaces: z.array(executorWorkspaceSchema).optional(),
    /** Currently open workspace; switching folders makes the executor unbindable. */
    activeWorkspaceKey: z.string().min(1).nullable().optional(),
  })
  .strict();
export type HeartbeatBody = z.infer<typeof heartbeatBodySchema>;

export const heartbeatResponseSchema = z
  .object({
    serverTime: isoDateTimeSchema,
    leaseTtlMs: z.number().int().positive(),
    renewIntervalMs: z.number().int().positive(),
    offers: z.array(taskSummarySchema),
  })
  .strict();
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const unregisterExecutorResponseSchema = z
  .object({
    releasedTaskIds: z.array(ulidSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();

// ===========================================================================
// Tasks (docs/003 §4.2)
// ===========================================================================

export const listTasksQuerySchema = z
  .object({
    state: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listTasksResponseSchema = z
  .object({
    tasks: z.array(taskSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

export const taskDetailResponseSchema = z
  .object({
    task: taskSchema,
    demand: z
      .object({
        id: demandIdSchema,
        title: z.string().min(1),
        status: demandStatusSchema,
        priority: prioritySchema,
      })
      .strict(),
    artifacts: z.array(artifactSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();

export const taskContextArtifactSchema = z
  .object({
    artifactId: ulidSchema,
    version: z.number().int().positive(),
    kind: artifactKindSchema,
    summary: z.string().nullable(),
    contentRef: z.string().min(1),
  })
  .strict();

export const taskContextSchema = z
  .object({
    task: taskSchema,
    demand: z
      .object({
        id: demandIdSchema,
        title: z.string().min(1),
        description: z.string(),
        acceptanceCriteria: z.array(z.string()),
        priority: prioritySchema,
        requester: demandRequesterSchema,
      })
      .strict(),
    stage: z
      .object({
        key: z.string().min(1),
        name: z.string().min(1),
        outputArtifactKind: artifactKindSchema,
      })
      .strict()
      .nullable(),
    inputArtifacts: z.array(taskContextArtifactSchema),
    workspaceBinding: workspaceBindingSchema.nullable(),
    /** Actions the executor is allowed to take on this task. */
    allowedActions: z.array(z.string().min(1)),
    forbiddenActions: z.array(z.string().min(1)),
    generatedAt: isoDateTimeSchema,
  })
  .strict();
export type TaskContext = z.infer<typeof taskContextSchema>;

export const taskContextResponseSchema = z
  .object({
    markdown: z.string(),
    json: taskContextSchema,
  })
  .strict();

export const claimTaskBodySchema = z.object({}).strict().optional();
export type ClaimTaskBody = z.infer<typeof claimTaskBodySchema>;

export const claimTaskResponseSchema = z
  .object({
    task: taskSchema,
    lease: leaseSchema,
    contextUrl: z.string().min(1),
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type ClaimTaskResponse = z.infer<typeof claimTaskResponseSchema>;

export const leaseRenewResponseSchema = z
  .object({
    lease: leaseSchema,
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type LeaseRenewResponse = z.infer<typeof leaseRenewResponseSchema>;

export const progressBodySchema = z
  .object({
    percent: z.number().int().min(0).max(100).optional(),
    message: z.string().min(1).max(2_000),
    summary: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type ProgressBody = z.infer<typeof progressBodySchema>;

export const submitArtifactBodySchema = z
  .object({
    kind: artifactKindSchema,
    contentType: z.string().min(1),
    contentBase64: z.string().min(1).optional(),
    contentUrl: z.string().url().optional(),
    checksum: checksumSchema,
    summary: z.string().min(1).max(2_000).optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const sources = [body.contentBase64, body.contentUrl].filter((value) => value !== undefined);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of contentBase64 or contentUrl is required',
        path: ['contentBase64'],
      });
    }
  });
export type SubmitArtifactBody = z.infer<typeof submitArtifactBodySchema>;

export const submitArtifactResponseSchema = z
  .object({
    artifact: artifactSchema,
    version: artifactVersionSchema,
    taskState: z.enum(['claimed', 'in_progress', 'completed', 'failed', 'cancelled', 'pending']),
    serverTime: isoDateTimeSchema,
  })
  .strict();

export const completeTaskBodySchema = z
  .object({
    summary: z.string().min(1).max(10_000),
    artifactIds: z.array(ulidSchema).default([]),
    links: z.array(z.string().min(1)).default([]),
    openQuestions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type CompleteTaskBody = z.infer<typeof completeTaskBodySchema>;

export const completeTaskResponseSchema = z
  .object({ task: taskSchema, serverTime: isoDateTimeSchema })
  .strict();
export type CompleteTaskResponse = z.infer<typeof completeTaskResponseSchema>;

export const failTaskBodySchema = z
  .object({
    reason: z.string().min(1).max(2_000),
    retryable: z.boolean(),
  })
  .strict();
export type FailTaskBody = z.infer<typeof failTaskBodySchema>;

export const failTaskResponseSchema = z
  .object({ task: taskSchema, serverTime: isoDateTimeSchema })
  .strict();

export const releaseTaskResponseSchema = z
  .object({ task: taskSchema, serverTime: isoDateTimeSchema })
  .strict();

// ===========================================================================
// Demands + approvals (docs/003 §4.3)
// ===========================================================================

export const createDemandBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(20_000),
    acceptanceCriteria: z.array(z.string().min(1)).max(50).default([]),
    priority: prioritySchema.default('normal'),
    requester: demandRequesterSchema,
    templateId: z.string().min(1).optional(),
    workspaceBinding: workspaceBindingSchema.nullable().optional(),
  })
  .strict();
export type CreateDemandBody = z.infer<typeof createDemandBodySchema>;

export const createDemandResponseSchema = z
  .object({
    demand: demandSchema,
    stages: z.array(stageRunSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type CreateDemandResponse = z.infer<typeof createDemandResponseSchema>;

export const demandDetailResponseSchema = z
  .object({
    demand: demandSchema,
    stages: z.array(stageRunSchema),
    artifacts: z.array(artifactSchema),
    artifactVersions: z.array(artifactVersionSchema),
    approvals: z.array(approvalSchema),
    events: z.array(eventEnvelopeSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();
export type DemandDetailResponse = z.infer<typeof demandDetailResponseSchema>;

export const listDemandsQuerySchema = z
  .object({
    status: z.string().min(1).optional(),
    q: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();

export const listDemandsResponseSchema = z
  .object({
    demands: z.array(demandSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();

export const cancelDemandBodySchema = z
  .object({ reason: z.string().min(1).max(1_000).optional() })
  .strict()
  .optional();

export const cancelDemandResponseSchema = z
  .object({ demand: demandSchema, serverTime: isoDateTimeSchema })
  .strict();

export const listApprovalsQuerySchema = z
  .object({
    assignee: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
  })
  .strict();

export const listApprovalsResponseSchema = z
  .object({ approvals: z.array(approvalSchema), serverTime: isoDateTimeSchema })
  .strict();

export const approvalDecisionBodySchema = z
  .object({
    decision: approvalDecisionSchema,
    comment: z.string().max(2_000).optional(),
    decidedBy: z.string().min(1).optional(),
  })
  .strict();
export type ApprovalDecisionBody = z.infer<typeof approvalDecisionBodySchema>;

export const approvalDecisionResponseSchema = z
  .object({ approval: approvalSchema, serverTime: isoDateTimeSchema })
  .strict();


// ===========================================================================
// Admin (S0 verification only; H1 replaces task creation with templates)
// ===========================================================================

export const adminCreateTaskBodySchema = z
  .object({
    demandId: demandIdSchema,
    stageRunId: ulidSchema.optional(),
    title: z.string().min(1).max(200),
    executorKind: executorKindSchema.default('vscode'),
    requiredRoles: z.array(roleSchema).default([]),
    workspaceBinding: workspaceBindingSchema.nullable().optional(),
    priority: prioritySchema.default('normal'),
    dueAt: isoDateTimeSchema.optional(),
  })
  .strict();
export type AdminCreateTaskBody = z.infer<typeof adminCreateTaskBodySchema>;

export const adminCreateTaskResponseSchema = z
  .object({ task: taskSchema, serverTime: isoDateTimeSchema })
  .strict();

// ===========================================================================
// Ops
// ===========================================================================

export const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
    version: z.string().min(1),
    uptimeMs: z.number().int().nonnegative(),
    serverTime: isoDateTimeSchema,
    aiProvider: z.string().min(1),
    persistence: z.literal('sqlite'),
    mode: z.literal('m1'),
  })
  .strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;
