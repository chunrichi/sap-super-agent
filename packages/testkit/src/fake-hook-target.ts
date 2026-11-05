import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HookEnvelope } from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// S4: in-process fake external system for the generic `http` hook target.
//
// Records requests (headers + raw body + parsed envelope), optionally verifies
// the `X-SA-*` HMAC headers with an independent implementation, supports fault
// injection (5xx / 429 / 4xx / timeout / malformed JSON) and behaves like an
// idempotent external system: the same `idempotencyKey` always maps to the same
// external id and never creates a second order. It also serves a
// `reconcileUrl` listing for `pnpm hooks:reconcile` tests.
// ---------------------------------------------------------------------------

export interface FakeHookFault {
  kind: 'status' | 'timeout' | 'bad_json';
  /** HTTP status for `status`/`bad_json` faults (default 500 / 200). */
  status?: number;
  body?: unknown;
  bodyText?: string;
  /** Headers to attach (e.g. `retry-after`). */
  headers?: Record<string, string>;
  /** Only apply to requests whose URL path includes this fragment. */
  pathIncludes?: string;
  /** Delay before answering for `timeout` faults (default 100ms). */
  delayMs?: number;
}

export interface FakeHookRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  at: string;
}

export interface FakeHookTargetOptions {
  /** When set, POST deliveries must carry a valid X-SA-Signature. */
  secret?: string;
  clock?: () => number;
  externalIdPrefix?: string;
}

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

function jsonBody(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
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

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Independent implementation of the docs/003 §4.1 signature rule (test side). */
export function computeFakeHookSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** Sign a request the way an external system would for `POST /hooks/{id}/receipt`. */
export function buildFakeHookHeaders(input: {
  secret: string;
  body: string;
  delivery: string;
  timestamp?: string;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-sa-signature': computeFakeHookSignature(input.secret, input.body),
    'x-sa-timestamp': input.timestamp ?? new Date().toISOString(),
    'x-sa-delivery': input.delivery,
  };
}

export class FakeHookTarget {
  readonly requests: FakeHookRequest[] = [];
  /** External order book: idempotencyKey -> externalId (proves replay is idempotent). */
  readonly orders = new Map<string, string>();
  /** Requests whose idempotencyKey was already delivered (target-side duplicates). */
  duplicateDeliveries = 0;
  /** What a `reconcileUrl` listing returns (docs/008 §7). */
  reconcileItems: Array<{ externalId: string }> = [];

  private readonly options: FakeHookTargetOptions;
  private readonly clock: () => number;
  private server: Server | null = null;
  private faults: FakeHookFault[] = [];
  private sequence = 0;

  constructor(options: FakeHookTargetOptions = {}) {
    this.options = options;
    this.clock = options.clock ?? ((): number => Date.now());
  }

  get url(): string {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('fake hook target is not listening');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /** Config `url` for `examples/hooks.yaml`-style delivery. */
  get hookUrl(): string {
    return `${this.url}/hooks/example`;
  }

  get reconcileUrl(): string {
    return `${this.url}/external/items`;
  }

  async start(): Promise<this> {
    if (this.server !== null) return this;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) jsonBody(response, 500, { error: String(error) });
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    return this;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  reset(): void {
    this.requests.length = 0;
    this.orders.clear();
    this.duplicateDeliveries = 0;
    this.reconcileItems = [];
    this.faults = [];
    this.sequence = 0;
  }

  injectFault(fault: FakeHookFault): void {
    this.faults.push(fault);
  }

  clearFaults(): void {
    this.faults = [];
  }

  get deliveries(): FakeHookRequest[] {
    return this.requests.filter((request) => request.method === 'POST');
  }

  get envelopes(): HookEnvelope[] {
    return this.deliveries.map((request) => JSON.parse(request.body) as HookEnvelope);
  }

  get idempotencyKeys(): string[] {
    return this.deliveries
      .map((request) => headerValue(request.headers, 'x-sa-delivery'))
      .filter((value): value is string => value !== undefined);
  }

  async waitForDelivery(timeoutMs = 5_000): Promise<FakeHookRequest> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const delivery = this.deliveries[0];
      if (delivery !== undefined) return delivery;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for a hook delivery');
  }

  private nextFault(pathname: string): FakeHookFault | undefined {
    const index = this.faults.findIndex(
      (fault) => fault.pathIncludes === undefined || pathname.includes(fault.pathIncludes),
    );
    if (index < 0) return undefined;
    return this.faults.splice(index, 1)[0];
  }

  private verifySignature(request: IncomingMessage, body: string): boolean {
    const secret = this.options.secret;
    if (secret === undefined) return true;
    const signature = headerValue(request.headers, 'x-sa-signature');
    if (signature === undefined) return false;
    const expected = computeFakeHookSignature(secret, body);
    return signature === expected;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://fake.local');
    const body = await readBody(request);
    this.requests.push({
      method,
      path: url.pathname,
      headers: request.headers,
      body,
      at: nowIso(this.clock),
    });

    if (method === 'GET' && url.pathname === '/external/items') {
      jsonBody(response, 200, { items: this.reconcileItems });
      return;
    }

    const fault = this.nextFault(url.pathname);
    if (fault !== undefined) {
      if (fault.kind === 'timeout') {
        await new Promise((resolve) => setTimeout(resolve, fault.delayMs ?? 100));
        jsonBody(response, fault.status ?? 200, { status: 'delayed' });
        return;
      }
      if (fault.kind === 'bad_json') {
        response.writeHead(fault.status ?? 200, { 'content-type': 'application/json' });
        response.end(fault.bodyText ?? '{"externalId": "EXT-');
        return;
      }
      jsonBody(
        response,
        fault.status ?? 500,
        fault.body ?? { error: { code: 'injected', message: 'fault' } },
        fault.headers ?? {},
      );
      return;
    }

    if (method !== 'POST') {
      jsonBody(response, 404, { error: { code: 'not_found', message: `${method} ${url.pathname}` } });
      return;
    }
    if (!this.verifySignature(request, body)) {
      jsonBody(response, 401, { error: { code: 'unauthorized', message: 'invalid X-SA-Signature' } });
      return;
    }

    const idempotencyKey = headerValue(request.headers, 'x-sa-delivery');
    if (idempotencyKey === undefined) {
      jsonBody(response, 400, { error: { code: 'validation', message: 'missing X-SA-Delivery' } });
      return;
    }
    const existing = this.orders.get(idempotencyKey);
    if (existing !== undefined) {
      this.duplicateDeliveries += 1;
      jsonBody(response, 200, { externalId: existing, duplicate: true });
      return;
    }
    this.sequence += 1;
    const externalId = `${this.options.externalIdPrefix ?? 'EXT'}-${this.sequence}`;
    this.orders.set(idempotencyKey, externalId);
    jsonBody(response, 200, { externalId });
  }
}
