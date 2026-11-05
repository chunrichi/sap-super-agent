import { describe, expect, it } from 'vitest';
import {
  bindingMatches,
  evaluateClaimEligibility,
  isLeaseExpired,
  isPresenceExpired,
  leaseExpiresAtIso,
  rankTasks,
  shouldOfferTask,
  type ClaimEligibilityInput,
} from '../src/index.js';
import {
  NOW,
  boundTask,
  serverAiExecutor,
  serverAiTask,
  unboundTask,
  vscodeExecutor,
} from './fixtures.js';

const NOW_MS = Date.parse(NOW);

function rankable(
  id: string,
  priority: 'high' | 'normal' | 'low',
  dueAt: string | null,
  createdAt: string,
  lastHolderUserIds: string[] = [],
): {
  id: string;
  priority: 'high' | 'normal' | 'low';
  dueAt: string | null;
  createdAt: string;
  lastHolderUserIds: string[];
} {
  return { id, priority, dueAt, createdAt, lastHolderUserIds };
}

function eligibility(overrides: Partial<ClaimEligibilityInput> = {}): ClaimEligibilityInput {
  return {
    task: boundTask,
    executor: vscodeExecutor,
    activeWorkspaceKey: 'wk-z-sales',
    nowMs: NOW_MS,
    presenceTtlMs: 60_000,
    lastHeartbeatAt: NOW,
    activeAssignmentsForExecutor: 0,
    activeAssignmentsForSameDemand: 0,
    globallyPaused: false,
    ...overrides,
  };
}

describe('claim eligibility (docs/003 §3)', () => {
  it('accepts an online, qualified executor with the workspace open', () => {
    const result = evaluateClaimEligibility(eligibility());
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects a task that is not pending', () => {
    const result = evaluateClaimEligibility(eligibility({ task: { ...boundTask, state: 'claimed' } }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('task_not_pending');
  });

  it('rejects kind, role and paused mismatches', () => {
    expect(
      evaluateClaimEligibility(eligibility({ executor: serverAiExecutor })).reasons,
    ).toContain('executor_kind_mismatch');
    expect(
      evaluateClaimEligibility(eligibility({ task: { ...boundTask, requiredRoles: ['consultant'] } }))
        .reasons,
    ).toContain('role_mismatch');
    expect(evaluateClaimEligibility(eligibility({ globallyPaused: true })).reasons).toContain(
      'server_paused',
    );
  });

  it('rejects a bound task when the open workspace does not match', () => {
    expect(
      evaluateClaimEligibility(eligibility({ activeWorkspaceKey: 'wk-other' })).reasons,
    ).toContain('workspace_mismatch');
    expect(
      evaluateClaimEligibility(eligibility({ activeWorkspaceKey: null })).reasons,
    ).toContain('workspace_mismatch');
  });

  it('lets unbound tasks reach the general inbox from any workspace', () => {
    expect(
      evaluateClaimEligibility(eligibility({ task: unboundTask, activeWorkspaceKey: null })).eligible,
    ).toBe(true);
  });

  it('rejects offline/paused/at-capacity/duplicated-by-demand executors', () => {
    expect(
      evaluateClaimEligibility(eligibility({ lastHeartbeatAt: '2026-11-04T23:00:00.000Z' })).reasons,
    ).toContain('executor_offline');
    expect(
      evaluateClaimEligibility(eligibility({ executor: { ...vscodeExecutor, accepting: false } }))
        .reasons,
    ).toContain('executor_not_accepting');
    expect(
      evaluateClaimEligibility(eligibility({ activeAssignmentsForExecutor: 2 })).reasons,
    ).toContain('executor_at_capacity');
    expect(
      evaluateClaimEligibility(eligibility({ activeAssignmentsForSameDemand: 1 })).reasons,
    ).toContain('same_demand_already_held');
  });

  it('ignores presence/workspace for server-ai tasks', () => {
    const result = evaluateClaimEligibility(
      eligibility({
        task: serverAiTask,
        executor: serverAiExecutor,
        activeWorkspaceKey: null,
        lastHeartbeatAt: null,
      }),
    );
    expect(result.eligible).toBe(true);
  });
});

describe('workspace binding matching', () => {
  it('matches repo/projectKey/baseBranch subsets', () => {
    expect(
      bindingMatches({ repo: 'z-sales' }, vscodeExecutor.workspaces, 'wk-z-sales'),
    ).toBe(true);
    expect(
      bindingMatches({ repo: 'z-fin' }, vscodeExecutor.workspaces, 'wk-z-sales'),
    ).toBe(false);
    expect(
      bindingMatches(
        { repo: 'z-sales', projectKey: 'OTHER' },
        vscodeExecutor.workspaces,
        'wk-z-sales',
      ),
    ).toBe(false);
    expect(bindingMatches(null, vscodeExecutor.workspaces, null)).toBe(true);
  });
});

describe('lease + presence clocks', () => {
  it('computes lease expiry from server time only', () => {
    const expiresAt = leaseExpiresAtIso(NOW_MS, 60_000);
    expect(expiresAt).toBe('2026-11-05T00:01:00.000Z');
    expect(isLeaseExpired(expiresAt, NOW_MS)).toBe(false);
    expect(isLeaseExpired(expiresAt, NOW_MS + 60_001)).toBe(true);
    expect(isLeaseExpired(null, NOW_MS)).toBe(true);
  });

  it('expires presence after TTL', () => {
    expect(isPresenceExpired(NOW, NOW_MS, 60_000)).toBe(false);
    expect(isPresenceExpired(NOW, NOW_MS + 60_001, 60_000)).toBe(true);
    expect(isPresenceExpired(null, NOW_MS, 60_000)).toBe(true);
  });
});

describe('offer + ranking', () => {
  it('offers pending tasks to matching executors only', () => {
    const base = eligibility() as Parameters<typeof shouldOfferTask>[0];
    expect(shouldOfferTask(base)).toBe(true);
    expect(
      shouldOfferTask({ ...base, task: { ...boundTask, state: 'completed' } }),
    ).toBe(false);
  });

  it('ranks priority desc, dueAt asc, createdAt asc', () => {
    const tasks = [
      rankable('a', 'normal', '2026-11-06T00:00:00.000Z', '2026-11-05T00:00:00.000Z'),
      rankable('b', 'high', null, '2026-11-05T02:00:00.000Z'),
      rankable('c', 'normal', '2026-11-05T12:00:00.000Z', '2026-11-05T01:00:00.000Z'),
      rankable('d', 'high', null, '2026-11-05T01:00:00.000Z'),
    ];
    expect(rankTasks(tasks).map((task) => task.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('down-weights tasks the viewer recently released instead of excluding them', () => {
    const tasks = [
      rankable('fresh', 'normal', null, '2026-11-05T00:00:00.000Z', []),
      rankable('released', 'normal', null, '2026-11-05T00:00:00.000Z', ['DEV001', 'DEV002']),
    ];
    // Same priority/due/date: the recent holder sees its released task second...
    expect(rankTasks(tasks, { forUserId: 'DEV001' }).map((task) => task.id)).toEqual([
      'fresh',
      'released',
    ]);
    // ...but the task is still offered (soft penalty) and other users are unaffected.
    expect(rankTasks(tasks, { forUserId: 'DEV002' })[0]?.id).toBe('fresh');
    expect(rankTasks(tasks, { forUserId: 'DEV999' }).map((task) => task.id)).toEqual([
      'fresh',
      'released',
    ]);
    expect(rankTasks(tasks, { forUserId: 'DEV001' })).toHaveLength(2);
  });
});
