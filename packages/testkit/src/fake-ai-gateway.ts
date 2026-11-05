import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// S5: in-process fake enterprise AI gateway (docs/003 §4.8, docs/005 §3.3).
//
// The M3 SAP batch executor (`ZCL_ZSA_AI_BATCH`) is the only caller: it sends
// the control-plane rendered messages to `<AI_GATEWAY_URL>/chat/completions`
// and forwards `choices[0].message.content` back as the raw model output. This
// fake mirrors that OpenAI-compatible surface so e2e runs stay fully offline.
//
// Privacy: requests (model + messages) are recorded for assertions, but the
// fake never prints prompt or output text — only ids/lengths/statuses belong in
// logs (data boundary, docs/003 §4.8.3).
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'fake-enterprise-model';
/** Safe fallback shape; any real stage schema validation happens on the CP. */
const DEFAULT_CONTENT = '{}';
const CHAT_COMPLETIONS_PATHS = new Set(['/chat/completions', '/v1/chat/completions']);

export interface FakeAiGatewayMessage {
  role: string;
  content: string;
}

export interface FakeAiGatewayRequest {
  method: string;
  path: string;
  /** Model requested by SAP (empty string when the body did not carry one). */
  model: string;
  messages: FakeAiGatewayMessage[];
  /** Raw JSON request body, kept for assertions; never logged by the fake. */
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  at: string;
}

export type FakeAiGatewayFaultKind = 'status' | 'timeout' | 'bad_json' | 'invalid_output';

/** One-shot injected gateway failure, consumed by the next matching request. */
export interface FakeAiGatewayFault {
  kind: FakeAiGatewayFaultKind;
  /** HTTP status for `status` (default 500) and `bad_json`/`invalid_output` (default 200). */
  status?: number;
  /**
   * Raw body for `bad_json` (e.g. a truncated JSON envelope) or the assistant
   * content for `invalid_output` (an OpenAI-compatible response whose content
   * the control plane rejects with its output schema).
   */
  bodyText?: string;
  /** Delay before answering; `timeout` waits 100ms by default. */
  delayMs?: number;
  headers?: Record<string, string>;
  /** Only apply to requests whose URL path includes this fragment. */
  pathIncludes?: string;
}

/** What a responder may return for one request (fault-like overrides included). */
export interface FakeAiGatewayReply {
  /** Assistant content for the OpenAI-compatible envelope. */
  content?: string;
  /** Override the HTTP status (default 200). */
  status?: number;
  /** Send this raw body instead of an OpenAI envelope (e.g. malformed JSON). */
  bodyText?: string;
  /** Delay before answering (ms). */
  delayMs?: number;
  headers?: Record<string, string>;
}

export type FakeAiGatewayResponder = (
  request: FakeAiGatewayRequest,
) => string | FakeAiGatewayReply | Promise<string | FakeAiGatewayReply>;

export interface FakeAiGatewayOptions {
  /** Model echoed in the response when the request carries none. */
  model?: string;
  /** Fixed assistant content used when no responder/queue decided. */
  outputText?: string;
  /** Queue of assistant contents; one consumed per request before `outputText`. */
  outputs?: string[];
  /** Dynamic responder; wins over `outputs`/`outputText`. */
  respond?: FakeAiGatewayResponder;
  clock?: () => number;
}

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function jsonBody(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function normalizeMessages(raw: unknown): FakeAiGatewayMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: FakeAiGatewayMessage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const content = record['content'];
    if (typeof content !== 'string') continue;
    const role = record['role'];
    messages.push({ role: typeof role === 'string' ? role : 'user', content });
  }
  return messages;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeAiGateway {
  readonly requests: FakeAiGatewayRequest[] = [];
  private readonly options: FakeAiGatewayOptions;
  private readonly clock: () => number;
  private readonly initialOutputs: string[];
  private queued: string[];
  private server: Server | null = null;
  private faults: FakeAiGatewayFault[] = [];
  private sequence = 0;

  constructor(options: FakeAiGatewayOptions = {}) {
    this.options = options;
    this.clock = options.clock ?? ((): number => Date.now());
    this.initialOutputs = options.outputs === undefined ? [] : [...options.outputs];
    this.queued = [...this.initialOutputs];
  }

  get model(): string {
    return this.options.model ?? DEFAULT_MODEL;
  }

  get url(): string {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('fake AI gateway is not listening');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  get chatCompletionsUrl(): string {
    return `${this.url}/chat/completions`;
  }

  async start(): Promise<this> {
    if (this.server !== null) return this;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          jsonBody(response, 500, {
            error: { code: 'fake_gateway_error', message: error instanceof Error ? error.message : String(error) },
          });
        } else {
          response.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  reset(): void {
    this.requests.length = 0;
    this.faults = [];
    this.queued = [...this.initialOutputs];
    this.sequence = 0;
  }

  injectFault(fault: FakeAiGatewayFault): void {
    this.faults.push(fault);
  }

  clearFaults(): void {
    this.faults = [];
  }

  private nextFault(pathname: string): FakeAiGatewayFault | undefined {
    const index = this.faults.findIndex(
      (fault) => fault.pathIncludes === undefined || pathname.includes(fault.pathIncludes),
    );
    if (index < 0) return undefined;
    return this.faults.splice(index, 1)[0];
  }

  /** Build the OpenAI-compatible chat completion envelope. */
  private envelope(input: {
    model: string;
    content: string;
    messages: readonly FakeAiGatewayMessage[];
  }): Record<string, unknown> {
    this.sequence += 1;
    const promptTokens = input.messages.reduce(
      (total, message) => total + estimateTokens(message.content),
      0,
    );
    const completionTokens = estimateTokens(input.content);
    return {
      id: `chatcmpl-fake-${this.sequence}`,
      object: 'chat.completion',
      created: Math.floor(this.clock() / 1_000),
      model: input.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: input.content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  private async applyFault(fault: FakeAiGatewayFault, response: ServerResponse): Promise<void> {
    if (fault.kind === 'timeout') {
      await delay(fault.delayMs ?? 100);
      jsonBody(
        response,
        fault.status ?? 200,
        { error: { code: 'fake_gateway_timeout', message: 'injected timeout' } },
        fault.headers ?? {},
      );
      return;
    }
    if (fault.kind === 'bad_json') {
      const text = fault.bodyText ?? '{"choices": [';
      response.writeHead(fault.status ?? 200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        ...(fault.headers ?? {}),
      });
      response.end(text);
      return;
    }
    if (fault.kind === 'invalid_output') {
      jsonBody(
        response,
        fault.status ?? 200,
        this.envelope({
          model: this.model,
          content: fault.bodyText ?? 'this output is not valid JSON',
          messages: [],
        }),
        fault.headers ?? {},
      );
      return;
    }
    jsonBody(
      response,
      fault.status ?? 500,
      { error: { code: 'fake_gateway_fault', message: `injected HTTP ${fault.status ?? 500}` } },
      fault.headers ?? {},
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://fake.local');
    const body = await readBody(request);

    if (method === 'GET' && url.pathname === '/health') {
      jsonBody(response, 200, { status: 'ok', gateway: 'fake' });
      return;
    }
    if (method !== 'POST' || !CHAT_COMPLETIONS_PATHS.has(url.pathname)) {
      jsonBody(response, 404, {
        error: { code: 'not_found', message: `unknown route ${method} ${url.pathname}` },
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      jsonBody(response, 400, {
        error: { code: 'bad_request', message: 'request body is not valid JSON' },
      });
      return;
    }
    const recordBody = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const model = typeof recordBody['model'] === 'string' ? recordBody['model'] : '';
    const messages = normalizeMessages(recordBody['messages']);
    const recorded: FakeAiGatewayRequest = {
      method,
      path: url.pathname,
      model,
      messages,
      rawBody: body,
      headers: request.headers,
      at: nowIso(this.clock),
    };
    // Record only metadata + messages; the fake never logs prompt/output text.
    this.requests.push(recorded);

    const fault = this.nextFault(url.pathname);
    if (fault !== undefined) {
      await this.applyFault(fault, response);
      return;
    }

    let reply: string | FakeAiGatewayReply;
    if (this.options.respond !== undefined) {
      reply = await this.options.respond(recorded);
    } else {
      reply = this.queued.shift() ?? this.options.outputText ?? DEFAULT_CONTENT;
    }

    if (typeof reply === 'string') {
      jsonBody(
        response,
        200,
        this.envelope({ model: model.length > 0 ? model : this.model, content: reply, messages }),
      );
      return;
    }
    if (reply.delayMs !== undefined) await delay(reply.delayMs);
    if (reply.bodyText !== undefined) {
      response.writeHead(reply.status ?? 200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(reply.bodyText),
        ...(reply.headers ?? {}),
      });
      response.end(reply.bodyText);
      return;
    }
    const content = reply.content ?? DEFAULT_CONTENT;
    jsonBody(
      response,
      reply.status ?? 200,
      this.envelope({ model: model.length > 0 ? model : this.model, content, messages }),
      reply.headers ?? {},
    );
  }
}
