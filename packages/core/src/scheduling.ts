import {
  DEFAULT_LEASE_RENEW_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_CONCURRENT,
  type Executor,
  type ExecutorWorkspace,
  type PresenceState,
  type Priority,
  type Task,
  type WorkspaceBinding,
} from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// Deterministic scheduling rules from docs/003 §3. Pure functions: callers pass
// in server time and whatever executor counters they loaded from the store.
// ---------------------------------------------------------------------------

export interface ServerClock {
  /** Server time in epoch milliseconds. Clients never judge expiry locally. */
  nowMs: number;
}

export function leaseExpiresAtIso(nowMs: number, leaseTtlMs = DEFAULT_LEASE_TTL_MS): string {
  return new Date(nowMs + leaseTtlMs).toISOString();
}

export function isLeaseExpired(
  leaseExpiresAt: string | null,
  nowMs: number,
): boolean {
  if (leaseExpiresAt === null) return true;
  return Date.parse(leaseExpiresAt) <= nowMs;
}

/** Presence TTL from docs/003 §3: offline when the last heartbeat is older than TTL. */
export function isPresenceExpired(
  lastHeartbeatAtIso: string | null,
  nowMs: number,
  presenceTtlMs: number,
): boolean {
  if (lastHeartbeatAtIso === null) return true;
  return nowMs - Date.parse(lastHeartbeatAtIso) > presenceTtlMs;
}

export function effectivePresence(
  executor: Executor,
  lastHeartbeatAtIso: string | null,
  nowMs: number,
  presenceTtlMs: number,
): PresenceState {
  if (isPresenceExpired(lastHeartbeatAtIso, nowMs, presenceTtlMs)) return 'offline';
  return executor.presence;
}

export interface ClaimEligibilityInput {
  task: Task;
  executor: Executor;
  /** The workspace the executor currently has open, if any. */
  activeWorkspaceKey: string | null;
  nowMs: number;
  presenceTtlMs: number;
  lastHeartbeatAt: string | null;
  /** Active assignments currently held by this executor. */
  activeAssignmentsForExecutor: number;
  /** Active human tasks for the same user on the same demand. */
  activeAssignmentsForSameDemand: number;
  /** Server-wide pause switch (`off` autonomy / maintenance). */
  globallyPaused: boolean;
}

export interface ClaimEligibility {
  eligible: boolean;
  reasons: string[];
}

function normalizeBinding(binding: WorkspaceBinding | null): WorkspaceBinding | null {
  if (binding === null) return null;
  return binding;
}

export function bindingMatches(
  taskBinding: WorkspaceBinding | null,
  workspaces: readonly ExecutorWorkspace[],
  activeWorkspaceKey: string | null,
): boolean {
  const binding = normalizeBinding(taskBinding);
  if (binding === null) return true; // general inbox: role/team is enough
  if (activeWorkspaceKey === null) return false;
  const active = workspaces.find((workspace) => workspace.workspaceKey === activeWorkspaceKey);
  if (active === undefined) return false;
  if (active.repo !== binding.repo) return false;
  if (binding.projectKey !== undefined && active.projectKey !== binding.projectKey) return false;
  if (binding.baseBranch !== undefined && active.baseBranch !== binding.baseBranch) return false;
  return true;
}

/**
 * Rule 1-6 of docs/003 §3. `server-ai` tasks ignore presence/accepting/workspace
 * constraints: they run unattended 7x24.
 */
export function evaluateClaimEligibility(input: ClaimEligibilityInput): ClaimEligibility {
  const reasons: string[] = [];
  const { task, executor } = input;

  if (task.state !== 'pending') reasons.push('task_not_pending');
  if (task.executorKind !== executor.kind) reasons.push('executor_kind_mismatch');
  if (task.requiredRoles.some((role) => !executor.roles.includes(role))) {
    reasons.push('role_mismatch');
  }
  if (input.globallyPaused) reasons.push('server_paused');

  if (task.executorKind === 'vscode') {
    if (!bindingMatches(task.workspaceBinding, executor.workspaces, input.activeWorkspaceKey)) {
      reasons.push('workspace_mismatch');
    }
    if (executor.accepting !== true) reasons.push('executor_not_accepting');
    const presence = effectivePresence(
      executor,
      input.lastHeartbeatAt,
      input.nowMs,
      input.presenceTtlMs,
    );
    if (presence !== 'online' && presence !== 'busy') reasons.push('executor_offline');
    if (input.activeAssignmentsForSameDemand >= 1) reasons.push('same_demand_already_held');
  }

  if (input.activeAssignmentsForExecutor >= (executor.maxConcurrent || DEFAULT_MAX_CONCURRENT)) {
    reasons.push('executor_at_capacity');
  }
  return { eligible: reasons.length === 0, reasons };
}

/** Priority desc, dueAt asc (no due date last), createdAt asc (docs/003 §3). */
export function rankTasks<T extends Pick<Task, 'priority' | 'dueAt' | 'createdAt'>>(
  tasks: readonly T[],
): T[] {
  const priorityWeight: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
  return [...tasks].sort((left, right) => {
    const byPriority = priorityWeight[left.priority] - priorityWeight[right.priority];
    if (byPriority !== 0) return byPriority;
    const leftDue = left.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.dueAt);
    const rightDue = right.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.dueAt);
    if (leftDue !== rightDue) return leftDue - rightDue;
    return Date.parse(left.createdAt) - Date.parse(right.createdAt);
  });
}

export interface OfferInput {
  task: Task;
  executor: Executor;
  activeWorkspaceKey: string | null;
  nowMs: number;
  presenceTtlMs: number;
  lastHeartbeatAt: string | null;
  activeAssignmentsForExecutor: number;
  activeAssignmentsForSameDemand: number;
  globallyPaused: boolean;
}

/** Cheap subset of eligibility used when computing `offers` for WS/heartbeat. */
export function shouldOfferTask(input: OfferInput): boolean {
  if (input.task.executorKind !== input.executor.kind) return false;
  if (input.task.state !== 'pending') return false;
  if (input.executor.kind !== 'vscode') return true;
  return evaluateClaimEligibility({
    task: input.task,
    executor: input.executor,
    activeWorkspaceKey: input.activeWorkspaceKey,
    nowMs: input.nowMs,
    presenceTtlMs: input.presenceTtlMs,
    lastHeartbeatAt: input.lastHeartbeatAt,
    activeAssignmentsForExecutor: input.activeAssignmentsForExecutor,
    activeAssignmentsForSameDemand: input.activeAssignmentsForSameDemand,
    globallyPaused: input.globallyPaused,
  }).eligible;
}

export const LEASE_DEFAULTS = {
  ttlMs: DEFAULT_LEASE_TTL_MS,
  renewIntervalMs: DEFAULT_LEASE_RENEW_INTERVAL_MS,
} as const;
