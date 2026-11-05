import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@sap-superagent/protocol';
import { FakeModelProvider } from '@sap-superagent/ai';
import { loadOrCreateStateSecret } from '../src/index.js';
import {
  api,
  createAdminTask,
  createDemandWithArtifact,
  heartbeat,
  readEvents,
  registerExecutor,
  startTestServer,
  waitFor,
  type TestServer,
} from './helpers.js';

function checksumOf(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function eventTypes(events: EventEnvelope[]): string[] {
  return events.map((event) => event.type);
}

interface DemandDetail {
  demand: { id: string; status: string };
  stages: Array<{ stageKey: string; status: string; outputArtifactId: string | null }>;
  artifacts: Array<{ id: string; kind: string; state: string; currentVersion: number }>;
  artifactVersions: Array<{
    artifactId: string;
    version: number;
    authorType: string;
    authorId: string;
    summary: string | null;
  }>;
  events: EventEnvelope[];
}

interface TaskDetail {
  task: { id: string; state: string; lastHolderUserIds?: string[] };
  artifacts: Array<{ id: string }>;
}

describe('control-plane REST surface', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.dispose();
  });

  it('serves health on /healthz and /api/v1/healthz without auth', async () => {
    const root = await api<{ status: string; aiProvider: string; mode: string }>(
      server,
      '/healthz',
    );
    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({ status: 'ok', aiProvider: 'fake', mode: 'm1' });
    const versioned = await api(server, '/api/v1/healthz');
    expect(versioned.status).toBe(200);
  });

  it('turns a demand into a schema-generated requirement_analysis artifact', async () => {
    const { demandId, artifactId } = await createDemandWithArtifact(server);
    const detail = await api<DemandDetail>(server, `/api/v1/demands/${demandId}`, {
      token: server.userToken,
    });
    expect(detail.status).toBe(200);
    const artifact = detail.body.artifacts[0];
    expect(artifact).toMatchObject({
      id: artifactId,
      kind: 'requirement_analysis',
      state: 'generated',
      currentVersion: 1,
    });
    const version = detail.body.artifactVersions[0];
    expect(version).toMatchObject({ artifactId, version: 1, authorType: 'ai', authorId: 'server-ai' });
    expect(version?.summary).toContain('R-9001');

    expect(detail.body.stages.map((stage) => stage.stageKey)).toEqual([
      'requirement_analysis',
      'dev_implementation',
      'acceptance_archive',
    ]);
    const requirementStage = detail.body.stages.find(
      (stage) => stage.stageKey === 'requirement_analysis',
    );
    expect(requirementStage).toMatchObject({ status: 'done', outputArtifactId: artifactId });
    const devStage = detail.body.stages.find((stage) => stage.stageKey === 'dev_implementation');
    expect(devStage?.status).toBe('ready');

    const types = eventTypes(detail.body.events);
    expect(types).toContain('demand.created');
    expect(types).toContain('stage.started');
    expect(types).toContain('artifact.created');
    expect(types).toContain('stage.done');

    const contents = readFileSync(join(server.stateDir, 'artifacts', artifactId, 'v1.bin'), 'utf8');
    expect(JSON.parse(contents)).toMatchObject({ summary: expect.stringContaining('R-9001') });
  });

  it('supports the executor lifecycle: heartbeats, claim, progress, artifact, complete', async () => {
    const { demandId } = await createDemandWithArtifact(server);
    const createdTask = await createAdminTask(server, {
      demandId,
      title: '实现取数逻辑',
      executorKind: 'vscode',
    });
    expect(createdTask.status).toBe(200);
    const taskId = createdTask.body.task.id;

    const executor = await registerExecutor(server, 'dev-a');
    const offlineClaim = await api(server, `/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      token: executor.token,
      body: {},
    });
    expect(offlineClaim.status).toBe(409);
    expect(offlineClaim.body).toMatchObject({
      error: { code: 'conflict', details: { reasons: expect.arrayContaining(['executor_offline']) } },
    });

    const beat = await heartbeat(server, executor);
    expect(beat.status).toBe(200);
    expect(beat.body.offers.map((offer) => offer.id)).toContain(taskId);

    const claim = await api<{
      task: { state: string };
      lease: { expiresAt: string; renewIntervalMs: number };
      contextUrl: string;
    }>(server, `/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      token: executor.token,
      body: {},
    });
    expect(claim.status).toBe(200);
    expect(claim.body.task.state).toBe('claimed');
    expect(claim.body.lease.renewIntervalMs).toBe(20_000);
    expect(claim.body.contextUrl).toBe(`/api/v1/tasks/${taskId}/context`);

    const context = await api<{
      markdown: string;
      json: { allowedActions: string[]; forbiddenActions: string[]; stage: unknown };
    }>(server, `/api/v1/tasks/${taskId}/context`, { token: executor.token });
    expect(context.status).toBe(200);
    expect(context.body.markdown).toContain('实现取数逻辑');
    expect(context.body.json.allowedActions).toContain('edit_workspace');
    expect(context.body.json.forbiddenActions).toContain('push_to_main');
    expect(context.body.json.stage).toBeNull();

    const progress = await api<{ ok: boolean }>(server, `/api/v1/tasks/${taskId}/progress`, {
      method: 'POST',
      token: executor.token,
      body: { percent: 40, message: 'reading demand' },
    });
    expect(progress.status).toBe(200);
    expect(progress.body.ok).toBe(true);

    const artifactContent = Buffer.from(JSON.stringify({ branch: 'feat/R-9001' }), 'utf8');
    const checksum = checksumOf(artifactContent);
    const submitted = await api<{
      artifact: { id: string; kind: string; state: string };
      version: { version: number; checksum: string; authorType: string };
      taskState: string;
    }>(server, `/api/v1/tasks/${taskId}/artifacts`, {
      method: 'POST',
      token: executor.token,
      body: {
        kind: 'code_change',
        contentType: 'application/json',
        contentBase64: artifactContent.toString('base64'),
        checksum,
        summary: 'branch feat/R-9001',
        title: 'code change',
      },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.artifact.state).toBe('generated');
    expect(submitted.body.taskState).toBe('in_progress');
    const storedBytes = readFileSync(
      join(server.stateDir, 'artifacts', submitted.body.artifact.id, 'v1.bin'),
    );
    expect(checksumOf(storedBytes)).toBe(checksum);

    const renewed = await api<{ lease: { expiresAt: string } }>(
      server,
      `/api/v1/tasks/${taskId}/lease/renew`,
      { method: 'POST', token: executor.token, body: {} },
    );
    expect(renewed.status).toBe(200);

    const completed = await api<{ task: { state: string } }>(
      server,
      `/api/v1/tasks/${taskId}/complete`,
      {
        method: 'POST',
        token: executor.token,
        body: { summary: 'implemented', artifactIds: [submitted.body.artifact.id], links: [] },
      },
    );
    expect(completed.status).toBe(200);
    expect(completed.body.task.state).toBe('completed');

    const detail = await api<TaskDetail>(server, `/api/v1/tasks/${taskId}`, {
      token: server.adminToken,
    });
    expect(detail.body.artifacts.map((artifact) => artifact.id)).toContain(
      submitted.body.artifact.id,
    );

    const timeline = await readEvents(server);
    expect(eventTypes(timeline.events)).toContain('task.progress');
    expect(eventTypes(timeline.events)).toContain('task.completed');
    expect(eventTypes(timeline.events)).toContain('assignment.completed');
  });

  it('rejects a second claim with 409 and the current holder summary', async () => {
    const { demandId } = await createDemandWithArtifact(server);
    const taskId = (
      await createAdminTask(server, { demandId, title: 'two executors', executorKind: 'vscode' })
    ).body.task.id;
    const first = await registerExecutor(server, 'dev-a');
    const second = await registerExecutor(server, 'dev-b');
    await heartbeat(server, first);
    await heartbeat(server, second);

    const claim = await api(server, `/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      token: first.token,
      body: {},
    });
    expect(claim.status).toBe(200);

    const doubleClaim = await api<{
      error: { code: string; details: { holder: { executorId: string } } };
    }>(server, `/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      token: second.token,
      body: {},
    });
    expect(doubleClaim.status).toBe(409);
    expect(doubleClaim.body.error.code).toBe('conflict');
    expect(doubleClaim.body.error.details.holder.executorId).toBe(first.executorId);

    const timeline = await readEvents(server);
    expect(timeline.events.filter((event) => event.type === 'task.claimed')).toHaveLength(1);
  });

  it('replays idempotent POST bodies for repeated Idempotency-Key headers', async () => {
    const { demandId } = await createDemandWithArtifact(server);
    const taskId = (
      await createAdminTask(server, { demandId, title: 'idempotent claim', executorKind: 'vscode' })
    ).body.task.id;
    const executor = await registerExecutor(server, 'dev-a');
    await heartbeat(server, executor);

    const first = await api<{ task: { id: string; state: string } }>(
      server,
      `/api/v1/tasks/${taskId}/claim`,
      { method: 'POST', token: executor.token, body: {}, headers: { 'idempotency-key': 'claim-1' } },
    );
    const replay = await api<{ task: { id: string; state: string } }>(
      server,
      `/api/v1/tasks/${taskId}/claim`,
      { method: 'POST', token: executor.token, body: {}, headers: { 'idempotency-key': 'claim-1' } },
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.get('idempotent-replay')).toBe('true');

    const timeline = await readEvents(server);
    expect(timeline.events.filter((event) => event.type === 'task.claimed')).toHaveLength(1);
  });

  it('returns an expired lease to the pool for another executor to claim', async () => {
    const { demandId } = await createDemandWithArtifact(server);
    const taskId = (
      await createAdminTask(server, { demandId, title: 'lease expiry', executorKind: 'vscode' })
    ).body.task.id;
    const first = await registerExecutor(server, 'dev-a');
    const second = await registerExecutor(server, 'dev-b');
    await heartbeat(server, first);
    const claim = await api(server, `/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      token: first.token,
      body: {},
    });
    expect(claim.status).toBe(200);

    const pending = await waitFor(
      async () => {
        await heartbeat(server, first);
        const detail = await api<{ task: { state: string } }>(
          server,
          `/api/v1/tasks/${taskId}`,
          { token: server.adminToken },
        );
        return detail.body.task.state === 'pending' ? detail.body.task : undefined;
      },
      { label: 'task back in the pool', timeoutMs: 4_000, intervalMs: 30 },
    );
    expect(pending.state).toBe('pending');

    const timeline = await readEvents(server);
    expect(eventTypes(timeline.events)).toContain('assignment.expired');

    await heartbeat(server, second);
    const reclaim = await api<{ task: { state: string } }>(
      server,
      `/api/v1/tasks/${taskId}/claim`,
      { method: 'POST', token: second.token, body: {} },
    );
    expect(reclaim.status).toBe(200);
    expect(reclaim.body.task.state).toBe('claimed');
  });

  it('requires resync when the event cursor fell outside the retention window', async () => {
    const resyncServer = await startTestServer({
      overrides: { eventRetentionMs: 40, heartbeatSweepMs: 15 },
    });
    try {
      await createDemandWithArtifact(resyncServer);
      const before = await readEvents(resyncServer);
      expect(before.lastSeq).toBeGreaterThan(1);
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));

      const stale = await api<{
        error: { code: string; details: { earliestSeq: number; lastSeq: number } };
      }>(resyncServer, '/api/v1/events?after=0', { token: resyncServer.userToken });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('resync_required');
      expect(stale.body.error.details.earliestSeq).toBeGreaterThan(1);

      const caughtUp = await api<{ events: EventEnvelope[]; lastSeq: number }>(
        resyncServer,
        `/api/v1/events?after=${before.lastSeq}`,
        { token: resyncServer.userToken },
      );
      expect(caughtUp.status).toBe(200);
      expect(caughtUp.body.events).toEqual([]);
      expect(caughtUp.body.lastSeq).toBe(before.lastSeq);
    } finally {
      await resyncServer.dispose();
    }
  });

  it('keeps demands, artifacts and events across a server restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sa-restart-'));
    const secret = loadOrCreateStateSecret(stateDir);
    try {
      const first = await startTestServer({ stateDir, secret });
      const { demandId, artifactId } = await createDemandWithArtifact(first);
      const before = await readEvents(first);
      await first.running.close();

      const second = await startTestServer({ stateDir, secret });
      try {
        const after = await readEvents(second, before.lastSeq);
        expect(after.lastSeq).toBe(before.lastSeq);
        expect(after.events).toEqual([]);

        const detail = await api<DemandDetail>(second, `/api/v1/demands/${demandId}`, {
          token: second.userToken,
        });
        expect(detail.status).toBe(200);
        expect(detail.body.artifacts[0]?.id).toBe(artifactId);
        expect(detail.body.events.length).toBe(before.events.length);

        const replay = await api<{ events: EventEnvelope[] }>(second, '/api/v1/events?after=0', {
          token: second.userToken,
        });
        expect(replay.status).toBe(200);
        expect(replay.body.events[0]?.seq).toBe(1);
      } finally {
        await second.running.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('cancels a demand and its pending work', async () => {
    const { demandId } = await createDemandWithArtifact(server);
    const taskId = (
      await createAdminTask(server, { demandId, title: 'cancel me', executorKind: 'vscode' })
    ).body.task.id;

    const cancelled = await api<{ demand: { status: string } }>(
      server,
      `/api/v1/demands/${demandId}/cancel`,
      { method: 'POST', token: server.userToken, body: { reason: 'duplicate demand' } },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.demand.status).toBe('cancelled');

    const task = await api<TaskDetail>(server, `/api/v1/tasks/${taskId}`, {
      token: server.adminToken,
    });
    expect(task.body.task.state).toBe('cancelled');

    const detail = await api<DemandDetail>(server, `/api/v1/demands/${demandId}`, {
      token: server.userToken,
    });
    const devStage = detail.body.stages.find((stage) => stage.stageKey === 'dev_implementation');
    expect(devStage?.status).toBe('cancelled');

    const types = eventTypes(detail.body.events);
    expect(types).toContain('demand.cancelled');
    expect(types).toContain('stage.cancelled');
    expect(types).toContain('task.cancelled');

    const again = await api<{ error: { code: string } }>(
      server,
      `/api/v1/demands/${demandId}/cancel`,
      { method: 'POST', token: server.userToken, body: {} },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('invalid_state');
  });

  it('releases active assignments when an executor unregisters', async () => {
    const { demandId } = await createDemandWithArtifact(server);
    const taskId = (
      await createAdminTask(server, { demandId, title: 'unregister', executorKind: 'vscode' })
    ).body.task.id;
    const executor = await registerExecutor(server, 'dev-a');
    await heartbeat(server, executor);
    const claim = await api(server, `/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      token: executor.token,
      body: {},
    });
    expect(claim.status).toBe(200);

    const unregister = await api<{ releasedTaskIds: string[] }>(
      server,
      `/api/v1/executors/${executor.executorId}`,
      { method: 'DELETE', token: executor.token },
    );
    expect(unregister.status).toBe(200);
    expect(unregister.body.releasedTaskIds).toEqual([taskId]);

    const detail = await api<TaskDetail>(server, `/api/v1/tasks/${taskId}`, {
      token: server.adminToken,
    });
    expect(detail.body.task.state).toBe('pending');
    expect(detail.body.task.lastHolderUserIds).toEqual(['dev-a']);
  });

  it('retries a failing AI stage and then parks it for a human', async () => {
    const failing = await startTestServer({
      overrides: { aiProvider: new FakeModelProvider({ responses: ['not json', 'still not json'] }) },
    });
    try {
      const created = await api<{ demand: { id: string } }>(failing, '/api/v1/demands', {
        method: 'POST',
        token: failing.userToken,
        body: {
          title: 'R-9004 broken stage',
          description: 'model keeps returning junk',
          acceptanceCriteria: [],
          priority: 'normal',
          requester: { userId: 'DEV001' },
        },
      });
      const demandId = created.body.demand.id;
      await waitFor(
        async () => {
          const detail = await api<DemandDetail>(failing, `/api/v1/demands/${demandId}`, {
            token: failing.userToken,
          });
          const stage = detail.body.stages.find(
            (candidate) => candidate.stageKey === 'requirement_analysis',
          );
          return stage?.status === 'waiting_human' ? stage : undefined;
        },
        { label: 'stage waiting_human', timeoutMs: 5_000 },
      );
      const detail = await api<DemandDetail>(failing, `/api/v1/demands/${demandId}`, {
        token: failing.userToken,
      });
      expect(detail.body.artifacts).toEqual([]);
      const types = eventTypes(detail.body.events);
      expect(types.filter((type) => type === 'stage.failed')).toHaveLength(2);
      expect(types).toContain('stage.waiting_human');
    } finally {
      await failing.dispose();
    }
  });

  it('maps unknown routes and bad input onto the docs/003 error envelope', async () => {
    const missingRoute = await api<{ error: { code: string } }>(server, '/api/v1/does-not-exist');
    expect(missingRoute.status).toBe(404);
    expect(missingRoute.body.error.code).toBe('not_found');

    const noToken = await api<{ error: { code: string; retryable: boolean } }>(
      server,
      '/api/v1/demands',
    );
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toMatchObject({ code: 'unauthorized', retryable: false });

    const badBody = await api<{ error: { code: string } }>(server, '/api/v1/demands', {
      method: 'POST',
      token: server.userToken,
      body: { title: '' },
    });
    expect(badBody.status).toBe(400);
    expect(badBody.body.error.code).toBe('bad_request');
  });
});
