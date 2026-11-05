import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeRequirementAnalysisOutput, type ChatMessage } from '@sap-superagent/ai';
import type { EventEnvelope, SapAiJobPayload } from '@sap-superagent/protocol';
import { sapAiJobPayloadSchema } from '@sap-superagent/protocol';
import { createDemand, getDemandDetail, waitFor, waitForStageStatus, type DemandDetailLike } from './helpers.js';
import {
  SAP_HOOK_SECRET,
  claimJob,
  countRows,
  deleteJobRows,
  events,
  eventsOfType,
  forceJobState,
  getJobRow,
  heartbeatJob,
  listJobRows,
  nextJobs,
  requeueJob,
  sapStatus,
  sendJobResult,
  signedSapRequest,
  startSapTestServer,
  waitForNoQueuedJobs,
  waitForQueuedJob,
  withStateDb,
  type CountingProvider,
  type SapAiJobRow,
  type SapTestServer,
} from './sap-ai-helpers.js';

// ---------------------------------------------------------------------------
// S5 server integration tests: SAP-hosted batch AI executor (docs/003 §4.8,
// handoffs/S5-sap-hosted-mode.md §1.2/§1.6, docs/009 #17/#18).
//
// The control plane keeps the state machine / validation / gates; SAP only
// fetches the rendered prompt, claims the job, heartbeats and posts the raw
// model output back over the HMAC `X-SA-*` transport.
// ---------------------------------------------------------------------------

const DEMAND_TITLE = 'R-9001 默认模板需求';
const DEMAND_MESSAGES: ChatMessage[] = [
  {
    role: 'user',
    content: `<demand-json>${JSON.stringify({
      title: DEMAND_TITLE,
      description: '按销售组织汇总开票金额，空结果返回 0',
      acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
    })}</demand-json>`,
  },
];
/** Schema-valid requirement_analysis output a SAP batch worker would send back. */
const VALID_OUTPUT = fakeRequirementAnalysisOutput(DEMAND_MESSAGES);

const servers: SapTestServer[] = [];
const tempDirs: string[] = [];

async function startServer(
  options: Parameters<typeof startSapTestServer>[0] = {},
): Promise<SapTestServer> {
  const server = await startSapTestServer(options);
  servers.push(server);
  return server;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-sap-ai-jobs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await server.dispose();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function providerCalls(server: SapTestServer): number {
  return (server.provider as CountingProvider).calls;
}

function stageByKey(detail: DemandDetailLike, stageKey: string): DemandDetailLike['stages'][number] {
  const stage = detail.stages.find((candidate) => candidate.stageKey === stageKey);
  if (stage === undefined) throw new Error(`stage ${stageKey} missing from demand detail`);
  return stage;
}

async function waitForJobRow(
  server: SapTestServer,
  jobId: string,
  state: SapAiJobRow['state'],
  timeoutMs = 8_000,
): Promise<SapAiJobRow> {
  return waitFor(
    async () => {
      const row = getJobRow(server, jobId);
      return row?.state === state ? row : undefined;
    },
    { label: `SAP AI job ${jobId} -> ${state}`, timeoutMs },
  );
}

/** create a demand and wait until the SAP batch mode enqueued its first job. */
async function createDemandAndJob(
  server: SapTestServer,
): Promise<{ demandId: string; job: Awaited<ReturnType<typeof waitForQueuedJob>> }> {
  const created = await createDemand(server);
  const job = await waitForQueuedJob(server, (candidate) => candidate.demandId === created.id);
  return { demandId: created.id, job };
}

function completedEvent(list: readonly EventEnvelope[]): EventEnvelope[] {
  return eventsOfType(list, 'stage.ai_job.completed');
}

function failedEvents(list: readonly EventEnvelope[]): EventEnvelope[] {
  return eventsOfType(list, 'stage.ai_job.failed');
}

function queuedEvents(list: readonly EventEnvelope[]): EventEnvelope[] {
  return eventsOfType(list, 'stage.ai_job.queued');
}

function claimedEvents(list: readonly EventEnvelope[]): EventEnvelope[] {
  return eventsOfType(list, 'stage.ai_job.claimed');
}

// ---------------------------------------------------------------------------
// 1) Default off: H0–S4 behaviour is untouched.
// ---------------------------------------------------------------------------

describe('SAP batch mode default off (docs/003 §4.8)', () => {
  it('keeps the local provider path and does not register the SAP job API or write jobs', async () => {
    const server = await startServer({ sapAiBatch: false });
    const created = await createDemand(server);
    const detail = await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    expect(stageByKey(detail, 'requirement_analysis').outputArtifactId).toBeTruthy();
    expect(providerCalls(server)).toBe(1);

    // SAP → control-plane job API is not registered, even with valid HMAC headers.
    const next = await nextJobs(server);
    expect(next.status).toBe(404);
    const requeue = await signedSapRequest<Record<string, unknown>>(
      server,
      '/api/v1/admin/sap/ai-jobs/01J8ZQ9W3K5M2V7X4C6B8N0P1Q/requeue',
      {},
    );
    expect(requeue.status).toBe(404);

    // /hooks/sap/status keeps its H0–S4 behaviour (no SAP config -> no route).
    const status = await sapStatus(server);
    expect(status.status).toBe(404);

    // No jobs, no job events.
    expect(listJobRows(server)).toEqual([]);
    expect(eventsOfType(await events(server), 'stage.ai_job.queued')).toEqual([]);
  });

  it('stays off with SA_SAP_AI_BATCH=0 as well', async () => {
    const server = await startServer({ sapAiBatch: false, env: { SA_SAP_AI_BATCH: '0' } });
    const created = await createDemand(server);
    await waitForStageStatus(server, created.id, 'requirement_analysis', 'waiting_human');
    expect(providerCalls(server)).toBe(1);
    expect((await nextJobs(server)).status).toBe(404);
    expect(listJobRows(server)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2) Lifecycle: queued -> claimed (HMAC) -> heartbeat; docs/009 #17.
// ---------------------------------------------------------------------------

describe('SAP AI job lifecycle (docs/003 §4.8.2/§4.8.4)', () => {
  it('enqueues, lists with a signed next, claims once and renews the lease', async () => {
    const server = await startServer({ sapAiBatch: { leaseTtlMs: 60_000 } });
    const { demandId, job } = await createDemandAndJob(server);

    // queued: stage running, job payload complete, dispatch event written.
    expect(job).toMatchObject({
      demandId,
      stageKey: 'requirement_analysis',
      attempt: 1,
      state: 'queued',
      claimId: null,
      leaseExpiresAt: null,
    });
    const running = await getDemandDetail(server, demandId);
    expect(stageByKey(running.body, 'requirement_analysis')).toMatchObject({
      status: 'running',
      attempt: 1,
    });
    const queued = queuedEvents(await events(server));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      subject: { type: 'stage_run', id: job.stageRunId },
      data: {
        jobId: job.id,
        stageRunId: job.stageRunId,
        demandId,
        stageKey: 'requirement_analysis',
        attempt: 1,
        reason: 'dispatch',
      },
    });

    // Payload is the control-plane rendered prompt + opaque schema ref (no secrets).
    const payload: SapAiJobPayload = sapAiJobPayloadSchema.parse(job.payload);
    expect(payload.systemPrompt.length).toBeGreaterThan(0);
    expect(payload.prompt).toContain(DEMAND_TITLE);
    expect(payload.model.length).toBeGreaterThan(0);
    expect(payload.outputSchema.length).toBeGreaterThan(0);
    expect(payload.timeoutMs).toBeGreaterThan(0);
    expect(JSON.stringify(job.payload)).not.toContain(SAP_HOOK_SECRET);

    // next is read-only: the same queued job is listed again.
    const listed = await nextJobs(server);
    expect(listed.status).toBe(200);
    expect(typeof listed.body.serverTime).toBe('string');
    expect(listed.body.jobs.map((candidate) => candidate.id)).toContain(job.id);
    expect(listed.body.jobs.find((candidate) => candidate.id === job.id)?.state).toBe('queued');

    // claim -> claimed + claimId + lease, event written.
    const claim = await claimJob(server, job.id);
    expect(claim.status).toBe(200);
    expect(claim.body.job.state).toBe('claimed');
    expect(claim.body.claimId.length).toBeGreaterThan(0);
    expect(claim.body.job.claimId).toBe(claim.body.claimId);
    expect(Date.parse(claim.body.lease.expiresAt)).toBeGreaterThan(Date.now());
    expect(claim.body.lease.renewIntervalMs).toBe(30_000);
    const claimed = claimedEvents(await events(server));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      subject: { type: 'stage_run', id: job.stageRunId },
      data: {
        jobId: job.id,
        stageRunId: job.stageRunId,
        demandId,
        stageKey: 'requirement_analysis',
        attempt: 1,
        claimId: claim.body.claimId,
        leaseExpiresAt: claim.body.lease.expiresAt,
      },
    });

    // A second claim inside the lease window is a conflict and changes nothing.
    const duplicateClaim = await claimJob(server, job.id);
    expect(duplicateClaim.status).toBe(409);
    expect(getJobRow(server, job.id)?.claim_id).toBe(claim.body.claimId);

    // heartbeat renews the lease; a wrong claimId is a conflict.
    const beat = await heartbeatJob(server, job.id, claim.body.claimId);
    expect(beat.status).toBe(200);
    expect(beat.body).toMatchObject({ jobId: job.id, claimId: claim.body.claimId });
    expect(Date.parse(beat.body.lease.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(claim.body.lease.expiresAt),
    );
    const wrongClaim = await heartbeatJob(server, job.id, 'not-the-claim-id');
    expect(wrongClaim.status).toBe(409);
    expect((await events(server)).some((event) => event.type === 'stage.ai_job.claimed')).toBe(true);
  });

  it('rejects the job API without a valid HMAC signature and never mutates jobs', async () => {
    const server = await startServer({});
    const { job } = await createDemandAndJob(server);

    const cases = [
      await signedSapRequest(server, '/api/v1/sap/ai-jobs/next', {}, { omit: ['signature'] }),
      await signedSapRequest(server, '/api/v1/sap/ai-jobs/next', {}, { omit: ['timestamp'] }),
      await signedSapRequest(server, '/api/v1/sap/ai-jobs/next', {}, { omit: ['delivery'] }),
      await signedSapRequest(server, '/api/v1/sap/ai-jobs/next', {}, { secret: 'wrong-secret' }),
      await signedSapRequest(server, '/api/v1/sap/ai-jobs/next', {}, {
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
      await signedSapRequest(server, '/api/v1/sap/ai-jobs/next', {}, { timestamp: 'not-a-date' }),
    ];
    for (const response of cases) expect(response.status).toBe(401);

    // Signed requests for claim but without headers are rejected too.
    expect((await signedSapRequest(server, `/api/v1/sap/ai-jobs/${job.id}/claim`, {}, { omit: ['signature'] })).status).toBe(401);
    expect((await signedSapRequest(server, `/api/v1/sap/ai-jobs/${job.id}/claim`, {}, { secret: 'wrong-secret' })).status).toBe(401);

    // Nothing changed: the job is still queued and claimable.
    expect(getJobRow(server, job.id)?.state).toBe('queued');
    const claim = await claimJob(server, job.id);
    expect(claim.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3) Result idempotency: one completion, one attempt ledger, one artifact
// version; docs/009 #17.
// ---------------------------------------------------------------------------

describe('SAP AI job result idempotency (docs/009 #17)', () => {
  it('accepts a valid result once and treats the duplicate as a no-op', async () => {
    const server = await startServer({});
    const { demandId, job } = await createDemandAndJob(server);
    const claim = await claimJob(server, job.id);
    expect(claim.status).toBe(200);

    const body = {
      claimId: claim.body.claimId,
      status: 'succeeded' as const,
      outputText: VALID_OUTPUT,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      durationMs: 12,
    };
    const result = await sendJobResult(server, job.id, body);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: true,
      duplicate: false,
      stageRunId: job.stageRunId,
      stageStatus: 'waiting_human',
    });
    expect(result.body.job).toMatchObject({ state: 'succeeded', claimId: claim.body.claimId });
    expect(result.body.job.result?.status).toBe('succeeded');

    const detail = await getDemandDetail(server, demandId);
    const stage = stageByKey(detail.body, 'requirement_analysis');
    expect(stage).toMatchObject({ status: 'waiting_human', attempt: 1 });
    expect(detail.body.artifacts).toHaveLength(1);
    expect(detail.body.artifacts[0]).toMatchObject({
      id: stage.outputArtifactId,
      kind: 'requirement_analysis',
      currentVersion: 1,
      state: 'in_review',
    });
    expect(detail.body.artifactVersions).toHaveLength(1);

    const completed = completedEvent(await events(server));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      subject: { type: 'stage_run', id: job.stageRunId },
      data: {
        jobId: job.id,
        stageRunId: job.stageRunId,
        demandId,
        stageKey: 'requirement_analysis',
        attempt: 1,
        artifactId: stage.outputArtifactId,
        artifactVersion: 1,
        stageStatus: 'waiting_human',
        tokens: 30,
      },
    });
    expect(typeof (completed[0]?.data as Record<string, unknown>)['durationMs']).toBe('number');

    // Duplicate result: 200 duplicate, no second completion/ledger/artifact.
    const duplicate = await sendJobResult(server, job.id, body);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ accepted: false, duplicate: true, stageRunId: job.stageRunId });
    expect(completedEvent(await events(server))).toHaveLength(1);
    expect(countRows(server, 'stage_attempts')).toBe(1);
    expect(countRows(server, 'artifact_versions')).toBe(1);
    expect(countRows(server, 'artifacts')).toBe(1);
    const after = await getDemandDetail(server, demandId);
    expect(after.body.artifacts).toHaveLength(1);
    expect(providerIdle(server)).toBe(true);
  });
});

function providerIdle(server: SapTestServer): boolean {
  return providerCalls(server) === 0;
}

// ---------------------------------------------------------------------------
// 4) Invalid output / SAP-side failure: retry to maxAttempts -> waiting_human,
// never a half-baked artifact (docs/003 §4.8.6, docs/009 #15/#18).
// ---------------------------------------------------------------------------

describe('SAP AI job failure semantics (docs/003 §4.8.6, docs/009 #18)', () => {
  it('retries non-JSON and schema-invalid output, then parks at waiting_human without artifacts', async () => {
    const server = await startServer({});
    const { demandId, job } = await createDemandAndJob(server);
    const claim = await claimJob(server, job.id);

    // Attempt 1: raw text is not JSON -> invalid_output, stage retried.
    const invalidJson = await sendJobResult(server, job.id, {
      claimId: claim.body.claimId,
      status: 'succeeded',
      outputText: 'the gateway answered with plain prose, not JSON',
    });
    expect(invalidJson.status).toBe(200);
    expect(invalidJson.body).toMatchObject({ accepted: true, duplicate: false, stageStatus: 'ready' });
    expect(invalidJson.body.job.state).toBe('failed');

    const retryJob = await waitForQueuedJob(
      server,
      (candidate) => candidate.stageRunId === job.stageRunId && candidate.attempt === 2,
    );
    expect(retryJob.id).not.toBe(job.id);
    expect(retryJob.state).toBe('queued');

    const afterFirst = await getDemandDetail(server, demandId);
    expect(stageByKey(afterFirst.body, 'requirement_analysis')).toMatchObject({
      status: 'running',
      attempt: 2,
    });
    expect(afterFirst.body.artifacts).toHaveLength(0);

    let failures = failedEvents(await events(server));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.data).toMatchObject({
      jobId: job.id,
      stageKey: 'requirement_analysis',
      attempt: 1,
      reason: 'invalid_output',
      willRetry: true,
      stageStatus: 'ready',
    });
    expect(typeof failures[0]?.data['error']).toBe('string');
    const dispatchReasons = queuedEvents(await events(server)).map((event) => event.data['reason']);
    expect(dispatchReasons).toEqual(['dispatch', 'retry']);

    // Attempt 2: JSON but schema-invalid -> last attempt fails -> waiting_human.
    const claim2 = await claimJob(server, retryJob.id);
    const invalidSchema = await sendJobResult(server, retryJob.id, {
      claimId: claim2.body.claimId,
      status: 'succeeded',
      outputText: JSON.stringify({ unexpected: 'shape' }),
    });
    expect(invalidSchema.status).toBe(200);
    expect(invalidSchema.body).toMatchObject({
      accepted: true,
      duplicate: false,
      stageStatus: 'waiting_human',
    });
    expect(invalidSchema.body.job.state).toBe('failed');
    expect(await waitForNoQueuedJobs(server)).toBe(true);

    const parked = await getDemandDetail(server, demandId);
    expect(stageByKey(parked.body, 'requirement_analysis')).toMatchObject({
      status: 'waiting_human',
      attempt: 2,
    });
    expect(parked.body.artifacts).toHaveLength(0);
    expect(countRows(server, 'stage_attempts')).toBe(2);
    expect(countRows(server, 'artifacts')).toBe(0);
    expect(eventsOfType(await events(server), 'artifact.created')).toEqual([]);
    failures = failedEvents(await events(server));
    expect(failures).toHaveLength(2);
    expect(failures[1]?.data).toMatchObject({
      jobId: retryJob.id,
      attempt: 2,
      reason: 'invalid_output',
      willRetry: false,
      stageStatus: 'waiting_human',
    });
    expect(providerIdle(server)).toBe(true);
  });

  it('treats a SAP-reported failed result as sap_failed and applies the same retry/park semantics', async () => {
    const server = await startServer({});
    const { demandId, job } = await createDemandAndJob(server);
    const claim = await claimJob(server, job.id);
    const failed = await sendJobResult(server, job.id, {
      claimId: claim.body.claimId,
      status: 'failed',
      error: { code: 'GATEWAY_5XX', message: 'gateway returned 502', retryable: true },
      durationMs: 5,
    });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ accepted: true, duplicate: false, stageStatus: 'ready' });
    expect(failed.body.job.state).toBe('failed');

    let failures = failedEvents(await events(server));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.data).toMatchObject({
      jobId: job.id,
      attempt: 1,
      reason: 'sap_failed',
      willRetry: true,
      stageStatus: 'ready',
    });
    expect(String(failures[0]?.data['error'])).toContain('gateway returned 502');

    const retryJob = await waitForQueuedJob(
      server,
      (candidate) => candidate.stageRunId === job.stageRunId && candidate.attempt === 2,
    );
    const claim2 = await claimJob(server, retryJob.id);
    const failedAgain = await sendJobResult(server, retryJob.id, {
      claimId: claim2.body.claimId,
      status: 'failed',
      error: { message: 'still failing', retryable: false },
    });
    expect(failedAgain.body).toMatchObject({ accepted: true, stageStatus: 'waiting_human' });
    expect(await waitForNoQueuedJobs(server)).toBe(true);

    const parked = await getDemandDetail(server, demandId);
    expect(stageByKey(parked.body, 'requirement_analysis').status).toBe('waiting_human');
    expect(countRows(server, 'artifacts')).toBe(0);
    expect(countRows(server, 'stage_attempts')).toBe(2);
    failures = failedEvents(await events(server));
    expect(failures).toHaveLength(2);
    expect(failures[1]?.data).toMatchObject({ attempt: 2, reason: 'sap_failed', willRetry: false });
  });
});

// ---------------------------------------------------------------------------
// 5) Leases: expiry requeues without incrementing the attempt; repeated
// expiry / max age fails the attempt (docs/003 §4.8.2, docs/009 #18).
// ---------------------------------------------------------------------------

describe('SAP AI job leases (docs/003 §4.8.2)', () => {
  it('returns an expired claim to queued without a new attempt and allows re-claiming', async () => {
    const server = await startServer({ sapAiBatch: { leaseTtlMs: 120, maxLeaseExpiries: 5 } });
    const { demandId, job } = await createDemandAndJob(server);
    const claim = await claimJob(server, job.id);
    expect(claim.status).toBe(200);

    const reclaimed = await waitForJobRow(server, job.id, 'queued');
    expect(reclaimed.attempt).toBe(1);
    expect(reclaimed.claim_id).toBeNull();
    expect(reclaimed.lease_expires_at).toBeNull();
    expect(Number(reclaimed.lease_expiries)).toBe(1);

    const detail = await getDemandDetail(server, demandId);
    expect(stageByKey(detail.body, 'requirement_analysis')).toMatchObject({
      status: 'running',
      attempt: 1,
    });
    const queuedReasons = queuedEvents(await events(server)).map((event) => event.data['reason']);
    expect(queuedReasons).toEqual(['dispatch', 'lease_expired']);
    expect(failedEvents(await events(server))).toHaveLength(0);

    // The same job (same attempt) can be claimed again after the expiry.
    const secondClaim = await claimJob(server, job.id);
    expect(secondClaim.status).toBe(200);
    expect(secondClaim.body.job).toMatchObject({ state: 'claimed', attempt: 1 });
    expect(getJobRow(server, job.id)?.claim_id).toBe(secondClaim.body.claimId);
  });

  it('fails the attempt and expires the job after maxLeaseExpiries lease expiries', async () => {
    const server = await startServer({ sapAiBatch: { leaseTtlMs: 120, maxLeaseExpiries: 2 } });
    const { demandId, job } = await createDemandAndJob(server);
    await claimJob(server, job.id);
    await waitForJobRow(server, job.id, 'queued'); // expiry #1: requeued, attempt kept
    await claimJob(server, job.id);
    const expired = await waitForJobRow(server, job.id, 'expired'); // expiry #2: terminal
    expect(Number(expired.lease_expiries)).toBeGreaterThanOrEqual(2);

    const retryJob = await waitForQueuedJob(
      server,
      (candidate) => candidate.stageRunId === job.stageRunId && candidate.attempt === 2,
    );
    expect(retryJob.id).not.toBe(job.id);
    const failures = failedEvents(await events(server));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.data).toMatchObject({
      jobId: job.id,
      attempt: 1,
      reason: 'lease_expired',
      willRetry: true,
      stageStatus: 'ready',
    });
    const detail = await getDemandDetail(server, demandId);
    expect(stageByKey(detail.body, 'requirement_analysis').attempt).toBe(2);
  });

  it('expires jobs older than maxAgeMs and fails the stage attempt', async () => {
    const server = await startServer({
      sapAiBatch: { maxAgeMs: 150, leaseTtlMs: 60_000, maxLeaseExpiries: 5 },
    });
    const { demandId, job } = await createDemandAndJob(server);
    const expired = await waitForJobRow(server, job.id, 'expired');
    expect(expired.attempt).toBe(1);

    const retryJob = await waitForQueuedJob(
      server,
      (candidate) => candidate.stageRunId === job.stageRunId && candidate.attempt === 2,
    );
    expect(retryJob.state).toBe('queued');
    const failures = failedEvents(await events(server));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.data).toMatchObject({
      jobId: job.id,
      attempt: 1,
      reason: 'max_age_exceeded',
      willRetry: true,
    });
    const detail = await getDemandDetail(server, demandId);
    expect(stageByKey(detail.body, 'requirement_analysis').attempt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6) Restart recovery (docs/003 §4.8.6).
// ---------------------------------------------------------------------------

describe('SAP AI job restart recovery (docs/003 §4.8.6)', () => {
  it('requeues claimed jobs whose lease expired while the server was down', async () => {
    const stateDir = tempDir();
    const first = await startSapTestServer({
      stateDir,
      sapAiBatch: { leaseTtlMs: 60_000 },
    });
    try {
      const { demandId, job } = await createDemandAndJob(first);
      const claim = await claimJob(first, job.id);
      expect(claim.status).toBe(200);
      await first.dispose();

      // Simulate the lease expiring while the control plane was stopped.
      forceJobState(first, job.id, { leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() });

      const second = await startServer({ stateDir, sapAiBatch: { leaseTtlMs: 60_000 } });
      const recovered = getJobRow(second, job.id);
      expect(recovered).toMatchObject({ state: 'queued', claim_id: null, attempt: 1 });
      expect(Number(recovered?.lease_expiries)).toBeGreaterThanOrEqual(1);
      const listed = await nextJobs(second);
      expect(listed.body.jobs.map((candidate) => candidate.id)).toContain(job.id);
      const recoveryEvents = queuedEvents(await events(second));
      expect(recoveryEvents.at(-1)?.data).toMatchObject({
        jobId: job.id,
        attempt: 1,
        reason: 'recovered',
      });
      const detail = await getDemandDetail(second, demandId);
      expect(stageByKey(detail.body, 'requirement_analysis')).toMatchObject({
        status: 'running',
        attempt: 1,
      });

      // Recovered job is claimable again (same attempt, no ledger duplication).
      const reclaim = await claimJob(second, job.id);
      expect(reclaim.status).toBe(200);
      expect(reclaim.body.job.attempt).toBe(1);
    } finally {
      await first.dispose();
    }
  });

  it('recreates the job for a delegated running stage that lost its job row', async () => {
    const stateDir = tempDir();
    const first = await startSapTestServer({ stateDir });
    let original: Awaited<ReturnType<typeof createDemandAndJob>>;
    try {
      original = await createDemandAndJob(first);
      expect(original.job.attempt).toBe(1);
      expect(getJobRow(first, original.job.id)).not.toBeNull();
      await first.dispose();

      // Simulate a crashed/lost queue row for an otherwise running stage.
      deleteJobRows(first);
      expect(listJobRows(first)).toEqual([]);

      const second = await startServer({ stateDir });
      const recreated = await waitForQueuedJob(
        second,
        (candidate) => candidate.stageRunId === original.job.stageRunId,
      );
      expect(recreated).toMatchObject({
        stageRunId: original.job.stageRunId,
        demandId: original.demandId,
        stageKey: 'requirement_analysis',
        attempt: 1,
        state: 'queued',
      });
      expect(recreated.id).not.toBe(original.job.id);
      const recoveryEvents = queuedEvents(await events(second));
      expect(recoveryEvents.at(-1)?.data).toMatchObject({
        jobId: recreated.id,
        attempt: 1,
        reason: 'recovered',
      });
      const detail = await getDemandDetail(second, original.demandId);
      expect(stageByKey(detail.body, 'requirement_analysis').status).toBe('running');
    } finally {
      await first.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 7) Admin requeue + /hooks/sap/status aiJobs counters (docs/003 §4.8.4).
// ---------------------------------------------------------------------------

describe('SAP AI job admin requeue and status (docs/003 §4.8.4)', () => {
  it('matches the documented queued/claimed/advanced requeue semantics', async () => {
    const server = await startServer({});
    const { demandId, job } = await createDemandAndJob(server);

    // Auth: admin Bearer required.
    expect((await requeueJob(server, job.id, null)).status).toBe(401);
    expect((await requeueJob(server, job.id, server.userToken)).status).toBe(403);
    // Already queued -> idempotent no-op.
    const queued = await requeueJob(server, job.id, server.adminToken, 'ops retry');
    expect(queued.status).toBe(200);
    expect(queued.body.requeued).toBe(false);
    expect(queued.body.job.state).toBe('queued');

    // Claimed -> 409.
    const claim = await claimJob(server, job.id);
    expect((await requeueJob(server, job.id)).status).toBe(409);

    // Stage advanced (succeeded + waiting_human) -> 409 as well.
    const result = await sendJobResult(server, job.id, {
      claimId: claim.body.claimId,
      status: 'succeeded',
      outputText: VALID_OUTPUT,
    });
    expect(result.body.stageStatus).toBe('waiting_human');
    expect((await requeueJob(server, job.id)).status).toBe(409);

    // failed job while the stage is still running its attempt -> requeued.
    const second = await createDemandAndJob(server);
    const claimB = await claimJob(server, second.job.id);
    expect(claimB.status).toBe(200);
    forceJobState(server, second.job.id, { state: 'failed', lastError: 'operator-simulated failure' });
    const requeued = await requeueJob(server, second.job.id, server.adminToken, 'retry manually');
    expect(requeued.status).toBe(200);
    expect(requeued.body.requeued).toBe(true);
    expect(requeued.body.job.state).toBe('queued');
    expect(getJobRow(server, second.job.id)?.state).toBe('queued');
    const reasons = queuedEvents(await events(server)).map((event) => event.data['reason']);
    expect(reasons).toContain('requeued');
    const listed = await nextJobs(server);
    expect(listed.body.jobs.map((candidate) => candidate.id)).toContain(second.job.id);
    // The requeued job is claimable again (same attempt).
    const reclaim = await claimJob(server, second.job.id);
    expect(reclaim.status).toBe(200);
    expect(reclaim.body.job.attempt).toBe(1);

    // An expired job on the same running attempt is requeued as well.
    forceJobState(server, second.job.id, { state: 'expired', leaseExpiresAt: null });
    const requeuedExpired = await requeueJob(server, second.job.id, server.adminToken, 'after max age');
    expect(requeuedExpired.status).toBe(200);
    expect(requeuedExpired.body.requeued).toBe(true);
    expect(requeuedExpired.body.job.state).toBe('queued');
    const detail = await getDemandDetail(server, demandId);
    expect(detail.status).toBe(200);
  });

  it('reports aiJobs counters and lastError on /hooks/sap/status only when enabled', async () => {
    const server = await startServer({});
    const admin = await sapStatus(server);
    expect(admin.status).toBe(200);
    expect(admin.body.enabled).toEqual({ outbound: false, inbound: true });
    expect(admin.body.aiJobs).toEqual({
      queued: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      expired: 0,
      cancelled: 0,
      lastError: null,
    });
    expect((await sapStatus(server, null)).status).toBe(401);
    expect((await sapStatus(server, server.userToken)).status).toBe(403);

    const { job } = await createDemandAndJob(server);
    expect((await sapStatus(server)).body.aiJobs).toMatchObject({ queued: 1, claimed: 0 });
    const claim = await claimJob(server, job.id);
    expect((await sapStatus(server)).body.aiJobs).toMatchObject({ queued: 0, claimed: 1 });

    const failed = await sendJobResult(server, job.id, {
      claimId: claim.body.claimId,
      status: 'succeeded',
      outputText: 'not-json',
    });
    expect(failed.body.stageStatus).toBe('ready');
    const afterFailure = (await sapStatus(server)).body.aiJobs;
    expect(afterFailure).toMatchObject({ failed: 1 });
    expect(typeof afterFailure?.lastError).toBe('string');
    expect(afterFailure?.lastError?.length).toBeGreaterThan(0);

    const retryJob = await waitForQueuedJob(
      server,
      (candidate) => candidate.stageRunId === job.stageRunId && candidate.attempt === 2,
    );
    expect((await sapStatus(server)).body.aiJobs).toMatchObject({ queued: 1, failed: 1 });
    const claim2 = await claimJob(server, retryJob.id);
    const succeeded = await sendJobResult(server, retryJob.id, {
      claimId: claim2.body.claimId,
      status: 'succeeded',
      outputText: VALID_OUTPUT,
    });
    expect(succeeded.body.stageStatus).toBe('waiting_human');
    expect((await sapStatus(server)).body.aiJobs).toMatchObject({
      queued: 0,
      claimed: 0,
      succeeded: 1,
      failed: 1,
      expired: 0,
      cancelled: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 8) Cancellation / moved-on stage: SAP must stop retrying and never complete a
// stage attempt that already advanced (docs/003 §4.8.2/§4.8.4).
// ---------------------------------------------------------------------------

describe('SAP AI job cancellation semantics (docs/003 §4.8.2)', () => {
  it('cancels an active job when its stage attempt is cancelled', async () => {
    const stateDir = tempDir();
    const first = await startSapTestServer({ stateDir });
    try {
      const { job } = await createDemandAndJob(first);
      expect((await claimJob(first, job.id)).status).toBe(200);
      await first.dispose();

      // Construct: the stage was cancelled while the control plane was down.
      withStateDb(first, (db) => {
        db.prepare("UPDATE stage_runs SET status = 'cancelled' WHERE id = ?").run(job.stageRunId);
      });

      const second = await startServer({ stateDir });
      const cancelled = await waitForJobRow(second, job.id, 'cancelled');
      expect(cancelled.attempt).toBe(1);
      const failures = failedEvents(await events(second));
      expect(failures).toHaveLength(1);
      expect(failures[0]?.data).toMatchObject({
        jobId: job.id,
        attempt: 1,
        reason: 'stage_cancelled',
        willRetry: false,
        stageStatus: 'cancelled',
      });
      // A cancelled job is terminal: no attempt ledger / artifact side effects.
      expect(countRows(second, 'stage_attempts')).toBe(0);
      expect(countRows(second, 'artifacts')).toBe(0);
      const listed = await nextJobs(second);
      expect(listed.status).toBe(200);
      expect(listed.body.jobs).toEqual([]);
    } finally {
      await first.dispose();
    }
  });

  it('cancels the job instead of completing when the result arrives after the stage moved on', async () => {
    const stateDir = tempDir();
    const first = await startSapTestServer({ stateDir });
    try {
      const { job } = await createDemandAndJob(first);
      const claim = await claimJob(first, job.id);
      await first.dispose();

      withStateDb(first, (db) => {
        db.prepare("UPDATE stage_runs SET status = 'cancelled' WHERE id = ?").run(job.stageRunId);
      });

      // Slow tick so the result is handled before the orphan-row sweeper runs.
      const second = await startServer({ stateDir, overrides: { stagePollMs: 5_000 } });
      const result = await sendJobResult(second, job.id, {
        claimId: claim.body.claimId,
        status: 'succeeded',
        outputText: VALID_OUTPUT,
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        accepted: false,
        duplicate: false,
        stageStatus: 'cancelled',
      });
      expect(result.body.job.state).toBe('cancelled');
      const failures = failedEvents(await events(second));
      expect(failures).toHaveLength(1);
      expect(failures[0]?.data).toMatchObject({
        jobId: job.id,
        reason: 'stage_cancelled',
        willRetry: false,
        stageStatus: 'cancelled',
      });
      expect(countRows(second, 'artifacts')).toBe(0);
    } finally {
      await first.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 9) Data boundary: the local provider is never called and the payload carries
// no credentials (docs/003 §4.8.3/§4.8.7).
// ---------------------------------------------------------------------------

describe('SAP batch mode data boundary (docs/003 §4.8.3)', () => {
  it('never calls the local provider and keeps credentials out of the job payload', async () => {
    const server = await startServer({});
    const { demandId, job } = await createDemandAndJob(server);
    const payload = sapAiJobPayloadSchema.parse(job.payload);
    for (const key of [
      'stageRunId',
      'demandId',
      'stageKey',
      'stageName',
      'attempt',
      'promptVersion',
      'systemPrompt',
      'prompt',
      'model',
      'outputSchema',
      'timeoutMs',
    ]) {
      expect(Object.keys(payload)).toContain(key);
    }
    const serialized = JSON.stringify(job.payload).toLowerCase();
    for (const forbidden of [
      'apikey',
      'api_key',
      'gatewayurl',
      'gateway_url',
      'baseurl',
      'base_url',
      'credential',
      'authorization',
      'ai_key_ref',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const claim = await claimJob(server, job.id);
    const result = await sendJobResult(server, job.id, {
      claimId: claim.body.claimId,
      status: 'succeeded',
      outputText: VALID_OUTPUT,
    });
    expect(result.body.stageStatus).toBe('waiting_human');
    expect(providerCalls(server)).toBe(0);
    const detail = await getDemandDetail(server, demandId);
    expect(stageByKey(detail.body, 'requirement_analysis').status).toBe('waiting_human');
    expect(eventsOfType(await events(server), 'stage.started')).toHaveLength(1);
  });
});
