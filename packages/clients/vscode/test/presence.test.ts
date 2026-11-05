import { describe, expect, it } from 'vitest';
import { ControlPlaneError } from '../src/client.js';
import {
  HEARTBEAT_INTERVAL_MS,
  MIN_HEARTBEAT_DELAY_MS,
  computeStatusBar,
  nextHeartbeatDelayMs,
  shouldStopOnError,
} from '../src/presence.js';

describe('computeStatusBar', () => {
  it('shows online with the pending count', () => {
    const presentation = computeStatusBar({ connection: 'online', accepting: true, pendingCount: 3 });
    expect(presentation.text).toBe('$(circle-filled) 在线 3');
    expect(presentation.tooltip).toContain('3 个待办');
    expect(presentation.command).toBe('sapSuperAgent.toggleAccepting');
  });

  it('omits the count when there is nothing to do', () => {
    expect(computeStatusBar({ connection: 'online', accepting: true, pendingCount: 0 }).text).toBe(
      '$(circle-filled) 在线',
    );
  });

  it('renders paused when accepting is off, even while online', () => {
    const presentation = computeStatusBar({ connection: 'online', accepting: false, pendingCount: 2 });
    expect(presentation.text).toBe('$(circle-slash) 已暂停 2');
    expect(presentation.tooltip).toContain('恢复接单');
  });

  it('renders the paused connection state as paused', () => {
    expect(computeStatusBar({ connection: 'paused', accepting: true, pendingCount: 0 }).text).toBe(
      '$(circle-slash) 已暂停',
    );
  });

  it('renders offline and connecting states', () => {
    expect(computeStatusBar({ connection: 'offline', accepting: true, pendingCount: 0 }).text).toBe(
      '$(error) 离线',
    );
    expect(computeStatusBar({ connection: 'connecting', accepting: true, pendingCount: 0 }).text).toBe(
      '$(sync~spin) 连接中',
    );
  });

  it('mentions pending gates in the tooltip without changing the text', () => {
    const presentation = computeStatusBar({
      connection: 'online',
      accepting: true,
      pendingCount: 4,
      pendingApprovalCount: 2,
    });
    expect(presentation.text).toBe('$(circle-filled) 在线 4');
    expect(presentation.tooltip).toContain('4 个待办');
    expect(presentation.tooltip).toContain('其中 2 个待审批门禁');
    // Click behavior stays the documented invariant (toggle accepting).
    expect(presentation.tooltip).toContain('点击暂停接单');
    expect(presentation.command).toBe('sapSuperAgent.toggleAccepting');
  });

  it('omits the gate hint when no gate is pending', () => {
    const presentation = computeStatusBar({
      connection: 'online',
      accepting: false,
      pendingCount: 2,
      pendingApprovalCount: 0,
    });
    expect(presentation.tooltip).not.toContain('待审批门禁');
    expect(presentation.tooltip).toContain('恢复接单');
  });

  it('exposes a codicon-free label for screen readers', () => {
    const online = computeStatusBar({ connection: 'online', accepting: true, pendingCount: 3 });
    expect(online.accessibilityLabel).toBe('已连接控制平面，3 个待办');
    expect(online.accessibilityLabel).not.toContain('$(');
    expect(computeStatusBar({ connection: 'offline', accepting: true, pendingCount: 0 }).accessibilityLabel).toBe(
      '离线，尚未连接控制平面',
    );
    expect(
      computeStatusBar({ connection: 'paused', accepting: true, pendingCount: 1 }).accessibilityLabel,
    ).toBe('已暂停接单，1 个待办');
  });
});

describe('shouldStopOnError', () => {
  const error = (status: number, code: ControlPlaneError['code']): ControlPlaneError =>
    new ControlPlaneError('boom', { status, code });

  it('stops on revoked auth (401/403)', () => {
    expect(shouldStopOnError(error(401, 'unauthorized'))).toBe(true);
    expect(shouldStopOnError(error(403, 'forbidden'))).toBe(true);
  });

  it('stops on lease/task conflicts (409)', () => {
    expect(shouldStopOnError(error(409, 'conflict'))).toBe(true);
    expect(shouldStopOnError(error(409, 'lease_expired'))).toBe(true);
  });

  it('stops when the control plane is unreachable', () => {
    expect(shouldStopOnError(error(0, 'network_error'))).toBe(true);
  });

  it('keeps retrying transient server/rate-limit failures', () => {
    expect(shouldStopOnError(error(500, 'internal_error'))).toBe(false);
    expect(shouldStopOnError(error(503, 'internal_error'))).toBe(false);
    expect(shouldStopOnError(error(429, 'rate_limited'))).toBe(false);
  });

  it('does not treat arbitrary exceptions as stop conditions', () => {
    expect(shouldStopOnError(new Error('boom'))).toBe(false);
    expect(shouldStopOnError(undefined)).toBe(false);
  });
});

describe('nextHeartbeatDelayMs', () => {
  it('defaults to the 20s cadence', () => {
    expect(nextHeartbeatDelayMs()).toBe(HEARTBEAT_INTERVAL_MS);
    expect(nextHeartbeatDelayMs()).toBe(20_000);
  });

  it('backs off exponentially on consecutive failures', () => {
    expect(nextHeartbeatDelayMs({ failureCount: 1 })).toBe(40_000);
    expect(nextHeartbeatDelayMs({ failureCount: 2 })).toBe(60_000);
  });

  it('never returns less than 1s', () => {
    expect(nextHeartbeatDelayMs({ intervalMs: 0 })).toBe(MIN_HEARTBEAT_DELAY_MS);
    expect(nextHeartbeatDelayMs({ intervalMs: 10, minMs: 1_000 })).toBe(1_000);
  });

  it('caps the retry backoff at 60s', () => {
    expect(nextHeartbeatDelayMs({ failureCount: 10 })).toBe(60_000);
  });
});
