export interface ApiResponse<TBody = unknown> {
  status: number;
  body: TBody;
}

export interface ApiRequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Minimal JSON-over-fetch helper shared by the fake executor and e2e tests. */
export async function apiRequest<TBody = unknown>(
  baseUrl: string,
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResponse<TBody>> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  let payload: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const method = options.method ?? (payload === undefined ? 'GET' : 'POST');
  const init: RequestInit = { method, headers };
  if (payload !== undefined) init.body = payload;
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as TBody };
}

export class TestApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'TestApiError';
    this.status = status;
    this.body = body;
  }
}

/** Await a condition (e.g. async stage completion), polling every `intervalMs`. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const label = options.label === undefined ? 'condition' : options.label;
  throw new Error(
    `timed out waiting for ${label}${lastError === undefined ? '' : ` (last error: ${String(lastError)})`}`,
  );
}
