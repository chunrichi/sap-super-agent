import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { newUlid, type SapAiJob } from '@sap-superagent/protocol';
import { FakeAiGateway } from '../src/fake-ai-gateway.js';
import { FakeSapAiBatch, type FakeSapAiBatchProcessedJob } from '../src/fake-sap-ai-batch.js';
import { TestApiError } from '../src/http.js';

// ---------------------------------------------------------------------------
// S5: the fake SAP batch executor must sign its SAP → control-plane calls with
// the documented X-SA-* HMAC rule, forward the rendered messages to the
// enterprise AI gateway and post the raw output back. A minimal in-process
// stub control plane covers the wire contract without booting `packages/server`
// (the real end-to-end path is covered by `e2e/sap-hosted.e2e.test.ts`).
// ---------------------------------------------------------------------------

const SECRET = 'unit-sap-ai-batch-secret';
const CLAIM_ID = 'claim-unit-1';

function computeSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function makeJob(): SapAiJob {
  const now = new Date().toISOString();
  const stageRunId = newUlid();
  return {
    id: newUlid(),
    stageRunId,
    demandId: 'D-UNIT-1',
    attempt: 1,
    stageKey: 'intake',
    state: 'queued',
    payload: {
      stageRunId,
      demandId: 'D-UNIT-1',
      stageKey: 'intake',
      stageName: '受理与澄清',
      attempt: 1,
      promptVersion: 'v1',
      systemPrompt: 'system instruction',
      prompt: 'user prompt',
      model: 'unit-model',
      outputSchema: 'free_note',
      timeoutMs: 5_000,
    },
    claimId: null,
    leaseExpiresAt: null,
    result: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
}

interface ControlPlaneHarness {
  url: string;
  calls: RecordedCall[];
  results: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Stub of `/api/v1/sap/ai-jobs/*` that verifies the HMAC like the server does. */
async function startControlPlane(job: SapAiJob): Promise<ControlPlaneHarness> {
  const calls: RecordedCall[] = [];
  const results: Array<Record<string, unknown>> = [];
  let claimed = false;
  let terminal = false;
  const lease = {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    renewIntervalMs: 30_000,
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', 'http://fake.local');
      const signature = request.headers['x-sa-signature'];
      const timestamp = request.headers['x-sa-timestamp'];
      const delivery = request.headers['x-sa-delivery'];
      const json = (status: number, value: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (
        typeof signature !== 'string' ||
        typeof timestamp !== 'string' ||
        typeof delivery !== 'string' ||
        signature !== computeSignature(SECRET, rawBody)
      ) {
        json(401, { error: { code: 'unauthorized', message: 'invalid X-SA-* signature' } });
        return;
      }
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      calls.push({ path: url.pathname, body });
      if (url.pathname === '/api/v1/sap/ai-jobs/next') {
        const jobs = terminal ? [] : [{ ...job, state: claimed ? 'claimed' : 'queued' }];
        json(200, { jobs, serverTime: new Date().toISOString() });
        return;
      }
      if (url.pathname.endsWith('/claim')) {
        if (claimed) {
          json(409, { error: { code: 'conflict', message: 'job is claimed' } });
          return;
        }
        claimed = true;
        json(200, {
          job: { ...job, state: 'claimed', claimId: CLAIM_ID, leaseExpiresAt: lease.expiresAt },
          claimId: CLAIM_ID,
          lease,
          serverTime: new Date().toISOString(),
        });
        return;
      }
      if (url.pathname.endsWith('/heartbeat')) {
        if (body['claimId'] !== CLAIM_ID) {
          json(409, { error: { code: 'conflict', message: 'claim id mismatch' } });
          return;
        }
        json(200, { jobId: job.id, claimId: CLAIM_ID, lease, serverTime: new Date().toISOString() });
        return;
      }
      if (url.pathname.endsWith('/result')) {
        if (body['claimId'] !== CLAIM_ID) {
          json(409, { error: { code: 'conflict', message: 'claim id mismatch' } });
          return;
        }
        const state = body['status'] === 'failed' ? 'failed' : 'succeeded';
        const stageStatus = state === 'succeeded' ? 'waiting_human' : 'ready';
        if (terminal) {
          json(200, {
            job: { ...job, state, claimId: CLAIM_ID },
            accepted: false,
            duplicate: true,
            stageRunId: job.stageRunId,
            stageStatus,
            serverTime: new Date().toISOString(),
          });
          return;
        }
        terminal = true;
        results.push(body);
        json(200, {
          job: { ...job, state, claimId: CLAIM_ID },
          accepted: true,
          duplicate: false,
          stageRunId: job.stageRunId,
          stageStatus,
          serverTime: new Date().toISOString(),
        });
        return;
      }
      json(404, { error: { code: 'not_found', message: url.pathname } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub control plane did not listen');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    results,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(gatewayOptions: ConstructorParameters<typeof FakeAiGateway>[0] = {}) {
  const controlPlane = await startControlPlane(makeJob());
  const gateway = new FakeAiGateway({ model: 'unit-model', ...gatewayOptions });
  await gateway.start();
  cleanups.push(async () => {
    await gateway.stop();
    await controlPlane.close();
  });
  return { controlPlane, gateway };
}

function firstJob(batch: FakeSapAiBatch): FakeSapAiBatchProcessedJob {
  const [job] = batch.processed;
  if (job === undefined) throw new Error('batch processed no job');
  return job;
}

describe('FakeSapAiBatch', () => {
  it('claims the job, calls the enterprise gateway and posts the raw output back', async () => {
    const { controlPlane, gateway } = await boot({ outputText: '{"summary":"from gateway"}' });
    const batch = new FakeSapAiBatch({
      controlPlaneUrl: controlPlane.url,
      hookSecret: SECRET,
      gatewayUrl: gateway.url,
      heartbeatBeforeResult: true,
    });

    await batch.pump({ maxJobs: 1 });

    expect(firstJob(batch)).toMatchObject({
      stageKey: 'intake',
      attempt: 1,
      state: 'succeeded',
      resultStatus: 200,
      duplicate: false,
      gatewayRequests: 1,
      error: null,
    });
    expect(batch.requests.map((request) => request.kind)).toEqual([
      'next',
      'claim',
      'heartbeat',
      'result',
    ]);
    // Every SAP → control-plane call carries a distinct X-SA-Delivery key.
    expect(new Set(batch.requests.map((request) => request.delivery)).size).toBe(4);
    expect(controlPlane.results).toHaveLength(1);
    expect(controlPlane.results[0]).toMatchObject({
      claimId: CLAIM_ID,
      status: 'succeeded',
      outputText: '{"summary":"from gateway"}',
    });
    expect(controlPlane.results[0]?.['usage']).toMatchObject({
      model: 'unit-model',
    });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(gateway.requests[0]?.model).toBe('unit-model');
  });

  it('rejects a wrong HMAC secret with the control-plane 401', async () => {
    const { controlPlane } = await boot();
    const batch = new FakeSapAiBatch({
      controlPlaneUrl: controlPlane.url,
      hookSecret: 'wrong-secret',
      outputFor: () => '{}',
    });

    await expect(batch.pump({ maxJobs: 1 })).rejects.toBeInstanceOf(TestApiError);
    expect(controlPlane.calls).toHaveLength(0);
  });

  it('can produce output directly (no gateway) for tests that do not need one', async () => {
    const { controlPlane } = await boot();
    const batch = new FakeSapAiBatch({
      controlPlaneUrl: controlPlane.url,
      hookSecret: SECRET,
      outputFor: (job) => `{"summary":"direct ${job.stageKey}"}`,
    });

    await batch.pump({ maxJobs: 1 });

    expect(firstJob(batch)).toMatchObject({ state: 'succeeded', gatewayRequests: 0 });
    expect(controlPlane.results[0]).toMatchObject({
      status: 'succeeded',
      outputText: '{"summary":"direct intake"}',
    });
  });

  it('injects claim conflicts and wrong claim ids', async () => {
    const { controlPlane, gateway } = await boot({ outputText: '{"summary":"ok"}' });
    const batch = new FakeSapAiBatch({
      controlPlaneUrl: controlPlane.url,
      hookSecret: SECRET,
      gatewayUrl: gateway.url,
    });

    batch.injectFault({ kind: 'claim_conflict' });
    await batch.pump({ maxJobs: 1 });
    expect(firstJob(batch)).toMatchObject({
      state: 'succeeded',
      conflictingClaimStatus: 409,
      resultStatus: 200,
    });

    const wrongIdBatch = new FakeSapAiBatch({
      controlPlaneUrl: (await boot()).controlPlane.url,
      hookSecret: SECRET,
      gatewayUrl: gateway.url,
    });
    wrongIdBatch.injectFault({ kind: 'wrong_claim_id' });
    await wrongIdBatch.pump({ maxJobs: 1 });
    expect(firstJob(wrongIdBatch)).toMatchObject({
      state: 'succeeded',
      wrongClaimStatus: 409,
      resultStatus: 200,
    });
  });

  it('injects gateway failures, invalid output and duplicate results', async () => {
    const gatewayFailure = await boot({ outputText: '{"summary":"ok"}' });
    const failedBatch = new FakeSapAiBatch({
      controlPlaneUrl: gatewayFailure.controlPlane.url,
      hookSecret: SECRET,
      gatewayUrl: gatewayFailure.gateway.url,
    });
    failedBatch.injectFault({ kind: 'gateway_failure', message: 'model not allowed', retryable: false });
    await failedBatch.pump({ maxJobs: 1 });
    expect(firstJob(failedBatch)).toMatchObject({
      state: 'failed',
      resultStatus: 200,
      gatewayRequests: 0,
    });
    expect(gatewayFailure.controlPlane.results[0]).toMatchObject({
      status: 'failed',
      error: { code: 'gateway_error', message: 'model not allowed', retryable: false },
    });

    const invalidOutput = await boot({ outputText: '{"summary":"ok"}' });
    const invalidBatch = new FakeSapAiBatch({
      controlPlaneUrl: invalidOutput.controlPlane.url,
      hookSecret: SECRET,
      gatewayUrl: invalidOutput.gateway.url,
    });
    invalidBatch.injectFault({ kind: 'invalid_output', outputText: '{broken' });
    await invalidBatch.pump({ maxJobs: 1 });
    expect(firstJob(invalidBatch)).toMatchObject({ state: 'succeeded' });
    expect(invalidOutput.controlPlane.results[0]?.['outputText']).toBe('{broken');

    const duplicate = await boot({ outputText: '{"summary":"ok"}' });
    const duplicateBatch = new FakeSapAiBatch({
      controlPlaneUrl: duplicate.controlPlane.url,
      hookSecret: SECRET,
      gatewayUrl: duplicate.gateway.url,
    });
    duplicateBatch.injectFault({ kind: 'duplicate_result' });
    await duplicateBatch.pump({ maxJobs: 1 });
    expect(firstJob(duplicateBatch)).toMatchObject({
      state: 'succeeded',
      duplicate: true,
      resultStatus: 200,
    });
    expect(duplicate.controlPlane.results).toHaveLength(1);
  });

  it('skips a job when told to and picks it up on the next run', async () => {
    const { controlPlane, gateway } = await boot({ outputText: '{"summary":"ok"}' });
    const batch = new FakeSapAiBatch({
      controlPlaneUrl: controlPlane.url,
      hookSecret: SECRET,
      gatewayUrl: gateway.url,
    });
    batch.injectFault({ kind: 'skip_job' });

    await batch.pump({ maxJobs: 1 });
    expect(firstJob(batch)).toMatchObject({ state: 'skipped', claimId: null, resultStatus: null });
    expect(controlPlane.results).toHaveLength(0);

    await batch.pump({ maxJobs: 1 });
    expect(batch.processed[1]).toMatchObject({ state: 'succeeded', resultStatus: 200 });
  });
});
