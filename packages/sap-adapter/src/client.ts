import type {
  SapApprovalRecord,
  SapArtifactRecord,
  SapDemandRecord,
  SapWritebackPatch,
} from './mapping.js';

// ---------------------------------------------------------------------------
// ICF JSON client for the SAP demand API (docs/004 §3.2). The control plane
// calls SAP with a dedicated service account (basic over TLS) or a service
// token; only `PATCH /api/demands/{id}` writes, and it uses `If-Match` for
// optimistic concurrency (docs/004 §3.2, docs/008 §3 "SAP 回写").
//
// Writes are **never retried here**: the outbox worker owns backoff, dead
// letters and the 409 re-pull/replay loop (docs/008 §5, docs/009 #11/#12).
// Only idempotent GETs are retried, and session errors are classified as
// non-retryable (docs/009 #6: no automatic retry of write operations).
// ---------------------------------------------------------------------------

export type SapIcfErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_required'
  | 'validation'
  | 'session_timeout'
  | 'rate_limited'
  | 'server_error'
  | 'bad_request'
  | 'network_error'
  | 'timeout'
  | 'invalid_response';

export class SapIcfError extends Error {
  readonly kind: SapIcfErrorKind;
  /** HTTP status, `0` for transport-level failures. */
  readonly status: number;
  /** Retrying the same request could succeed (network/5xx/429). */
  readonly retryable: boolean;
  /** Parsed SAP error envelope, when the response carried one. */
  readonly body: unknown;

  constructor(kind: SapIcfErrorKind, message: string, options: {
    status?: number;
    retryable?: boolean;
    body?: unknown;
  } = {}) {
    super(message);
    this.name = 'SapIcfError';
    this.kind = kind;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.body = options.body;
  }
}

function messageFromBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as { error?: { message?: unknown }; message?: unknown };
  if (typeof candidate.error?.message === 'string') return candidate.error.message;
  if (typeof candidate.message === 'string') return candidate.message;
  return null;
}

const SESSION_ERROR_PATTERN = /session\s*(timed?\s*out|expired|timeout)|重新登录|ICF.*session/i;

/** Map a SAP ICF HTTP failure onto a typed, retryable-aware error (docs/009 #6/#9). */
export function classifySapHttpError(status: number, body: unknown): SapIcfError {
  const detail = messageFromBody(body);
  const suffix = detail === null ? '' : `: ${detail}`;
  if (status === 401) {
    return new SapIcfError('unauthorized', `SAP service authentication failed (401)${suffix}`, {
      status,
      retryable: false,
      body,
    });
  }
  if (status === 403) {
    return new SapIcfError('forbidden', `SAP service account is not authorized (403)${suffix}`, {
      status,
      retryable: false,
      body,
    });
  }
  if (status === 404) {
    return new SapIcfError('not_found', `SAP resource not found (404)${suffix}`, {
      status,
      retryable: false,
      body,
    });
  }
  if (status === 409 || status === 412) {
    return new SapIcfError('conflict', `SAP optimistic-concurrency conflict (${status})${suffix}`, {
      status,
      retryable: false,
      body,
    });
  }
  if (status === 428) {
    return new SapIcfError(
      'precondition_required',
      `SAP requires If-Match for this write (428)${suffix}`,
      { status, retryable: false, body },
    );
  }
  if (status === 429) {
    return new SapIcfError('rate_limited', `SAP rate-limited the request (429)${suffix}`, {
      status,
      retryable: true,
      body,
    });
  }
  if (status >= 500) {
    return new SapIcfError('server_error', `SAP internal error (${status})${suffix}`, {
      status,
      retryable: true,
      body,
    });
  }
  if (status === 400 && SESSION_ERROR_PATTERN.test(detail ?? '')) {
    return new SapIcfError('session_timeout', `SAP session expired (400)${suffix}`, {
      status,
      retryable: false,
      body,
    });
  }
  if (status === 400 || status === 422) {
    return new SapIcfError('validation', `SAP rejected the request (${status})${suffix}`, {
      status,
      retryable: false,
      body,
    });
  }
  return new SapIcfError('bad_request', `SAP request failed (${status})${suffix}`, {
    status,
    retryable: false,
    body,
  });
}

export interface SapIcfClientOptions {
  /** ICF root, e.g. `https://sap.example:44300/sap/zsa` (base for `/api/*`). */
  baseUrl: string;
  username?: string;
  password?: string;
  /** Alternative to basic auth; sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Per-request timeout (default 10s). */
  timeoutMs?: number;
  /** Extra attempts for idempotent GETs only (default 1 retry). */
  getRetries?: number;
  /** Base delay between GET retries (default 100ms). */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SapHealth {
  status: string;
  system?: string;
  version?: string;
}

export interface SapDemandList {
  demands: SapDemandRecord[];
  serverTime?: string;
}

export interface SapDemandDetail {
  demand: SapDemandRecord;
  artifacts: SapArtifactRecord[];
  approvals: SapApprovalRecord[];
  serverTime?: string;
}

export interface SapDemandWriteResult {
  demand: SapDemandRecord;
  serverTime?: string;
}

export interface SapListDemandsQuery {
  status?: string;
  changedSince?: string;
  q?: string;
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertDemandRecord(value: unknown, context: string): SapDemandRecord {
  if (!isRecord(value) || typeof value['demandId'] !== 'string' || value['demandId'].length === 0) {
    throw new SapIcfError('invalid_response', `SAP ${context}: missing demand.demandId`);
  }
  return value as unknown as SapDemandRecord;
}

const RETRYABLE_TRANSPORT: ReadonlySet<SapIcfErrorKind> = new Set([
  'network_error',
  'timeout',
  'server_error',
  'rate_limited',
]);

function isRetryableError(error: unknown): error is SapIcfError {
  return error instanceof SapIcfError && RETRYABLE_TRANSPORT.has(error.kind) && error.retryable;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal typed ICF JSON client. Errors are always `SapIcfError`; callers (the
 * writeback worker) branch on `kind`/`retryable` instead of parsing messages.
 */
export class SapIcfClient {
  readonly baseUrl: string;
  private readonly options: SapIcfClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SapIcfClientOptions) {
    if (options.baseUrl.length === 0) throw new Error('SapIcfClient requires a baseUrl');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async health(): Promise<SapHealth> {
    const body = await this.request('GET', '/api/health');
    if (!isRecord(body) || typeof body['status'] !== 'string') {
      throw new SapIcfError('invalid_response', 'SAP health response has no status');
    }
    const health: SapHealth = { status: body['status'] };
    if (typeof body['system'] === 'string') health.system = body['system'];
    if (typeof body['version'] === 'string') health.version = body['version'];
    return health;
  }

  async listDemands(query: SapListDemandsQuery = {}): Promise<SapDemandList> {
    const params = new URLSearchParams();
    if (query.status !== undefined) params.set('status', query.status);
    if (query.changedSince !== undefined) params.set('changedSince', query.changedSince);
    if (query.q !== undefined) params.set('q', query.q);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    const body = await this.request('GET', `/api/demands${suffix}`);
    if (!isRecord(body) || !Array.isArray(body['demands'])) {
      throw new SapIcfError('invalid_response', 'SAP demand list response has no demands array');
    }
    const result: SapDemandList = {
      demands: body['demands'].map((entry) => assertDemandRecord(entry, 'demand list')),
    };
    if (typeof body['serverTime'] === 'string') result.serverTime = body['serverTime'];
    return result;
  }

  async getDemand(demandId: string): Promise<SapDemandDetail> {
    const body = await this.request('GET', `/api/demands/${encodeURIComponent(demandId)}`);
    if (!isRecord(body)) {
      throw new SapIcfError('invalid_response', 'SAP demand detail response is not an object');
    }
    const artifacts = Array.isArray(body['artifacts'])
      ? (body['artifacts'] as SapArtifactRecord[])
      : [];
    const approvals = Array.isArray(body['approvals'])
      ? (body['approvals'] as SapApprovalRecord[])
      : [];
    const detail: SapDemandDetail = {
      demand: assertDemandRecord(body['demand'], 'demand detail'),
      artifacts,
      approvals,
    };
    if (typeof body['serverTime'] === 'string') detail.serverTime = body['serverTime'];
    return detail;
  }

  async createDemand(input: Record<string, unknown>): Promise<SapDemandWriteResult> {
    const body = await this.request('POST', '/api/demands', { body: input });
    if (!isRecord(body)) {
      throw new SapIcfError('invalid_response', 'SAP create-demand response is not an object');
    }
    return this.writeResult(body, 'create-demand');
  }

  /**
   * Write the status projection / artifact metadata (docs/004 §3.2 whitelist).
   * `ifMatch` is the SAP version last observed by the control plane.
   */
  async patchDemand(
    demandId: string,
    patch: SapWritebackPatch | Record<string, unknown>,
    options: { ifMatch?: string | number } = {},
  ): Promise<SapDemandWriteResult> {
    const body = await this.request('PATCH', `/api/demands/${encodeURIComponent(demandId)}`, {
      body: patch,
      ...(options.ifMatch === undefined ? {} : { headers: { 'if-match': String(options.ifMatch) } }),
    });
    if (!isRecord(body)) {
      throw new SapIcfError('invalid_response', 'SAP patch response is not an object');
    }
    return this.writeResult(body, 'patch-demand');
  }

  async createApproval(
    demandId: string,
    input: Record<string, unknown>,
  ): Promise<{ approval: SapApprovalRecord }> {
    const body = await this.request(
      'POST',
      `/api/demands/${encodeURIComponent(demandId)}/approvals`,
      { body: input },
    );
    if (!isRecord(body) || !isRecord(body['approval'])) {
      throw new SapIcfError('invalid_response', 'SAP approval response has no approval object');
    }
    return { approval: body['approval'] as unknown as SapApprovalRecord };
  }

  private writeResult(body: Record<string, unknown>, context: string): SapDemandWriteResult {
    const demand = assertDemandRecord(body['demand'], context);
    const result: SapDemandWriteResult = { demand };
    if (typeof body['serverTime'] === 'string') result.serverTime = body['serverTime'];
    return result;
  }

  private authHeader(): string | undefined {
    if (this.options.token !== undefined && this.options.token.length > 0) {
      return `Bearer ${this.options.token}`;
    }
    if (this.options.username !== undefined && this.options.password !== undefined) {
      const raw = `${this.options.username}:${this.options.password}`;
      return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
    }
    return undefined;
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const isIdempotent = method === 'GET';
    const attempts = isIdempotent ? Math.max(1, (this.options.getRetries ?? 1) + 1) : 1;
    const retryDelayMs = this.options.retryDelayMs ?? 100;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.attempt(method, path, options);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !isRetryableError(error)) break;
        if (retryDelayMs > 0) await delay(retryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  private async attempt(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { body?: unknown; headers?: Record<string, string> },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...options.headers,
    };
    const auth = this.authHeader();
    if (auth !== undefined) headers['authorization'] = auth;
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`${this.baseUrl}${path}`), init);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new SapIcfError('timeout', `SAP request timed out after ${this.options.timeoutMs ?? 10_000}ms`, {
          retryable: true,
        });
      }
      throw new SapIcfError('network_error', `SAP request failed: ${String(error)}`, {
        retryable: true,
      });
    }

    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new SapIcfError(
          'invalid_response',
          `SAP returned non-JSON payload (status ${response.status})`,
          { status: response.status, retryable: response.status >= 500, body: text },
        );
      }
    }

    if (!response.ok) throw classifySapHttpError(response.status, body);
    return body;
  }
}
