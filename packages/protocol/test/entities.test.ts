import { describe, expect, it } from 'vitest';
import {
  artifactVersionSchema,
  demandSchema,
  executorSchema,
  stageAttemptSchema,
  taskSchema,
} from '../src/index.js';
import {
  CHECKSUM,
  DEMAND_ID,
  NOW,
  ULID_A,
  ULID_B,
  validArtifactVersion,
  validDemand,
  validTask,
} from './fixtures.js';

describe('demand entity', () => {
  it('accepts a local demand fixture', () => {
    expect(demandSchema.safeParse(validDemand).success).toBe(true);
  });

  it('accepts an unbound demand (workspaceBinding: null)', () => {
    const parsed = demandSchema.safeParse({ ...validDemand, workspaceBinding: null });
    expect(parsed.success).toBe(true);
  });

  it('rejects non-C32 demand ids', () => {
    expect(demandSchema.safeParse({ ...validDemand, id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects unknown keys (schema is a contract, not an open bag)', () => {
    expect(demandSchema.safeParse({ ...validDemand, extra: true }).success).toBe(false);
  });

  it('rejects empty acceptance criterion strings', () => {
    expect(demandSchema.safeParse({ ...validDemand, acceptanceCriteria: [''] }).success).toBe(false);
  });
});

describe('task entity', () => {
  it('accepts the docs/003 §2.3 example shape', () => {
    expect(taskSchema.safeParse(validTask).success).toBe(true);
  });

  it('accepts a general-inbox task with no binding', () => {
    expect(taskSchema.safeParse({ ...validTask, workspaceBinding: null }).success).toBe(true);
  });

  it('keeps at most three last holders', () => {
    expect(
      taskSchema.safeParse({ ...validTask, lastHolderUserIds: ['a', 'b', 'c'] }).success,
    ).toBe(true);
    expect(
      taskSchema.safeParse({ ...validTask, lastHolderUserIds: ['a', 'b', 'c', 'd'] }).success,
    ).toBe(false);
  });

  it('rejects workspace binding objects without repo', () => {
    expect(
      taskSchema.safeParse({ ...validTask, workspaceBinding: { projectKey: 'X' } }).success,
    ).toBe(false);
  });
});

describe('artifact version entity', () => {
  it('requires a sha256 checksum', () => {
    expect(artifactVersionSchema.safeParse(validArtifactVersion).success).toBe(true);
    expect(
      artifactVersionSchema.safeParse({ ...validArtifactVersion, checksum: 'md5:abc' }).success,
    ).toBe(false);
  });

  it('keeps the checksum pattern anchored at 64 hex chars', () => {
    expect(
      artifactVersionSchema.safeParse({ ...validArtifactVersion, checksum: CHECKSUM.slice(0, -1) })
        .success,
    ).toBe(false);
  });

  it('requires a stale flag so downstream invalidation is explicit', () => {
    const { stale: _stale, ...withoutStale } = validArtifactVersion;
    expect(artifactVersionSchema.safeParse(withoutStale).success).toBe(false);
  });
});

describe('run ledger + executor', () => {
  it('rejects negative token counts in stage attempts', () => {
    const attempt = {
      stageRunId: ULID_A,
      attempt: 1,
      model: 'fake',
      promptVersion: 'requirement-analysis/v1',
      inputRefs: [],
      schemaOk: true,
      tokens: -1,
      costUsd: 0,
      durationMs: 12,
      error: null,
      startedAt: NOW,
      finishedAt: NOW,
    };
    expect(stageAttemptSchema.safeParse(attempt).success).toBe(false);
  });

  it('rejects server-ai executors that claim a user token', () => {
    const executor = {
      id: ULID_B,
      kind: 'vscode',
      user: 'DEV001',
      machineIdHash: null,
      capabilities: ['coding'],
      roles: ['developer'],
      workspaces: [{ workspaceKey: 'abc', repo: 'z-sales' }],
      presence: 'online',
      accepting: true,
      maxConcurrent: 2,
      protocolVersion: '1.0.0',
      cliVersion: '0.0.0',
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(executorSchema.safeParse(executor).success).toBe(true);
    expect(executorSchema.safeParse({ ...executor, presence: 'idle' }).success).toBe(false);
    expect(executorSchema.safeParse({ ...executor, id: DEMAND_ID }).success).toBe(false);
  });
});
