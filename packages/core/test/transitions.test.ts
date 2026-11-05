import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TRANSITIONS,
  ARTIFACT_TRANSITIONS,
  ASSIGNMENT_TRANSITIONS,
  DEMAND_TRANSITIONS,
  InvalidTransitionError,
  STAGE_RUN_TRANSITIONS,
  assertDemandTransition,
  assertTaskTransition,
  canReturnTaskToPool,
  canTransitionApproval,
  canTransitionArtifact,
  canTransitionAssignment,
  canTransitionDemand,
  canTransitionStageRun,
  canTransitionTask,
  statusAfterFailedAttempt,
} from '../src/index.js';

describe('demand state machine (docs/003 §2.1)', () => {
  it('allows submitted -> in_progress -> review -> done', () => {
    expect(canTransitionDemand('submitted', 'in_progress')).toBe(true);
    expect(canTransitionDemand('in_progress', 'review')).toBe(true);
    expect(canTransitionDemand('review', 'done')).toBe(true);
  });

  it('allows rejection/cancel paths and review rollback', () => {
    expect(canTransitionDemand('submitted', 'rejected')).toBe(true);
    expect(canTransitionDemand('in_progress', 'cancelled')).toBe(true);
    expect(canTransitionDemand('review', 'cancelled')).toBe(true);
    expect(canTransitionDemand('review', 'in_progress')).toBe(true);
  });

  it('treats done/rejected/cancelled as terminal', () => {
    expect(DEMAND_TRANSITIONS.done).toEqual([]);
    expect(canTransitionDemand('done', 'in_progress')).toBe(false);
    expect(canTransitionDemand('submitted', 'done')).toBe(false);
    expect(canTransitionDemand('in_progress', 'rejected')).toBe(false);
  });

  it('throws a typed error on invalid transitions', () => {
    expect(() => assertDemandTransition('done', 'in_progress')).toThrow(InvalidTransitionError);
  });
});

describe('stage run state machine (docs/003 §2.2)', () => {
  it('covers the documented edges', () => {
    expect(canTransitionStageRun('pending', 'ready')).toBe(true);
    expect(canTransitionStageRun('ready', 'running')).toBe(true);
    expect(canTransitionStageRun('running', 'waiting_human')).toBe(true);
    expect(canTransitionStageRun('waiting_human', 'running')).toBe(true);
    expect(canTransitionStageRun('failed', 'ready')).toBe(true);
    expect(canTransitionStageRun('failed', 'waiting_human')).toBe(true);
    expect(canTransitionStageRun('pending', 'skipped')).toBe(true);
  });

  it('does not jump from pending straight to running', () => {
    expect(canTransitionStageRun('pending', 'running')).toBe(false);
    expect(STAGE_RUN_TRANSITIONS.done).toEqual([]);
  });

  it('maps failed attempts to retry or human handoff', () => {
    expect(statusAfterFailedAttempt(1, 2)).toBe('ready');
    expect(statusAfterFailedAttempt(2, 2)).toBe('waiting_human');
    expect(statusAfterFailedAttempt(3, 2)).toBe('waiting_human');
  });
});

describe('task + assignment state machines (docs/003 §2.3)', () => {
  it('covers claim/progress/complete/release', () => {
    expect(canTransitionTask('pending', 'claimed')).toBe(true);
    expect(canTransitionTask('claimed', 'in_progress')).toBe(true);
    expect(canTransitionTask('in_progress', 'completed')).toBe(true);
    expect(canTransitionTask('claimed', 'pending')).toBe(true);
    expect(canTransitionTask('in_progress', 'pending')).toBe(true);
  });

  it('rejects a second claim of a claimed task', () => {
    expect(canTransitionTask('claimed', 'claimed')).toBe(false);
    expect(canTransitionTask('completed', 'claimed')).toBe(false);
  });

  it('tracks pool return from claimed/in_progress only', () => {
    expect(canReturnTaskToPool('claimed')).toBe(true);
    expect(canReturnTaskToPool('in_progress')).toBe(true);
    expect(canReturnTaskToPool('pending')).toBe(false);
    expect(canReturnTaskToPool('completed')).toBe(false);
    expect(() => assertTaskTransition('completed', 'pending')).toThrow(InvalidTransitionError);
  });

  it('closes assignment transitions', () => {
    expect(canTransitionAssignment('active', 'completed')).toBe(true);
    expect(canTransitionAssignment('active', 'released')).toBe(true);
    expect(canTransitionAssignment('active', 'expired')).toBe(true);
    expect(canTransitionAssignment('expired', 'active')).toBe(false);
    expect(ASSIGNMENT_TRANSITIONS.active).toHaveLength(3);
  });
});

describe('artifact + approval state machines (docs/003 §2.4/2.5)', () => {
  it('moves artifacts through review and supersedes old versions', () => {
    expect(canTransitionArtifact('draft', 'generated')).toBe(true);
    expect(canTransitionArtifact('generated', 'in_review')).toBe(true);
    expect(canTransitionArtifact('in_review', 'approved')).toBe(true);
    expect(canTransitionArtifact('in_review', 'rejected')).toBe(true);
    expect(canTransitionArtifact('approved', 'superseded')).toBe(true);
    expect(ARTIFACT_TRANSITIONS.superseded).toEqual([]);
  });

  it('keeps approvals terminal once decided', () => {
    expect(canTransitionApproval('pending', 'approved')).toBe(true);
    expect(canTransitionApproval('pending', 'withdrawn')).toBe(true);
    expect(canTransitionApproval('pending', 'expired')).toBe(true);
    expect(canTransitionApproval('approved', 'rejected')).toBe(false);
    expect(APPROVAL_TRANSITIONS.pending).toHaveLength(4);
  });
});
