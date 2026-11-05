// Pure presence / status-bar helpers. No `vscode` import: everything here is
// unit-tested without an extension host (docs/005 §2.2, docs/009 §1).
import { ControlPlaneError } from './client.js';

/** Default heartbeat cadence: docs/003 §4.2 (server TTL is 60s, client renews at 20s). */
export const HEARTBEAT_INTERVAL_MS = 20_000;
/** Lower bound for any scheduled heartbeat (never busy-loop on a bad clock/config). */
export const MIN_HEARTBEAT_DELAY_MS = 1_000;
/** Upper bound for the retry backoff so we recover within a lease TTL after a hiccup. */
export const MAX_HEARTBEAT_DELAY_MS = 60_000;

/** Connection state rendered in the status bar. */
export type ConnectionState = 'offline' | 'connecting' | 'online' | 'paused';

export interface PresenceSnapshot {
  connection: ConnectionState;
  /** `sapSuperAgent.accepting` — false means "paused, still online but not claiming". */
  accepting: boolean;
  /** Offered + locally claimed tasks the developer still has to look at. */
  pendingCount: number;
  /** Pending gates inside `pendingCount`; surfaced in the tooltip only. */
  pendingApprovalCount?: number;
}

export interface StatusBarPresentation {
  /** Codicon + label, e.g. `$(circle-filled) 在线 3`. */
  text: string;
  /** Hover text; always says what the next click does. */
  tooltip: string;
  /** Command executed on click. */
  command: string;
  /** Plain-language label for screen readers (codicon tokens stripped). */
  accessibilityLabel: string;
}

export const TOGGLE_ACCEPTING_COMMAND = 'sapSuperAgent.toggleAccepting';

const ICON_ONLINE = '$(circle-filled)';
const ICON_PAUSED = '$(circle-slash)';
const ICON_OFFLINE = '$(error)';
const ICON_CONNECTING = '$(sync~spin)';

function withCount(label: string, pendingCount: number): string {
  return pendingCount > 0 ? `${label} ${pendingCount}` : label;
}

/** Tooltip suffix for pending gates, e.g. `（其中 2 个待审批门禁）`. */
function approvalSuffix(pendingApprovalCount: number | undefined): string {
  return pendingApprovalCount !== undefined && pendingApprovalCount > 0
    ? `（其中 ${pendingApprovalCount} 个待审批门禁）`
    : '';
}

function accessibilityLabel(label: string, pendingCount: number, extra = ''): string {
  return pendingCount > 0 ? `${label}，${pendingCount} 个待办${extra}` : label;
}

/**
 * Status-bar text/tooltip from the current connection + accepting + unread
 * state (docs/005 §2.2: 状态栏 = 连接状态 + 未读待办数，点击切换暂停接单).
 */
export function computeStatusBar(snapshot: PresenceSnapshot): StatusBarPresentation {
  const { connection, accepting, pendingCount, pendingApprovalCount } = snapshot;
  const gates = approvalSuffix(pendingApprovalCount);
  if (connection === 'paused' || (connection === 'online' && !accepting)) {
    return {
      text: `${ICON_PAUSED} ${withCount('已暂停', pendingCount)}`,
      tooltip: `已暂停接单：不会领取新任务，租约仍会续期${gates}。点击恢复接单。`,
      command: TOGGLE_ACCEPTING_COMMAND,
      accessibilityLabel: accessibilityLabel('已暂停接单', pendingCount, gates),
    };
  }
  switch (connection) {
    case 'online':
      return {
        text: `${ICON_ONLINE} ${withCount('在线', pendingCount)}`,
        tooltip:
          pendingCount > 0
            ? `已连接控制平面，有 ${pendingCount} 个待办${gates}。点击暂停接单。`
            : '已连接控制平面，正在等待任务。点击暂停接单。',
        command: TOGGLE_ACCEPTING_COMMAND,
        accessibilityLabel: accessibilityLabel('已连接控制平面', pendingCount, gates),
      };
    case 'connecting':
      return {
        text: `${ICON_CONNECTING} 连接中`,
        tooltip: '正在连接控制平面…',
        command: TOGGLE_ACCEPTING_COMMAND,
        accessibilityLabel: '正在连接控制平面',
      };
    case 'offline':
    default:
      return {
        text: `${ICON_OFFLINE} 离线`,
        tooltip: '未连接控制平面。点击暂停/恢复不会生效；请运行 “SAP Super Agent: 连接控制平面”。',
        command: TOGGLE_ACCEPTING_COMMAND,
        accessibilityLabel: '离线，尚未连接控制平面',
      };
  }
}

/**
 * Whether a failed control-plane call must stop the executor instead of being
 * retried (docs/005 §2.5, docs/009 failure #9):
 * - 401/403: token revoked/invalid — stop, ask the user to reconnect.
 * - 409: lease lost / stale state — stop claiming until the user refreshes.
 * - network error (status 0): the control plane is unreachable — stop rather
 *   than burn leases. `5xx`/`429` stay retryable.
 */
export function shouldStopOnError(error: unknown): boolean {
  if (error instanceof ControlPlaneError) {
    if (error.code === 'network_error') {
      return true;
    }
    return error.status === 401 || error.status === 403 || error.status === 409;
  }
  return false;
}

export interface HeartbeatDelayOptions {
  /** Base interval; defaults to 20s. */
  intervalMs?: number;
  /** Consecutive failures; `0` means a healthy beat. */
  failureCount?: number;
  /** Hard lower bound; defaults to 1s. */
  minMs?: number;
}

/**
 * Delay before the next heartbeat. Healthy beats use the 20s cadence; failed
 * retryable beats back off exponentially (capped) so a flaky control plane is
 * not hammered. Never returns less than `minMs` (default 1s).
 */
export function nextHeartbeatDelayMs(options: HeartbeatDelayOptions = {}): number {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const minMs = options.minMs ?? MIN_HEARTBEAT_DELAY_MS;
  const failures = Math.max(0, Math.trunc(options.failureCount ?? 0));
  const backoff = failures === 0 ? intervalMs : intervalMs * 2 ** Math.min(failures, 3);
  return Math.max(minMs, Math.min(backoff, MAX_HEARTBEAT_DELAY_MS));
}
