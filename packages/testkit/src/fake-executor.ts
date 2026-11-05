import type {
  ClaimTaskResponse,
  CompleteTaskBody,
  CompleteTaskResponse,
  FailTaskBody,
  HeartbeatBody,
  HeartbeatResponse,
  LeaseRenewResponse,
  ListTasksResponse,
  RegisterExecutorBody,
  RegisterExecutorResponse,
  SubmitArtifactResponse,
  TaskDetailResponse,
  TaskContextResponse,
  ArtifactKind,
} from '@sap-superagent/protocol';
import { apiRequest, TestApiError, type ApiResponse } from './http.js';
import { sha256Checksum, toBase64 } from './checksum.js';

// ---------------------------------------------------------------------------
// Fake executor (docs/009 §5): drives the same REST contract a VSCode client
// would use, without any VSCode API. Used by the e2e walking skeleton.
// ---------------------------------------------------------------------------

export function requireOk<T>(response: ApiResponse<T>, label: string): T {
  if (response.status < 200 || response.status >= 300) {
    throw new TestApiError(
      `${label} failed with HTTP ${response.status}`,
      response.status,
      response.body,
    );
  }
  return response.body;
}

export async function registerExecutor(
  baseUrl: string,
  userToken: string,
  body: RegisterExecutorBody,
): Promise<RegisterExecutorResponse> {
  const response = await apiRequest<RegisterExecutorResponse>(
    baseUrl,
    '/api/v1/executors/register',
    { method: 'POST', token: userToken, body },
  );
  return requireOk(response, 'register executor');
}

export interface FakeExecutorOptions {
  baseUrl: string;
  executorToken: string;
  executorId: string;
  user: string;
}

export class FakeExecutor {
  readonly baseUrl: string;
  readonly executorToken: string;
  readonly executorId: string;
  readonly user: string;

  constructor(options: FakeExecutorOptions) {
    this.baseUrl = options.baseUrl;
    this.executorToken = options.executorToken;
    this.executorId = options.executorId;
    this.user = options.user;
  }

  private request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    return apiRequest<T>(this.baseUrl, path, {
      method: options.method ?? 'GET',
      body: options.body,
      token: options.token ?? this.executorToken,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
  }

  heartbeat(body: HeartbeatBody): Promise<ApiResponse<HeartbeatResponse>> {
    return this.request<HeartbeatResponse>(`/api/v1/executors/${this.executorId}/heartbeat`, {
      method: 'POST',
      body,
    });
  }

  async heartbeatOk(body: HeartbeatBody): Promise<HeartbeatResponse> {
    return requireOk(await this.heartbeat(body), 'heartbeat');
  }

  listTasks(): Promise<ApiResponse<ListTasksResponse>> {
    return this.request<ListTasksResponse>('/api/v1/tasks');
  }

  getTask(taskId: string): Promise<ApiResponse<TaskDetailResponse>> {
    return this.request<TaskDetailResponse>(`/api/v1/tasks/${taskId}`);
  }

  getContext(taskId: string): Promise<ApiResponse<TaskContextResponse>> {
    return this.request<TaskContextResponse>(`/api/v1/tasks/${taskId}/context`);
  }

  claim(taskId: string, idempotencyKey?: string): Promise<ApiResponse<ClaimTaskResponse>> {
    return this.request<ClaimTaskResponse>(`/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      body: {},
      ...(idempotencyKey === undefined
        ? {}
        : { headers: { 'idempotency-key': idempotencyKey } }),
    });
  }

  async claimOk(taskId: string): Promise<ClaimTaskResponse> {
    return requireOk(await this.claim(taskId), 'claim task');
  }

  renew(taskId: string): Promise<ApiResponse<LeaseRenewResponse>> {
    return this.request<LeaseRenewResponse>(`/api/v1/tasks/${taskId}/lease/renew`, {
      method: 'POST',
      body: {},
    });
  }

  progress(taskId: string, body: { percent?: number; message: string; summary?: string }) {
    return this.request(`/api/v1/tasks/${taskId}/progress`, { method: 'POST', body });
  }

  submitArtifact(
    taskId: string,
    input: {
      kind: ArtifactKind;
      content: string;
      contentType?: string;
      summary?: string;
      title?: string;
    },
  ): Promise<ApiResponse<SubmitArtifactResponse>> {
    const contentType = input.contentType ?? 'text/plain';
    const body = {
      kind: input.kind,
      contentType,
      contentBase64: toBase64(input.content),
      checksum: sha256Checksum(input.content),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.title === undefined ? {} : { title: input.title }),
    };
    return this.request(`/api/v1/tasks/${taskId}/artifacts`, { method: 'POST', body });
  }

  complete(taskId: string, body: CompleteTaskBody): Promise<ApiResponse<CompleteTaskResponse>> {
    return this.request<CompleteTaskResponse>(`/api/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      body,
    });
  }

  fail(taskId: string, body: FailTaskBody) {
    return this.request(`/api/v1/tasks/${taskId}/fail`, { method: 'POST', body });
  }

  release(taskId: string) {
    return this.request(`/api/v1/tasks/${taskId}/release`, { method: 'POST', body: {} });
  }

  unregister() {
    return this.request(`/api/v1/executors/${this.executorId}`, { method: 'DELETE' });
  }
}
