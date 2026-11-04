// Control-plane REST client used by the VSCode extension (docs/003 §4.2).
// Transport-only concern: callers own token storage, retries and UI. Every
// non-2xx response becomes a typed `ControlPlaneError` so presence logic can
// decide whether to pause (docs/005 §2.5).
import { z } from '@sap-superagent/protocol';
import {
  apiErrorBodySchema,
  claimTaskResponseSchema,
  completeTaskResponseSchema,
  failTaskResponseSchema,
  heartbeatResponseSchema,
  leaseRenewResponseSchema,
  listTasksResponseSchema,
  registerExecutorResponseSchema,
  releaseTaskResponseSchema,
  submitArtifactResponseSchema,
  taskContextResponseSchema,
  taskDetailResponseSchema,
  unregisterExecutorResponseSchema,
} from '@sap-superagent/protocol';
import type {
  CompleteTaskBody,
  ErrorCode,
  FailTaskBody,
  HeartbeatBody,
  ListTasksResponse,
  ProgressBody,
  RegisterExecutorBody,
  RegisterExecutorResponse,
  SubmitArtifactBody,
  Task,
} from '@sap-superagent/protocol';

export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;
export type TaskContextResponse = z.infer<typeof taskContextResponseSchema>;
export type SubmitArtifactResponse = z.infer<typeof submitArtifactResponseSchema>;
export type LeaseRenewResponse = z.infer<typeof leaseRenewResponseSchema>;
export type FailTaskResponse = z.infer<typeof failTaskResponseSchema>;
export type ReleaseTaskResponse = z.infer<typeof releaseTaskResponseSchema>;
export type UnregisterExecutorResponse = z.infer<typeof unregisterExecutorResponseSchema>;

/** `/api/v1` is the only version this client speaks (docs/003 §4.1). */
export const API_PREFIX = '/api/v1';
export const PROTOCOL_VERSION = '1';
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type ControlPlaneErrorCode = ErrorCode | 'network_error' | 'invalid_response';

export interface ControlPlaneErrorOptions {
  status: number;
  code: ControlPlaneErrorCode;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * One control-plane failure. `status === 0` means the request never reached the
 * server (network error); `code` is the protocol error code when the server
 * supplied one, otherwise a transport-level code.
 */
export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: ControlPlaneErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: ControlPlaneErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ControlPlaneError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ControlPlaneClientOptions {
  /** Base URL without `/api/v1` (also accepted with it). */
  baseUrl: string;
  token: string;
  /** Defaults to `globalThis.fetch`; injected by unit tests. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Omit for endpoints without a documented response body (`/progress`). */
  schema?: z.ZodType;
  /** Send a fresh `Idempotency-Key` (claim). */
  idempotent?: boolean;
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    throw new ControlPlaneError('控制平面地址为空，请先配置 sapSuperAgent.controlPlaneUrl。', {
      status: 0,
      code: 'bad_request',
      retryable: false,
    });
  }
  const withPath = trimmed.endsWith(API_PREFIX) ? trimmed : `${trimmed}${API_PREFIX}`;
  // Tolerate a base URL that already includes `/api/v1/`.
  return withPath.replace(/\/+$/, '');
}

function fallbackCodeForStatus(status: number): ErrorCode {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'internal_error';
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

export class ControlPlaneClient {
  private baseUrl: string;
  /**
   * Token used for `POST /executors/register`, which the server only accepts
   * from a `user`/`admin` token (docs/003 §4.2, H0 server implementation).
   * A successful register swaps `token` to the returned executor token.
   */
  private baseToken: string;
  private token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private executorId: string | null = null;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.baseToken = options.token;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Current base URL including `/api/v1`. */
  get endpoint(): string {
    return this.baseUrl;
  }

  /** The executor ID returned by the last successful register call. */
  get registeredExecutorId(): string | null {
    return this.executorId;
  }

  /** Use an executor token for executor-scoped calls (set by `registerExecutor`). */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * Set the user/admin token used for registration. When the client is not
   * registered yet, it also becomes the active token.
   */
  setBaseToken(token: string): void {
    this.baseToken = token;
    if (this.executorId === null) {
      this.token = token;
    }
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async registerExecutor(body: RegisterExecutorBody): Promise<RegisterExecutorResponse> {
    // Register with the user/admin token, then keep the executor token for
    // every executor-scoped endpoint (heartbeat/claim/context/...).
    this.token = this.baseToken;
    const response = await this.request<RegisterExecutorResponse>({
      method: 'POST',
      path: '/executors/register',
      body,
      schema: registerExecutorResponseSchema,
    });
    this.executorId = response.executor.id;
    this.token = response.executorToken;
    return response;
  }

  async heartbeat(body: HeartbeatBody): Promise<z.infer<typeof heartbeatResponseSchema>> {
    const executorId = this.requireExecutorId();
    return this.request({
      method: 'POST',
      path: `/executors/${encodeURIComponent(executorId)}/heartbeat`,
      body,
      schema: heartbeatResponseSchema,
    });
  }

  async unregister(): Promise<UnregisterExecutorResponse> {
    const executorId = this.executorId;
    if (executorId === null) {
      return { releasedTaskIds: [], serverTime: new Date().toISOString() };
    }
    const response = await this.request<UnregisterExecutorResponse>({
      method: 'DELETE',
      path: `/executors/${encodeURIComponent(executorId)}`,
      schema: unregisterExecutorResponseSchema,
    });
    this.executorId = null;
    this.token = this.baseToken;
    return response;
  }

  async listTasks(query: { state?: string; limit?: number } = {}): Promise<ListTasksResponse> {
    return this.request({
      method: 'GET',
      path: '/tasks',
      query: {
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      },
      schema: listTasksResponseSchema,
    });
  }

  async getTask(taskId: string): Promise<TaskDetailResponse> {
    return this.request({
      method: 'GET',
      path: `/tasks/${encodeURIComponent(taskId)}`,
      schema: taskDetailResponseSchema,
    });
  }

  async getContext(taskId: string): Promise<TaskContextResponse> {
    return this.request({
      method: 'GET',
      path: `/tasks/${encodeURIComponent(taskId)}/context`,
      schema: taskContextResponseSchema,
    });
  }

  async claim(taskId: string): Promise<z.infer<typeof claimTaskResponseSchema>> {
    return this.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(taskId)}/claim`,
      body: {},
      idempotent: true,
      schema: claimTaskResponseSchema,
    });
  }

  async renewLease(taskId: string): Promise<z.infer<typeof leaseRenewResponseSchema>> {
    return this.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(taskId)}/lease/renew`,
      body: {},
      schema: leaseRenewResponseSchema,
    });
  }

  async reportProgress(taskId: string, body: ProgressBody): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(taskId)}/progress`,
      body,
    });
  }

  async submitArtifact(taskId: string, body: SubmitArtifactBody): Promise<SubmitArtifactResponse> {
    return this.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(taskId)}/artifacts`,
      body,
      idempotent: true,
      schema: submitArtifactResponseSchema,
    });
  }

  async complete(taskId: string, body: CompleteTaskBody): Promise<z.infer<typeof completeTaskResponseSchema>> {
    return this.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(taskId)}/complete`,
      body,
      schema: completeTaskResponseSchema,
    });
  }

  async fail(taskId: string, body: FailTaskBody): Promise<FailTaskResponse> {
    return this.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(taskId)}/fail`,
      body,
      schema: failTaskResponseSchema,
    });
  }

  async release(taskId: string): Promise<ReleaseTaskResponse> {
    return this.request({
      method: 'POST',
      path: `/tasks/${encodeURIComponent(taskId)}/release`,
      body: {},
      schema: releaseTaskResponseSchema,
    });
  }

  /** Convenience helper for UI code that only needs the row body. */
  static taskOf(response: { task: Task }): Task {
    return response.task;
  }

  private requireExecutorId(): string {
    if (this.executorId === null) {
      throw new ControlPlaneError('执行器尚未注册，请先连接控制平面。', {
        status: 0,
        code: 'invalid_state',
        retryable: false,
      });
    }
    return this.executorId;
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async request<T = unknown>(options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.token}`,
    };
    const init: RequestInit = {
      method: options.method,
      headers,
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    if (options.idempotent === true) {
      headers['idempotency-key'] = globalThis.crypto.randomUUID();
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(options.path, options.query), init);
    } catch (cause) {
      throw new ControlPlaneError(`控制平面不可达：${describeCause(cause)}`, {
        status: 0,
        code: 'network_error',
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let payload: unknown;
    let parseError: unknown;
    let parsedOk = raw.trim() === '';
    if (!parsedOk) {
      try {
        payload = JSON.parse(raw);
        parsedOk = true;
      } catch (cause) {
        parseError = cause;
      }
    }

    if (!response.ok) {
      // A proxy/HTML error page is still an HTTP failure: map it by status.
      throw this.errorFromResponse(response.status, parsedOk ? payload : undefined);
    }
    if (!parsedOk) {
      throw new ControlPlaneError('控制平面返回了非 JSON 响应（版本或代理不匹配？）。', {
        status: response.status,
        code: 'invalid_response',
        retryable: false,
        ...(parseError === undefined ? {} : { cause: parseError }),
      });
    }
    if (options.schema === undefined) {
      return undefined as T;
    }
    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ControlPlaneError('控制平面响应与协议不一致（版本不匹配？）。', {
        status: response.status,
        code: 'invalid_response',
        retryable: false,
        details: { issues: parsed.error.issues },
      });
    }
    return parsed.data as T;
  }

  private errorFromResponse(status: number, payload: unknown): ControlPlaneError {
    const parsed = apiErrorBodySchema.safeParse(payload);
    if (parsed.success) {
      const { code, message, retryable, details } = parsed.data.error;
      return new ControlPlaneError(message, {
        status,
        code,
        retryable,
        ...(details === undefined ? {} : { details }),
      });
    }
    return new ControlPlaneError(`控制平面请求失败（HTTP ${status}）。`, {
      status,
      code: fallbackCodeForStatus(status),
      retryable: status >= 500 || status === 429,
    });
  }
}
