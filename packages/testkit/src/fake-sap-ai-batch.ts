import { createHmac } from 'node:crypto';
import type {
  SapAiJob,
  SapAiJobClaimResponse,
  SapAiJobHeartbeatResponse,
  SapAiJobsResponse,
  SapAiJobResultBody,
  SapAiJobResultResponse,
  SapAiJobUsage,
} from '@sap-superagent/protocol';
import { TestApiError } from './http.js';

// ---------------------------------------------------------------------------
// S5: in-process fake SAP batch executor (`ZCL_ZSA_AI_BATCH`, docs/003 §4.8).
//
// It behaves like the ABAP program scheduled by SM36: pull queued AI jobs over
// the HMAC-authenticated `/api/v1/sap/ai-jobs/*` API, claim them, forward the
// control-plane rendered messages to the enterprise AI gateway, and post the
// raw model output back as a result. JSON extraction / schema / checklist /
// gates stay on the control plane — the batch never validates business output.
//
// Signing reuses the documented SAP webhook rule
//   X-SA-Signature: sha256=<hex(HMAC-SHA256(secret, rawBody))>
// plus `X-SA-Timestamp` and a per-call `X-SA-Delivery` idempotency key
// (docs/003 §4.8.4). The implementation is local so the testkit runtime keeps
// depending only on protocol/core + node.
//
// Privacy: request log stores method/path/status/ids only — never prompts or
// model output text (data boundary, docs/003 §4.8.3).
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_LIMIT = 5;
const MAX_BATCH_LIMIT = 50;
/** Upper bound for one gateway call so a hung fake cannot wedge the suite. */
const DEFAULT_GATEWAY_TIMEOUT_MS = 30_000;
const DEFAULT_DELIVERY_PREFIX = 'fake-sap-ai-batch';

function computeSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/** Map an OpenAI-compatible `usage` block onto the protocol accounting shape. */
function readGatewayUsage(parsed: unknown, fallbackModel: string): SapAiJobUsage | undefined {
  const root = asRecord(parsed);
  if (root === null) return undefined;
  const usage = asRecord(root['usage']);
  if (usage === null) return undefined;
  const pick = (snake: string, camel: string): number | undefined =>
    nonNegativeInt(usage[snake]) ?? nonNegativeInt(usage[camel]);
  const promptTokens = pick('prompt_tokens', 'promptTokens');
  const completionTokens = pick('completion_tokens', 'completionTokens');
  const totalTokens = pick('total_tokens', 'totalTokens');
  const rawModel = root['model'];
  const model =
    typeof rawModel === 'string' && rawModel.length > 0 && rawModel.length <= 200
      ? rawModel
      : fallbackModel;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(model.length === 0 ? {} : { model }),
  };
}

function readAssistantContent(parsed: unknown): string | undefined {
  const root = asRecord(parsed);
  if (root === null) return undefined;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice = asRecord(choices[0]);
  if (choice === null) return undefined;
  const message = asRecord(choice['message']);
  if (message === null) return undefined;
  const content = message['content'];
  return typeof content === 'string' ? content : undefined;
}

function withClaimId(body: SapAiJobResultBody, claimId: string): SapAiJobResultBody {
  return body.status === 'succeeded' ? { ...body, claimId } : { ...body, claimId };
}

/** One-shot injected batch failure, consumed by the next processed job. */
export type FakeSapAiBatchFaultKind =
  | 'gateway_failure'
  | 'invalid_output'
  | 'claim_conflict'
  | 'wrong_claim_id'
  | 'duplicate_result'
  | 'skip_job'
  | 'lease_expired';

export interface FakeSapAiBatchFault {
  kind: FakeSapAiBatchFaultKind;
  /** Error message carried by `gateway_failure` / `invalid_output`. */
  message?: string;
  /** `retryable` flag of the failed result sent for `gateway_failure`. */
  retryable?: boolean;
  /** Succeeded-but-invalid output text for `invalid_output`. */
  outputText?: string;
}

export interface FakeSapAiBatchRequestLogEntry {
  kind: 'next' | 'claim' | 'heartbeat' | 'result';
  path: string;
  status: number;
  delivery: string;
  jobId?: string;
  at: string;
}

/** What happened to one SAP job (never carries prompt/output text). */
export interface FakeSapAiBatchProcessedJob {
  jobId: string;
  stageRunId: string;
  stageKey: string;
  attempt: number;
  claimId: string | null;
  state: 'succeeded' | 'failed' | 'skipped';
  /** Result HTTP status (null when the job was skipped before any result). */
  resultStatus: number | null;
  /** `duplicate` flag of the result response (or of the replay for `duplicate_result`). */
  duplicate: boolean | null;
  /** Second claim status for `claim_conflict` (expected 409). */
  conflictingClaimStatus: number | null;
  /** Wrong-claimId result status for `wrong_claim_id` (expected 409). */
  wrongClaimStatus: number | null;
  /** Number of enterprise gateway calls made for this job. */
  gatewayRequests: number;
  /** Short failure code/message when the gateway call failed (no prompt text). */
  error: string | null;
  /** Length of the posted `outputText` (0 for failed/skipped jobs). */
  outputTextLength: number;
}

export interface FakeSapAiBatchOptions {
  /** Control-plane base URL, e.g. `RunningServer.url`. */
  controlPlaneUrl: string;
  /** Shared `SA_SAP_HOOK_SECRET` used for the X-SA-* HMAC headers. */
  hookSecret: string;
  /** Fake enterprise AI gateway base URL (`FakeAiGateway.url`). */
  gatewayUrl?: string;
  /** Direct output provider used when no `gatewayUrl` is configured. */
  outputFor?: (job: SapAiJob) => string;
  /** Send one heartbeat after claim and before posting the result. */
  heartbeatBeforeResult?: boolean;
  /** Per-call gateway timeout; defaults to the payload hint capped at 30s. */
  gatewayTimeoutMs?: number;
  /** Local retries on retryable gateway failures (5xx/429/timeout). */
  gatewayRetries?: number;
  /** Extra wait between claim and result (test-only lease scenarios). */
  resultDelayMs?: number;
  /** Prefix for the `X-SA-Delivery` idempotency keys. */
  deliveryPrefix?: string;
  clock?: () => number;
}

export class FakeSapAiBatch {
  readonly controlPlaneUrl: string;
  /** Request log (method/path/status/ids only; no prompt or output text). */
  readonly requests: FakeSapAiBatchRequestLogEntry[] = [];
  /** Jobs processed in call order. */
  readonly processed: FakeSapAiBatchProcessedJob[] = [];
  /** Last background-loop error (set by `start()`; never carries prompt text). */
  lastError: string | null = null;

  private readonly options: FakeSapAiBatchOptions;
  private readonly clock: () => number;
  private faults: FakeSapAiBatchFault[] = [];
  private timer: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;
  private sequence = 0;

  constructor(options: FakeSapAiBatchOptions) {
    if (options.gatewayUrl === undefined && options.outputFor === undefined) {
      throw new Error('FakeSapAiBatch requires either a gatewayUrl or an outputFor callback');
    }
    this.options = options;
    this.controlPlaneUrl = options.controlPlaneUrl;
    this.clock = options.clock ?? ((): number => Date.now());
  }

  private now(): number {
    return this.clock();
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Poll `next` on an interval (SM36-style background loop). */
  start(options: { intervalMs?: number } = {}): void {
    if (this.timer !== null) return;
    this.stopped = false;
    const intervalMs = options.intervalMs ?? 25;
    this.timer = setInterval(() => {
      if (this.stopped || this.loop !== null) return;
      this.loop = this.pump()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.loop = null;
        });
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.loop !== null) await this.loop;
  }

  injectFault(fault: FakeSapAiBatchFault): void {
    this.faults.push(fault);
  }

  clearFaults(): void {
    this.faults = [];
  }

  reset(): void {
    this.requests.length = 0;
    this.processed.length = 0;
    this.faults = [];
    this.sequence = 0;
    this.lastError = null;
  }

  private nextFault(): FakeSapAiBatchFault | undefined {
    return this.faults.shift();
  }

  private async postJson(
    kind: FakeSapAiBatchRequestLogEntry['kind'],
    path: string,
    body: unknown,
    options: { jobId?: string; delivery?: string } = {},
  ): Promise<{ status: number; body: unknown; delivery: string }> {
    this.sequence += 1;
    const delivery =
      options.delivery ?? `${this.options.deliveryPrefix ?? DEFAULT_DELIVERY_PREFIX}-${this.sequence}`;
    const rawBody = JSON.stringify(body);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-sa-signature': computeSignature(this.options.hookSecret, rawBody),
      'x-sa-timestamp': new Date(this.now()).toISOString(),
      'x-sa-delivery': delivery,
    };
    const response = await fetch(new URL(path, this.controlPlaneUrl), {
      method: 'POST',
      headers,
      body: rawBody,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = text;
    }
    this.requests.push({
      kind,
      path,
      status: response.status,
      delivery,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      at: new Date(this.now()).toISOString(),
    });
    return { status: response.status, body: parsed, delivery };
  }

  /**
   * Drain up to `maxJobs` queued jobs (one `next` call, like one SM36 run).
   * Returns what happened per job; never throws for a per-job failure (record
   * it in the entry instead) so tests can assert the failed lifecycle.
   */
  async pump(options: { maxJobs?: number } = {}): Promise<FakeSapAiBatchProcessedJob[]> {
    const limit = Math.max(1, Math.min(options.maxJobs ?? DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT));
    const next = await this.postJson('next', '/api/v1/sap/ai-jobs/next', { limit });
    if (next.status !== 200) {
      throw new TestApiError(
        `POST /api/v1/sap/ai-jobs/next failed with HTTP ${next.status}`,
        next.status,
        next.body,
      );
    }
    const list = next.body as SapAiJobsResponse;
    if (!Array.isArray(list.jobs)) {
      throw new TestApiError(
        'POST /api/v1/sap/ai-jobs/next returned no jobs array',
        next.status,
        next.body,
      );
    }
    const jobs = list.jobs.slice(0, limit);
    const processed: FakeSapAiBatchProcessedJob[] = [];
    for (const job of jobs) {
      const entry = await this.processJob(job, this.nextFault());
      this.processed.push(entry);
      processed.push(entry);
    }
    return processed;
  }

  private async processJob(
    job: SapAiJob,
    fault: FakeSapAiBatchFault | undefined,
  ): Promise<FakeSapAiBatchProcessedJob> {
    const base = {
      jobId: job.id,
      stageRunId: job.stageRunId,
      stageKey: job.stageKey,
      attempt: job.attempt,
    };
    if (fault?.kind === 'skip_job') {
      return {
        ...base,
        claimId: null,
        state: 'skipped',
        resultStatus: null,
        duplicate: null,
        conflictingClaimStatus: null,
        wrongClaimStatus: null,
        gatewayRequests: 0,
        outputTextLength: 0,
        error: null,
      };
    }

    const claim = await this.postJson('claim', `/api/v1/sap/ai-jobs/${job.id}/claim`, {}, {
      jobId: job.id,
    });
    if (claim.status !== 200) {
      // Another worker owns the lease; leave it to the control-plane sweeper.
      return {
        ...base,
        claimId: null,
        state: 'skipped',
        resultStatus: claim.status,
        duplicate: null,
        conflictingClaimStatus: null,
        wrongClaimStatus: null,
        gatewayRequests: 0,
        outputTextLength: 0,
        error: null,
      };
    }
    const claimResponse = claim.body as SapAiJobClaimResponse;
    let claimId = claimResponse.claimId;
    let conflictingClaimStatus: number | null = null;
    let wrongClaimStatus: number | null = null;

    if (fault?.kind === 'claim_conflict') {
      const second = await this.postJson('claim', `/api/v1/sap/ai-jobs/${job.id}/claim`, {}, {
        jobId: job.id,
      });
      conflictingClaimStatus = second.status;
    }

    if (fault?.kind === 'lease_expired') {
      // Let the control-plane lease expire before posting the stale result.
      await delay(Math.max(0, Date.parse(claimResponse.lease.expiresAt) - this.now()) + 25);
    } else if (this.options.heartbeatBeforeResult === true) {
      const heartbeat = await this.postJson(
        'heartbeat',
        `/api/v1/sap/ai-jobs/${job.id}/heartbeat`,
        { claimId },
        { jobId: job.id },
      );
      if (heartbeat.status === 200) {
        claimId = (heartbeat.body as SapAiJobHeartbeatResponse).claimId;
      }
    }

    if (this.options.resultDelayMs !== undefined) await delay(this.options.resultDelayMs);

    const startedAt = this.now();
    let gatewayRequests = 0;
    let state: FakeSapAiBatchProcessedJob['state'];
    let outputTextLength = 0;
    let error: string | null = null;
    let resultBody: SapAiJobResultBody;

    if (fault?.kind === 'gateway_failure') {
      state = 'failed';
      error = fault.message ?? 'enterprise AI gateway call failed';
      resultBody = {
        claimId,
        status: 'failed',
        error: {
          code: 'gateway_error',
          message: fault.message ?? 'enterprise AI gateway call failed',
          retryable: fault.retryable ?? false,
        },
        durationMs: Math.max(0, this.now() - startedAt),
      };
    } else {
      const outcome = await this.produceOutput(job);
      gatewayRequests = outcome.gatewayRequests;
      const durationMs = Math.max(0, this.now() - startedAt);
      if (outcome.error !== undefined) {
        state = 'failed';
        error = outcome.error.code === undefined ? outcome.error.message : `${outcome.error.code}: ${outcome.error.message}`;
        resultBody = {
          claimId,
          status: 'failed',
          error: outcome.error,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          durationMs,
        };
      } else {
        state = 'succeeded';
        const outputText =
          fault?.kind === 'invalid_output'
            ? (fault.outputText ?? 'this output is not valid JSON')
            : (outcome.content ?? '');
        outputTextLength = outputText.length;
        resultBody = {
          claimId,
          status: 'succeeded',
          outputText,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          durationMs,
        };
      }
    }

    if (fault?.kind === 'wrong_claim_id') {
      const wrong = await this.postJson(
        'result',
        `/api/v1/sap/ai-jobs/${job.id}/result`,
        withClaimId(resultBody, `${claimId}-wrong`),
        { jobId: job.id },
      );
      wrongClaimStatus = wrong.status;
    }

    const result = await this.postJson(
      'result',
      `/api/v1/sap/ai-jobs/${job.id}/result`,
      resultBody,
      { jobId: job.id },
    );
    let duplicate =
      result.status >= 200 && result.status < 300
        ? ((result.body as SapAiJobResultResponse | undefined)?.duplicate ?? null)
        : null;

    if (fault?.kind === 'duplicate_result') {
      // Replay the exact same result body with a fresh delivery header.
      const replay = await this.postJson(
        'result',
        `/api/v1/sap/ai-jobs/${job.id}/result`,
        resultBody,
        { jobId: job.id },
      );
      duplicate =
        replay.status >= 200 && replay.status < 300
          ? ((replay.body as SapAiJobResultResponse | undefined)?.duplicate ?? null)
          : null;
    }

    return {
      ...base,
      claimId,
      state,
      resultStatus: result.status,
      duplicate,
      conflictingClaimStatus,
      wrongClaimStatus,
      gatewayRequests,
      outputTextLength,
      error,
    };
  }

  /**
   * Produce the raw model output: call the enterprise gateway, or use the
   * configured `outputFor` callback when the batch runs without a gateway.
   */
  private async produceOutput(job: SapAiJob): Promise<{
    content?: string;
    usage?: SapAiJobUsage;
    error?: { code?: string; message: string; retryable?: boolean };
    gatewayRequests: number;
  }> {
    const gatewayUrl = this.options.gatewayUrl;
    if (gatewayUrl === undefined) {
      const direct = this.options.outputFor?.(job);
      if (direct === undefined) {
        return {
          error: {
            code: 'batch_misconfigured',
            message: 'FakeSapAiBatch has neither gatewayUrl nor outputFor',
            retryable: false,
          },
          gatewayRequests: 0,
        };
      }
      return { content: direct, gatewayRequests: 0 };
    }

    const payload = job.payload;
    const model = payload.model;
    const requestBody = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: payload.systemPrompt },
        { role: 'user', content: payload.prompt },
      ],
      temperature: 0,
      ...(payload.maxOutputTokens === undefined
        ? {}
        : { max_tokens: payload.maxOutputTokens }),
    });
    const timeoutMs = Math.min(
      this.options.gatewayTimeoutMs ?? payload.timeoutMs,
      DEFAULT_GATEWAY_TIMEOUT_MS,
    );
    const attempts = 1 + Math.max(0, this.options.gatewayRetries ?? 0);
    let gatewayRequests = 0;
    let lastError: { code: string; message: string; retryable: boolean } = {
      code: 'gateway_error',
      message: 'enterprise AI gateway call failed',
      retryable: true,
    };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      gatewayRequests += 1;
      let response: Response;
      try {
        response = await fetch(new URL('/chat/completions', gatewayUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        lastError = {
          code: timedOut ? 'gateway_timeout' : 'gateway_unreachable',
          message: timedOut
            ? 'enterprise AI gateway call timed out'
            : 'enterprise AI gateway is unreachable',
          retryable: true,
        };
        if (attempt < attempts - 1) continue;
        break;
      }
      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        lastError = {
          code: `gateway_http_${response.status}`,
          message: `enterprise AI gateway returned HTTP ${response.status}`,
          retryable,
        };
        if (retryable && attempt < attempts - 1) continue;
        break;
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        lastError = {
          code: 'gateway_bad_json',
          message: 'enterprise AI gateway returned a non-JSON response',
          retryable: true,
        };
        if (attempt < attempts - 1) continue;
        break;
      }
      const content = readAssistantContent(parsed);
      if (content === undefined || content.length === 0) {
        lastError = {
          code: 'gateway_bad_response',
          message: 'enterprise AI gateway response has no choices[0].message.content',
          retryable: true,
        };
        if (attempt < attempts - 1) continue;
        break;
      }
      const usage = readGatewayUsage(parsed, model);
      return {
        content,
        ...(usage === undefined ? {} : { usage }),
        gatewayRequests,
      };
    }
    return { error: lastError, gatewayRequests };
  }
}
