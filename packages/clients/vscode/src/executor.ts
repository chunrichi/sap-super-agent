// Executor runtime: registration, 20s heartbeat, lease renewal of claimed
// tasks, and the "stop on auth/lease failure" rule (docs/003 §4.2,
// docs/005 §2.5). Deliberately free of `vscode` imports so it can be unit-tested
// with a stubbed client; the extension supplies UI state via callbacks.
import type {
  ExecutorWorkspace,
  HeartbeatBody,
  HeartbeatResponse,
  RegisterExecutorBody,
  RegisterExecutorResponse,
  Role,
  TaskSummary,
} from '@sap-superagent/protocol';
import {
  ControlPlaneError,
  PROTOCOL_VERSION,
  type LeaseRenewResponse,
  type UnregisterExecutorResponse,
} from './client.js';
import {
  HEARTBEAT_INTERVAL_MS,
  nextHeartbeatDelayMs,
  shouldStopOnError,
  type ConnectionState,
} from './presence.js';

/** Minimal control-plane surface the runtime needs; `ControlPlaneClient` fits. */
export interface ExecutorControlPlane {
  registerExecutor(body: RegisterExecutorBody): Promise<RegisterExecutorResponse>;
  heartbeat(body: HeartbeatBody): Promise<HeartbeatResponse>;
  renewLease(taskId: string): Promise<LeaseRenewResponse>;
  unregister(): Promise<UnregisterExecutorResponse>;
}

export interface ExecutorState {
  connection: ConnectionState;
  accepting: boolean;
  executorId: string | null;
  /** Tasks currently offered by the control plane (available in the inbox). */
  offers: TaskSummary[];
  /** Tasks this executor currently holds a lease for. */
  activeTaskIds: string[];
  /** Number of inbox items the developer still has to look at. */
  pendingCount: number;
  /** Last actionable failure; null when healthy. */
  lastError: string | null;
}

export interface ExecutorRuntimeOptions {
  client: ExecutorControlPlane;
  user: string;
  machineIdHash: string | null;
  workspace: ExecutorWorkspace | null;
  roles: Role[];
  capabilities?: string[];
  maxConcurrent?: number;
  accepting?: boolean;
  heartbeatIntervalMs?: number;
  /** Notified on every state change (status bar / tree view refresh). */
  onState?: (state: ExecutorState) => void;
  /** Actionable error message for the notification area. */
  onError?: (message: string, error?: unknown) => void;
  onOffers?: (offers: TaskSummary[]) => void;
  /** Lease on this task is gone (404/409); stop working on it. */
  onLeaseLost?: (taskId: string, error: ControlPlaneError) => void;
  /** Injectable clock/timers for tests; defaults to the global ones. */
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialState(accepting: boolean): ExecutorState {
  return {
    connection: 'offline',
    accepting,
    executorId: null,
    offers: [],
    activeTaskIds: [],
    pendingCount: 0,
    lastError: null,
  };
}

/**
 * Owns the executor lifecycle. `start()` registers, then beats every 20s
 * (renewing held leases first). A 401/403/409 or network failure pauses the
 * executor instead of silently retrying, per docs/005 §2.5.
 */
export class ExecutorRuntime {
  private readonly client: ExecutorControlPlane;
  private readonly options: ExecutorRuntimeOptions;
  private readonly heartbeatIntervalMs: number;
  private readonly setTimer: NonNullable<ExecutorRuntimeOptions['setTimer']>;
  private readonly clearTimer: NonNullable<ExecutorRuntimeOptions['clearTimer']>;
  private state: ExecutorState;
  private workspace: ExecutorWorkspace | null;
  private failureCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: ExecutorRuntimeOptions) {
    this.options = options;
    this.client = options.client;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.state = initialState(options.accepting ?? true);
    this.workspace = options.workspace;
  }

  get currentState(): ExecutorState {
    return { ...this.state, offers: [...this.state.offers], activeTaskIds: [...this.state.activeTaskIds] };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Register the executor and schedule the first heartbeat. */
  async start(): Promise<ExecutorState> {
    if (this.running && (this.state.connection === 'online' || this.state.connection === 'connecting')) {
      return this.currentState;
    }
    this.running = true;
    this.failureCount = 0;
    this.patchState({ connection: 'connecting', lastError: null });
    try {
      const response = await this.client.registerExecutor(this.buildRegisterBody());
      this.patchState({
        connection: 'online',
        executorId: response.executor.id,
        accepting: response.executor.accepting,
      });
      // Beat immediately: the server only offers tasks to rows whose presence
      // was refreshed at least once (registered rows start `offline`).
      await this.heartbeatOnce();
      return this.currentState;
    } catch (error) {
      this.running = false;
      this.patchState({ connection: 'offline', lastError: messageOf(error) });
      this.options.onError?.(this.describeStartError(error), error);
      return this.currentState;
    }
  }

  /** Stop timers and (optionally) `DELETE /executors/{id}` on graceful shutdown. */
  async stop(options: { unregister?: boolean } = {}): Promise<void> {
    this.running = false;
    this.clearScheduled();
    if (options.unregister === true) {
      try {
        await this.client.unregister();
      } catch {
        // Best effort: a dead control plane must not block window close.
      }
    }
    this.patchState({ connection: 'offline', offers: [], lastError: null });
  }

  /** Toggle "暂停接单"; heartbeats report `away` while paused. */
  setAccepting(accepting: boolean): void {
    if (this.state.accepting === accepting) {
      return;
    }
    this.patchState({ accepting });
  }

  /** Workspace folder switch: the next heartbeat reports the new active key. */
  setWorkspace(workspace: ExecutorWorkspace | null): void {
    this.workspace = workspace;
  }

  /** Task IDs with an active lease; renewed on every heartbeat tick. */
  setActiveTasks(taskIds: string[]): void {
    this.patchState({ activeTaskIds: [...taskIds] });
  }

  /** Inbox item count used by the status bar. */
  setPendingCount(pendingCount: number): void {
    if (this.state.pendingCount === pendingCount) {
      return;
    }
    this.patchState({ pendingCount });
  }

  /** One heartbeat tick (also drives lease renewal); public for tests. */
  async heartbeatOnce(): Promise<ExecutorState> {
    if (!this.running) {
      return this.currentState;
    }
    const lost = await this.renewActiveLeases();
    if (!this.running) {
      return this.currentState;
    }
    try {
      const response = await this.client.heartbeat(this.buildHeartbeatBody());
      this.failureCount = 0;
      this.patchState({
        connection: 'online',
        lastError: null,
        offers: response.offers,
      });
      this.options.onOffers?.(response.offers);
      this.schedule(this.heartbeatIntervalMs);
    } catch (error) {
      this.handleHeartbeatFailure(error, lost);
    }
    return this.currentState;
  }

  private async renewActiveLeases(): Promise<number> {
    let lost = 0;
    for (const taskId of [...this.state.activeTaskIds]) {
      try {
        await this.client.renewLease(taskId);
      } catch (error) {
        const controlPlaneError = error instanceof ControlPlaneError ? error : undefined;
        if (controlPlaneError !== undefined && (controlPlaneError.status === 404 || controlPlaneError.status === 409)) {
          lost += 1;
          this.removeActiveTask(taskId);
          this.options.onLeaseLost?.(taskId, controlPlaneError);
          continue;
        }
        if (shouldStopOnError(error)) {
          this.pause(error);
          return lost;
        }
        // Retryable (5xx/429): keep the lease and let the next tick try again.
        this.options.onError?.(`租约续约失败：${messageOf(error)}`, error);
      }
    }
    return lost;
  }

  private handleHeartbeatFailure(error: unknown, _lostLeases: number): void {
    if (shouldStopOnError(error)) {
      this.pause(error);
      return;
    }
    this.failureCount += 1;
    this.patchState({
      connection: 'online',
      lastError: messageOf(error),
    });
    this.options.onError?.(`心跳失败，将重试：${messageOf(error)}`, error);
    this.schedule(nextHeartbeatDelayMs({ intervalMs: this.heartbeatIntervalMs, failureCount: this.failureCount }));
  }

  /** Stop renewing/claiming and leave the status bar in "已暂停". */
  private pause(error: unknown): void {
    this.running = false;
    this.clearScheduled();
    this.patchState({
      connection: 'paused',
      offers: [],
      lastError: messageOf(error),
    });
    this.options.onError?.(this.describeStopReason(error), error);
  }

  private describeStartError(error: unknown): string {
    if (error instanceof ControlPlaneError && error.status === 401) {
      return '连接控制平面失败：token 无效或已过期。请运行 “SAP Super Agent: 连接控制平面” 重新填写。';
    }
    return `连接控制平面失败：${messageOf(error)}`;
  }

  private describeStopReason(error: unknown): string {
    if (error instanceof ControlPlaneError) {
      if (error.status === 401 || error.status === 403) {
        return '控制平面拒绝了 token（401/403），已暂停接单。请重新连接控制平面。';
      }
      if (error.status === 409) {
        return '租约/任务状态已变化（409），已暂停接单。请刷新任务箱后重试。';
      }
      if (error.code === 'network_error') {
        return '控制平面不可达，已暂停接单。恢复网络后请重新连接。';
      }
    }
    return `已暂停接单：${messageOf(error)}`;
  }

  private removeActiveTask(taskId: string): void {
    this.patchState({
      activeTaskIds: this.state.activeTaskIds.filter((id) => id !== taskId),
    });
  }

  private schedule(delayMs: number): void {
    this.clearScheduled();
    if (!this.running) {
      return;
    }
    this.timer = this.setTimer(() => {
      void this.heartbeatOnce();
    }, delayMs);
  }

  private clearScheduled(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private buildRegisterBody(): RegisterExecutorBody {
    return {
      kind: 'vscode',
      user: this.options.user,
      ...(this.options.machineIdHash === null ? {} : { machineIdHash: this.options.machineIdHash }),
      capabilities: this.options.capabilities ?? ['coding', 'doc-review'],
      roles: this.options.roles,
      workspaces: this.workspace === null ? [] : [this.workspace],
      protocolVersion: PROTOCOL_VERSION,
      ...(this.options.maxConcurrent === undefined ? {} : { maxConcurrent: this.options.maxConcurrent }),
    };
  }

  private buildHeartbeatBody(): HeartbeatBody {
    const load = this.state.activeTaskIds.length;
    const status = !this.state.accepting ? 'away' : load > 0 ? 'busy' : 'online';
    return {
      status,
      load,
      ...(this.workspace === null ? {} : { workspaces: [this.workspace] }),
      activeWorkspaceKey: this.workspace?.workspaceKey ?? null,
    };
  }

  private patchState(patch: Partial<ExecutorState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState?.(this.currentState);
  }
}
