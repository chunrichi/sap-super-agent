import { describe, expect, it } from 'vitest';
import {
  ERROR_HTTP_STATUS,
  apiErrorBodySchema,
  completeTaskBodySchema,
  createDemandBodySchema,
  errorBody,
  healthResponseSchema,
  httpStatusForError,
  registerExecutorBodySchema,
  submitArtifactBodySchema,
  transferTaskBodySchema,
  transferTaskResponseSchema,
} from '../src/index.js';
import { CHECKSUM, DEMAND_ID, NOW, ULID_A, ULID_B } from './fixtures.js';

describe('error envelope (docs/003 §4.1)', () => {
  it('builds the documented shape', () => {
    expect(errorBody('lease_expired', 'lease expired')).toEqual({
      error: { code: 'lease_expired', message: 'lease expired', retryable: false },
    });
  });

  it('keeps details optional and retryable explicit', () => {
    const body = errorBody('conflict', 'already claimed', {
      retryable: true,
      details: { holder: 'exec_1' },
    });
    expect(apiErrorBodySchema.parse(body).error.details).toEqual({ holder: 'exec_1' });
    expect(apiErrorBodySchema.safeParse(body).success).toBe(true);
  });

  it('maps codes to HTTP statuses', () => {
    expect(httpStatusForError('resync_required')).toBe(409);
    expect(httpStatusForError('unauthorized')).toBe(401);
    expect(ERROR_HTTP_STATUS.internal_error).toBe(500);
  });

  it('rejects unknown codes', () => {
    expect(
      apiErrorBodySchema.safeParse({ error: { code: 'boom', message: 'x', retryable: false } })
        .success,
    ).toBe(false);
  });
});

describe('create demand body', () => {
  it('applies defaults for acceptance criteria and priority', () => {
    const parsed = createDemandBodySchema.parse({
      title: '取数',
      description: '按组织汇总',
      requester: { userId: 'DEV001' },
    });
    expect(parsed.priority).toBe('normal');
    expect(parsed.acceptanceCriteria).toEqual([]);
  });

  it('requires a requester and non-empty title', () => {
    expect(
      createDemandBodySchema.safeParse({ title: '', description: 'x', requester: { userId: 'u' } })
        .success,
    ).toBe(false);
    expect(
      createDemandBodySchema.safeParse({ title: 'x', description: 'x' }).success,
    ).toBe(false);
  });
});

describe('executor registration body', () => {
  it('defaults capability/role/workspace lists', () => {
    const parsed = registerExecutorBodySchema.parse({
      kind: 'vscode',
      user: 'DEV001',
      protocolVersion: '1.0.0',
    });
    expect(parsed.roles).toEqual([]);
    expect(parsed.workspaces).toEqual([]);
  });

  it('rejects a non-workspace scope for vscode executors', () => {
    expect(
      registerExecutorBodySchema.safeParse({
        kind: 'vscode',
        user: 'DEV001',
        protocolVersion: '1.0.0',
        workspaces: [{ repo: 'z-sales' }],
      }).success,
    ).toBe(false);
  });
});

describe('artifact submission body', () => {
  const base = {
    kind: 'code_change',
    contentType: 'text/plain',
    checksum: CHECKSUM,
  };

  it('accepts exactly one content source', () => {
    expect(submitArtifactBodySchema.safeParse({ ...base, contentBase64: 'aGk=' }).success).toBe(
      true,
    );
  });

  it('rejects both and neither content source', () => {
    expect(
      submitArtifactBodySchema.safeParse({ ...base, contentBase64: 'aGk=', contentUrl: 'https://x' })
        .success,
    ).toBe(false);
    expect(submitArtifactBodySchema.safeParse(base).success).toBe(false);
  });

  it('rejects non-url contentUrl', () => {
    expect(
      submitArtifactBodySchema.safeParse({ ...base, contentUrl: 'not-a-url' }).success,
    ).toBe(false);
  });
});

describe('complete task body', () => {
  it('defaults artifact links and open questions', () => {
    const parsed = completeTaskBodySchema.parse({ summary: 'done' });
    expect(parsed).toEqual({ summary: 'done', artifactIds: [], links: [], openQuestions: [] });
  });
});

describe('health response', () => {
  it('pins the local mode contract', () => {
    const health = healthResponseSchema.parse({
      status: 'ok',
      version: '0.0.0',
      uptimeMs: 12,
      serverTime: NOW,
      aiProvider: 'fake',
      persistence: 'sqlite',
      mode: 'm1',
    });
    expect(health.status).toBe('ok');
  });
});

describe('task transfer body (docs/003 §2.3/§4.2, S3)', () => {
  it('accepts exactly one target: a user or a role pool', () => {
    expect(transferTaskBodySchema.safeParse({ targetUserId: 'DEV002' }).success).toBe(true);
    expect(transferTaskBodySchema.safeParse({ targetRole: 'developer' }).success).toBe(true);
    expect(
      transferTaskBodySchema.safeParse({ targetRole: 'developer', comment: '交给 ABAP 同事' })
        .success,
    ).toBe(true);
  });

  it('rejects both targets and no target', () => {
    expect(
      transferTaskBodySchema.safeParse({ targetUserId: 'DEV002', targetRole: 'developer' })
        .success,
    ).toBe(false);
    expect(transferTaskBodySchema.safeParse({ comment: 'no target' }).success).toBe(false);
    expect(transferTaskBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown roles and oversized comments', () => {
    expect(transferTaskBodySchema.safeParse({ targetRole: 'tester' }).success).toBe(false);
    expect(
      transferTaskBodySchema.safeParse({ targetUserId: 'DEV002', comment: 'x'.repeat(2_001) })
        .success,
    ).toBe(false);
  });

  it('parses the transfer response with its audit record', () => {
    const response = transferTaskResponseSchema.parse({
      task: {
        id: ULID_A,
        demandId: DEMAND_ID,
        stageRunId: null,
        title: '取数实现',
        executorKind: 'vscode',
        requiredRoles: ['developer'],
        workspaceBinding: null,
        priority: 'normal',
        dueAt: null,
        state: 'pending',
        lastHolderUserIds: ['DEV001'],
        createdAt: NOW,
        updatedAt: NOW,
      },
      transfer: {
        id: ULID_B,
        taskId: ULID_A,
        assignmentId: ULID_B,
        fromExecutorId: ULID_A,
        fromUserId: 'DEV001',
        targetUserId: 'DEV002',
        targetRole: null,
        comment: null,
        createdAt: NOW,
      },
      serverTime: NOW,
    });
    expect(response.transfer.targetUserId).toBe('DEV002');
  });
});
