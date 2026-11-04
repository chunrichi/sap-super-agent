import { describe, expect, it } from 'vitest';
import {
  APPROVAL_STATES,
  ARTIFACT_KINDS,
  ARTIFACT_STATES,
  ASSIGNMENT_STATES,
  DEMAND_STATUSES,
  EVENT_TYPES,
  EXECUTOR_KINDS,
  PRESENCE_STATES,
  PRIORITIES,
  ROLES,
  STAGE_RUN_STATUSES,
  TASK_STATES,
  demandStatusSchema,
  executorKindSchema,
  roleSchema,
  taskStateSchema,
} from '../src/index.js';

describe('closed enums', () => {
  it('exposes the demand lifecycle from docs/003 §2.1', () => {
    expect(DEMAND_STATUSES).toEqual([
      'submitted',
      'in_progress',
      'review',
      'done',
      'cancelled',
      'rejected',
    ]);
  });

  it('rejects values outside the enum', () => {
    expect(demandStatusSchema.safeParse('finished').success).toBe(false);
    expect(taskStateSchema.safeParse('running').success).toBe(false);
    expect(executorKindSchema.safeParse('ci').success).toBe(false);
    expect(roleSchema.safeParse('admin').success).toBe(false);
  });

  it('keeps the stage/task/assignment/artifact/approval state sets closed', () => {
    expect(STAGE_RUN_STATUSES).toContain('waiting_human');
    expect(TASK_STATES).toContain('claimed');
    expect(ASSIGNMENT_STATES).toEqual(['active', 'completed', 'released', 'expired']);
    expect(ARTIFACT_STATES).toContain('superseded');
    expect(APPROVAL_STATES).toContain('withdrawn');
  });

  it('pins the six executor-visible enum families used on the wire', () => {
    expect(EXECUTOR_KINDS).toEqual(['vscode', 'server-ai']);
    expect(PRESENCE_STATES).toEqual(['online', 'busy', 'away', 'offline']);
    expect(ARTIFACT_KINDS).toContain('requirement_analysis');
    expect(ROLES).toEqual(['requester', 'consultant', 'developer', 'ops']);
    expect(PRIORITIES).toEqual(['high', 'normal', 'low']);
    expect(EVENT_TYPES).toContain('task.offered');
    expect(EVENT_TYPES).toContain('artifact.created');
  });
});
