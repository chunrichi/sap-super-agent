import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FakeModelProvider, type CompletionRequest, type CompletionResult, type ModelProvider } from '@sap-superagent/ai';
import type {
  EventEnvelope,
  SapAiJob,
  SapAiJobClaimResponse,
  SapAiJobHeartbeatResponse,
  SapAiJobRequeueResponse,
  SapAiJobResultBody,
  SapAiJobResultResponse,
  SapAiJobsResponse,
  SapAiJobsStatus,
} from '@sap-superagent/protocol';
import { newUlid } from '@sap-superagent/protocol';
import { buildSapHookHeaders } from '@sap-superagent/sap-adapter';
import {
  issueToken,
  loadOrCreateStateSecret,
  startServer,
  type RunningServer,
  type ServerOptions,
} from '../src/index.js';
import { waitFor, type ApiResponse, type TestServer } from './helpers.js';

// ---------------------------------------------------------------------------
// S5 integration-test kit: run the control plane in SAP-batch AI mode, drive
// the HMAC SAP → control-plane job API (docs/003 §4.8.4) and inspect the
// persisted state directly (sqlite) where the public API is intentionally
// one-way (claimed/expired jobs are not listed by `next`).
// ---------------------------------------------------------------------------

export const TEMPLATES_DIR = resolve(process.cwd(), '../../templates');
/** Shared secret configured as SA_SAP_HOOK_SECRET for the test server. */
export const SAP_HOOK_SECRET = 'sap-ai-integration-test-secret';

/**
 * Overrides accepted by `ServerOptions.sapAiBatch` (shape confirmed by
 * server-core). The sweep for expired leases / max age runs inside the stage
 * runner tick, so `stagePollMs` (20ms in tests) is the effective interval.
 */
export interface SapAiBatchTestOverrides {
  enabled?: boolean;
  stageKeys?: readonly string[];
  leaseTtlMs?: number;
  maxAgeMs?: number;
  batchSize?: number;
  timeoutMs?: number;
  maxLeaseExpiries?: number;
  model?: string;
  hookSecret?: string | null;
  toleranceMs?: number;
}

export const SAP_MODE_ENV: NodeJS.ProcessEnv = {
  SA_SAP_AI_BATCH: '1',
  SA_SAP_HOOK_SECRET: SAP_HOOK_SECRET,
};

export interface CountingProvider extends ModelProvider {
  calls: number;
  requests: CompletionRequest[];
}

/** Fake provider that records how often the control plane calls a local model. */
export function countingFakeProvider(): CountingProvider {
  const inner = new FakeModelProvider();
  const provider: CountingProvider = {
    name: 'fake',
    calls: 0,
    requests: [],
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      provider.calls += 1;
      provider.requests.push(request);
      return inner.complete(request);
    },
  };
  return provider;
}

export interface StartSapTestServerOptions {
  /** Reuse an existing directory (restart tests); otherwise a temp dir is made. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  /** `false` keeps the H0–S4 default (SAP batch disabled). */
  sapAiBatch?: SapAiBatchTestOverrides | false;
  provider?: ModelProvider;
  overrides?: Partial<ServerOptions>;
}

export interface SapTestServer extends TestServer {
  running: RunningServer;
  provider: ModelProvider;
  env: NodeJS.ProcessEnv;
}

function sapAiBatchOverrides(
  overrides: SapAiBatchTestOverrides,
): Partial<ServerOptions> {
  // The property is added by server-core; the cast keeps TDD compiling before
  // it lands and is harmless afterwards.
  return { sapAiBatch: { enabled: true, ...overrides } } as unknown as Partial<ServerOptions>;
}

export async function startSapTestServer(
  options: StartSapTestServerOptions = {},
): Promise<SapTestServer> {
  const ownsStateDir = options.stateDir === undefined;
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'sa-sap-ai-test-'));
  const secret = loadOrCreateStateSecret(stateDir);
  const env: NodeJS.ProcessEnv =
    options.env ?? (options.sapAiBatch === false ? {} : SAP_MODE_ENV);
  const provider = options.provider ?? countingFakeProvider();
  const sapAiBatch =
    options.sapAiBatch === undefined || options.sapAiBatch === false
      ? {}
      : sapAiBatchOverrides(options.sapAiBatch);
  const running = await startServer({
    stateDir,
    templatesDir: TEMPLATES_DIR,
    port: 0,
    aiProvider: provider,
    leaseTtlMs: 1_000,
    presenceTtlMs: 1_000,
    heartbeatSweepMs: 20,
    stagePollMs: 20,
    env,
    ...sapAiBatch,
    ...options.overrides,
  });
  return {
    running,
    stateDir,
    secret,
    userToken: issueToken({ kind: 'user', sub: 'user-1', secret }),
    adminToken: issueToken({ kind: 'admin', sub: 'admin-1', secret }),
    provider,
    env,
    dispose: async () => {
      await running.close();
      if (ownsStateDir) rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

export interface SapRequestOptions {
  /** Defaults to the SAP HMAC secret; pass another value for negative tests. */
  secret?: string;
  /** ISO-8601; pass an old value to exercise the ±5 min replay window. */
  timestamp?: string;
  delivery?: string;
  /** Extra headers merged after the HMAC headers. */
  headers?: Record<string, string>;
  /** Drop selected X-SA-* headers to test the 401 paths. */
  omit?: ReadonlyArray<'signature' | 'timestamp' | 'delivery'>;
  token?: string;
  method?: string;
}

/** POST the *exact* JSON body the signature was computed over. */
export async function signedSapRequest<T = unknown>(
  server: SapTestServer,
  path: string,
  body: unknown = {},
  options: SapRequestOptions = {},
): Promise<ApiResponse<T> & { rawBody: string }> {
  const rawBody = JSON.stringify(body ?? {});
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const stamp = buildSapHookHeaders({
    secret: options.secret ?? SAP_HOOK_SECRET,
    body: rawBody,
    delivery: options.delivery ?? newUlid(),
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });
  for (const [name, value] of Object.entries(stamp)) {
    const short = name.replace('x-sa-', '') as 'signature' | 'timestamp' | 'delivery';
    if (options.omit?.includes(short) === true) continue;
    headers[name] = value;
  }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  Object.assign(headers, options.headers);
  const response = await fetch(`${server.running.url}${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: rawBody,
  });
  const text = await response.text();
  const parsed = text.length === 0 ? undefined : (JSON.parse(text) as T);
  return { status: response.status, body: parsed as T, headers: response.headers, rawBody };
}

/** Signed `POST /api/v1/sap/ai-jobs/next`. */
export function nextJobs(
  server: SapTestServer,
  limit?: number,
): Promise<ApiResponse<SapAiJobsResponse> & { rawBody: string }> {
  return signedSapRequest<SapAiJobsResponse>(
    server,
    '/api/v1/sap/ai-jobs/next',
    limit === undefined ? {} : { limit },
  );
}

export function claimJob(
  server: SapTestServer,
  jobId: string,
): Promise<ApiResponse<SapAiJobClaimResponse> & { rawBody: string }> {
  return signedSapRequest<SapAiJobClaimResponse>(server, `/api/v1/sap/ai-jobs/${jobId}/claim`, {});
}

export function heartbeatJob(
  server: SapTestServer,
  jobId: string,
  claimId: string,
): Promise<ApiResponse<SapAiJobHeartbeatResponse> & { rawBody: string }> {
  return signedSapRequest<SapAiJobHeartbeatResponse>(server, `/api/v1/sap/ai-jobs/${jobId}/heartbeat`, {
    claimId,
  });
}

export function sendJobResult(
  server: SapTestServer,
  jobId: string,
  body: SapAiJobResultBody,
): Promise<ApiResponse<SapAiJobResultResponse> & { rawBody: string }> {
  return signedSapRequest<SapAiJobResultResponse>(server, `/api/v1/sap/ai-jobs/${jobId}/result`, body);
}

export function requeueJob(
  server: SapTestServer,
  jobId: string,
  token: string | null = server.adminToken,
  reason?: string,
): Promise<ApiResponse<SapAiJobRequeueResponse> & { rawBody: string }> {
  const options: SapRequestOptions = {};
  if (token !== null) options.token = token;
  if (reason !== undefined) options.headers = { 'x-test-reason': reason };
  return signedSapRequest<SapAiJobRequeueResponse>(
    server,
    `/api/v1/admin/sap/ai-jobs/${jobId}/requeue`,
    reason === undefined ? {} : { reason },
    options,
  );
}

export interface SapStatusResponse {
  enabled: { outbound: boolean; inbound: boolean };
  outbox: unknown;
  aiJobs?: SapAiJobsStatus;
  serverTime: string;
}

export async function sapStatus(
  server: SapTestServer,
  token: string | null = server.adminToken,
): Promise<ApiResponse<SapStatusResponse>> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${server.running.url}/hooks/sap/status`, { headers });
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length === 0 ? undefined : JSON.parse(text)) as SapStatusResponse,
    headers: response.headers,
  };
}

/** Poll `next` until a queued job matches; also verifies the response schema shape. */
export function waitForQueuedJob(
  server: SapTestServer,
  predicate: (job: SapAiJob) => boolean = () => true,
  label = 'queued SAP AI job',
): Promise<SapAiJob> {
  return waitFor(
    async () => {
      const response = await nextJobs(server);
      if (response.status !== 200) return undefined;
      return response.body.jobs.find(predicate);
    },
    { label, timeoutMs: 8_000 },
  );
}

/** Poll `next` until the job list (queued jobs) is empty. */
export function waitForNoQueuedJobs(server: SapTestServer, timeoutMs = 8_000): Promise<true> {
  return waitFor(
    async () => {
      const response = await nextJobs(server);
      if (response.status !== 200) return undefined;
      return response.body.jobs.length === 0 ? (true as const) : undefined;
    },
    { label: 'no queued SAP AI jobs', timeoutMs },
  );
}

export interface WaitingStageStatus {
  detail: unknown;
  status: string;
}

export async function events(server: SapTestServer): Promise<EventEnvelope[]> {
  const response = await fetch(`${server.running.url}/api/v1/events?after=0&limit=500`, {
    headers: { authorization: `Bearer ${server.userToken}` },
  });
  if (response.status !== 200) throw new Error(`events request failed: ${response.status}`);
  const body = (await response.json()) as { events: EventEnvelope[] };
  return body.events;
}

export function eventsOfType(list: readonly EventEnvelope[], type: string): EventEnvelope[] {
  return list.filter((event) => event.type === type);
}

// ---------------------------------------------------------------------------
// Direct sqlite access (tests may construct/repair state the public API cannot
// produce, e.g. "running stage without a job" for restart recovery).
// ---------------------------------------------------------------------------

export interface SapAiJobRow {
  id: string;
  stage_run_id: string;
  demand_id: string;
  attempt: number;
  stage_key: string;
  state: string;
  payload: string;
  claim_id: string | null;
  lease_expires_at: string | null;
  result: string | null;
  last_error: string | null;
  lease_expiries: number | null;
  created_at: string;
  updated_at: string;
}

export function withStateDb<T>(server: SapTestServer, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.stateDir, 'state.db'));
  db.exec('PRAGMA busy_timeout = 2000;');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function listJobRows(server: SapTestServer): SapAiJobRow[] {
  return withStateDb(server, (db) => {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sap_ai_jobs'")
      .get();
    if (table === undefined) return [];
    const rows = db.prepare('SELECT * FROM sap_ai_jobs ORDER BY created_at ASC').all();
    return rows as unknown as SapAiJobRow[];
  });
}

export function getJobRow(server: SapTestServer, jobId: string): SapAiJobRow | null {
  return listJobRows(server).find((row) => row.id === jobId) ?? null;
}

export function countRows(server: SapTestServer, table: 'sap_ai_jobs' | 'stage_attempts' | 'artifact_versions' | 'artifacts'): number {
  return withStateDb(server, (db) => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
      | { count: number }
      | undefined;
    return Number(row?.count ?? 0);
  });
}

export function deleteJobRows(server: SapTestServer): void {
  withStateDb(server, (db) => {
    db.exec('DELETE FROM sap_ai_jobs');
  });
}

export function forceJobState(
  server: SapTestServer,
  jobId: string,
  patch: {
    state?: string;
    leaseExpiresAt?: string | null;
    lastError?: string | null;
    claimId?: string | null;
  },
): void {
  withStateDb(server, (db) => {
    const current = db.prepare('SELECT * FROM sap_ai_jobs WHERE id = ?').get(jobId) as
      | SapAiJobRow
      | undefined;
    if (current === undefined) throw new Error(`sap_ai_jobs row ${jobId} not found`);
    db.prepare(
      'UPDATE sap_ai_jobs SET state = ?, lease_expires_at = ?, last_error = ?, claim_id = ?, updated_at = ? WHERE id = ?',
    ).run(
      patch.state ?? current.state,
      patch.leaseExpiresAt === undefined ? current.lease_expires_at : patch.leaseExpiresAt,
      patch.lastError === undefined ? current.last_error : patch.lastError,
      patch.claimId === undefined ? current.claim_id : patch.claimId,
      new Date().toISOString(),
      jobId,
    );
  });
}
