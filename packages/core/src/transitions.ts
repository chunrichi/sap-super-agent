import type {
  ApprovalState,
  ArtifactState,
  AssignmentState,
  DemandStatus,
  StageRunStatus,
  TaskState,
} from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// Pure state machines from docs/003 §2. Every transition map is a closed,
// total mapping from each state to the states it may move to; empty = terminal.
// ---------------------------------------------------------------------------

export const DEMAND_TRANSITIONS: Readonly<Record<DemandStatus, readonly DemandStatus[]>> = {
  submitted: ['in_progress', 'rejected', 'cancelled'],
  in_progress: ['review', 'cancelled'],
  review: ['done', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
  rejected: [],
};

export const STAGE_RUN_TRANSITIONS: Readonly<Record<StageRunStatus, readonly StageRunStatus[]>> = {
  pending: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['done', 'waiting_human', 'failed', 'cancelled'],
  waiting_human: ['done', 'running', 'failed', 'cancelled'],
  failed: ['ready', 'waiting_human', 'cancelled'],
  done: [],
  skipped: [],
  cancelled: [],
};

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ['claimed', 'cancelled'],
  // Release/lease-expiry sends claimed/in_progress tasks back to the pool.
  claimed: ['in_progress', 'completed', 'failed', 'cancelled', 'pending'],
  in_progress: ['completed', 'failed', 'cancelled', 'pending'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const ASSIGNMENT_TRANSITIONS: Readonly<Record<AssignmentState, readonly AssignmentState[]>> =
  {
    active: ['completed', 'released', 'expired'],
    completed: [],
    released: [],
    expired: [],
  };

export const ARTIFACT_TRANSITIONS: Readonly<Record<ArtifactState, readonly ArtifactState[]>> = {
  draft: ['generated', 'superseded'],
  generated: ['in_review', 'superseded'],
  in_review: ['approved', 'rejected', 'superseded'],
  // A newer version supersedes older versions even after they were approved.
  approved: ['superseded'],
  rejected: ['superseded'],
  superseded: [],
};

export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = {
  pending: ['approved', 'rejected', 'withdrawn', 'expired'],
  approved: [],
  rejected: [],
  withdrawn: [],
  expired: [],
};

function allows<S extends string>(
  transitions: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean {
  return transitions[from].includes(to);
}

export function canTransitionDemand(from: DemandStatus, to: DemandStatus): boolean {
  return allows(DEMAND_TRANSITIONS, from, to);
}

export function canTransitionStageRun(from: StageRunStatus, to: StageRunStatus): boolean {
  return allows(STAGE_RUN_TRANSITIONS, from, to);
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return allows(TASK_TRANSITIONS, from, to);
}

export function canTransitionAssignment(from: AssignmentState, to: AssignmentState): boolean {
  return allows(ASSIGNMENT_TRANSITIONS, from, to);
}

export function canTransitionArtifact(from: ArtifactState, to: ArtifactState): boolean {
  return allows(ARTIFACT_TRANSITIONS, from, to);
}

export function canTransitionApproval(from: ApprovalState, to: ApprovalState): boolean {
  return allows(APPROVAL_TRANSITIONS, from, to);
}

export class InvalidTransitionError extends Error {
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

function assertAllowed<S extends string>(
  entity: string,
  transitions: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): void {
  if (!allows(transitions, from, to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
}

export function assertDemandTransition(from: DemandStatus, to: DemandStatus): void {
  assertAllowed('demand', DEMAND_TRANSITIONS, from, to);
}

export function assertStageRunTransition(from: StageRunStatus, to: StageRunStatus): void {
  assertAllowed('stageRun', STAGE_RUN_TRANSITIONS, from, to);
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  assertAllowed('task', TASK_TRANSITIONS, from, to);
}

export function assertAssignmentTransition(from: AssignmentState, to: AssignmentState): void {
  assertAllowed('assignment', ASSIGNMENT_TRANSITIONS, from, to);
}

export function assertArtifactTransition(from: ArtifactState, to: ArtifactState): void {
  assertAllowed('artifact', ARTIFACT_TRANSITIONS, from, to);
}

export function assertApprovalTransition(from: ApprovalState, to: ApprovalState): void {
  assertAllowed('approval', APPROVAL_TRANSITIONS, from, to);
}

/** docs/003 §2.2: retry while attempts remain, otherwise hand to a human. */
export function statusAfterFailedAttempt(
  failedAttempt: number,
  maxAttempts: number,
): 'ready' | 'waiting_human' {
  return failedAttempt < maxAttempts ? 'ready' : 'waiting_human';
}

/** docs/003 §2.3: lease expiry returns a claimed/in_progress task to the pool. */
export function canReturnTaskToPool(from: TaskState): boolean {
  return from === 'claimed' || from === 'in_progress';
}
