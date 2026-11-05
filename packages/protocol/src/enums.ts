import { z } from 'zod';

// ---------------------------------------------------------------------------
// Closed enums shared by every control-plane surface. See docs/003 §2.
// ---------------------------------------------------------------------------

export const DEMAND_STATUSES = [
  'submitted',
  'in_progress',
  'review',
  'done',
  'cancelled',
  'rejected',
] as const;
export const demandStatusSchema = z.enum(DEMAND_STATUSES);
export type DemandStatus = z.infer<typeof demandStatusSchema>;

export const DEMAND_TERMINAL_STATUSES: readonly DemandStatus[] = ['done', 'cancelled', 'rejected'];

export const STAGE_RUN_STATUSES = [
  'pending',
  'ready',
  'running',
  'done',
  'waiting_human',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const stageRunStatusSchema = z.enum(STAGE_RUN_STATUSES);
export type StageRunStatus = z.infer<typeof stageRunStatusSchema>;

export const TASK_STATES = [
  'pending',
  'claimed',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;
export const taskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof taskStateSchema>;

export const TASK_TERMINAL_STATES: readonly TaskState[] = ['completed', 'failed', 'cancelled'];

export const ASSIGNMENT_STATES = ['active', 'completed', 'released', 'expired'] as const;
export const assignmentStateSchema = z.enum(ASSIGNMENT_STATES);
export type AssignmentState = z.infer<typeof assignmentStateSchema>;

export const ARTIFACT_STATES = [
  'draft',
  'generated',
  'in_review',
  'approved',
  'rejected',
  'superseded',
] as const;
export const artifactStateSchema = z.enum(ARTIFACT_STATES);
export type ArtifactState = z.infer<typeof artifactStateSchema>;

export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'withdrawn', 'expired'] as const;
export const approvalStateSchema = z.enum(APPROVAL_STATES);
export type ApprovalState = z.infer<typeof approvalStateSchema>;

export const EXECUTOR_KINDS = ['vscode', 'server-ai'] as const;
export const executorKindSchema = z.enum(EXECUTOR_KINDS);
export type ExecutorKind = z.infer<typeof executorKindSchema>;

export const PRESENCE_STATES = ['online', 'busy', 'away', 'offline'] as const;
export const presenceStateSchema = z.enum(PRESENCE_STATES);
export type PresenceState = z.infer<typeof presenceStateSchema>;

/** Presence states a client may report through the heartbeat endpoint. */
export const REPORTABLE_PRESENCE_STATES = ['online', 'busy', 'away'] as const;
export const reportablePresenceSchema = z.enum(REPORTABLE_PRESENCE_STATES);

export const ARTIFACT_KINDS = [
  'requirement_analysis',
  'dev_spec',
  'code_change',
  'test_doc',
  'knowledge_entry',
  'free_note',
] as const;

export const artifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const AUTHOR_TYPES = ['ai', 'human', 'agent', 'import'] as const;
export const authorTypeSchema = z.enum(AUTHOR_TYPES);
export type AuthorType = z.infer<typeof authorTypeSchema>;

export const ROLES = ['requester', 'consultant', 'developer', 'ops'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/**
 * Stage autonomy (docs/003 §2.7, docs/005 §3.2): `observe` stages only produce a
 * draft and stop at `waiting_human`; `auto` stages advance per the gate rules.
 */
export const AUTONOMY_MODES = ['auto', 'observe'] as const;
export const autonomyModeSchema = z.enum(AUTONOMY_MODES);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

/**
 * Decidable checklist assertions (docs/003 §2.2). Templates may only reference
 * these keys; unknown assertions are rejected when the template is loaded.
 */
export const CHECKLIST_ASSERTIONS = [
  'sections_present',
  'inputs_referenced',
  'not_stale',
  'acceptance_covered',
] as const;
export const checklistAssertionSchema = z.enum(CHECKLIST_ASSERTIONS);
export type ChecklistAssertion = z.infer<typeof checklistAssertionSchema>;

/** In-product notifications ("必须你处理" only, docs/005 §5). */
export const NOTIFICATION_KINDS = [
  'approval.requested',
  'approval.decided',
  'approval.expired',
  'stage.waiting_human',
  'stage.failed',
] as const;
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;


export const PRIORITIES = ['high', 'normal', 'low'] as const;
export const prioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof prioritySchema>;

export const DEMAND_SOURCES = ['local', 'sap'] as const;
export const demandSourceSchema = z.enum(DEMAND_SOURCES);
export type DemandSource = z.infer<typeof demandSourceSchema>;

export const TOKEN_KINDS = ['user', 'executor', 'admin'] as const;
export const tokenKindSchema = z.enum(TOKEN_KINDS);
export type TokenKind = z.infer<typeof tokenKindSchema>;

export const APPROVAL_DECISIONS = ['approve', 'reject'] as const;
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const EVENT_SUBJECT_TYPES = [
  'demand',
  'stage_run',
  'task',
  'assignment',
  'artifact',
  'approval',
  'executor',
  'system',
] as const;
export const eventSubjectTypeSchema = z.enum(EVENT_SUBJECT_TYPES);
export type EventSubjectType = z.infer<typeof eventSubjectTypeSchema>;

/**
 * Immutable event-log / WS-push types. `server.ping` and the `client.*`
 * messages are transport-level only and never persisted (see 003 §4.4).
 */
export const EVENT_TYPES = [
  'demand.created',
  'demand.updated',
  'demand.cancelled',
  'stage.ready',
  'stage.started',
  'stage.done',
  'stage.failed',
  'stage.waiting_human',
  'stage.cancelled',
  'task.created',
  'task.offered',
  'task.claimed',
  'task.updated',
  'task.progress',
  'task.completed',
  'task.failed',
  'task.released',
  'task.cancelled',
  'assignment.created',
  'assignment.completed',
  'assignment.released',
  'assignment.expired',
  'artifact.created',
  'artifact.approved',
  'artifact.rejected',
  'artifact.stale',
  'approval.requested',
  'approval.decided',
  'approval.expired',
  'approval.withdrawn',
  'executor.registered',
  'executor.offline',
] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

/** Transport-only WS messages (not persisted in the event log). */
export const SERVER_PING = 'server.ping' as const;
export const RESYNC_REQUIRED = 'resync_required' as const;
export const CLIENT_PONG = 'client.pong' as const;
export const CLIENT_ACK = 'client.ack' as const;

// ---------------------------------------------------------------------------
// Lease / presence defaults from docs/003 §3.
// ---------------------------------------------------------------------------

export const DEFAULT_LEASE_TTL_MS = 60_000;
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 20_000;
export const DEFAULT_PRESENCE_TTL_MS = 60_000;
export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_CONCURRENT_PER_USER = 5;
export const DEFAULT_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
