import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// H2 Phase A: in-process fake of the SAP ICF JSON API (docs/004 §3.2).
//
// It implements the six documented routes plus a fault-injection queue
// (timeout / 409 / 401 / malformed JSON) and an outbox that can sign and
// deliver SAP webhook events to the control plane exactly like the ABAP
// `ZCL_ZSA_EVENT_PUSH` job would (HMAC X-SA-Signature/Timestamp/Delivery).
//
// The fake deliberately re-implements the HMAC rule locally instead of
// importing `@sap-superagent/sap-adapter`: the integration test then
// cross-checks two independent implementations of the documented rule.
// ---------------------------------------------------------------------------

export type FakeSapEventType =
  | 'demand.submitted'
  | 'demand.updated'
  | 'artifact.approved'
  | 'artifact.rejected'
  | 'demand.cancelled'
  | 'hook.receipt';

export const FAKE_SAP_EVENT_TYPES: readonly FakeSapEventType[] = [
  'demand.submitted',
  'demand.updated',
  'artifact.approved',
  'artifact.rejected',
  'demand.cancelled',
  'hook.receipt',
];

export interface FakeIcfDemand {
  demandId: string;
  demandNo: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requesterUserId: string;
  orgUnit: string | null;
  priority: 'high' | 'normal' | 'low';
  /** Business-facing projection (docs/004 §2.1), not the control-plane status. */
  status: string;
  statusText: string;
  stageKey: string | null;
  repoKey: string | null;
  projectKey: string | null;
  templateId: string | null;
  /** Optimistic-concurrency version used by `If-Match`. */
  version: number;
  createdAt: string;
  changedAt: string;
}

export interface FakeIcfArtifact {
  artifactId: string;
  demandId: string;
  stageKey: string;
  stageRunId: string | null;
  kind: string;
  version: number;
  checksum: string;
  contentRef: string;
  contentType: string;
  status: string;
}

export interface FakeIcfApproval {
  approvalId: string;
  demandId: string;
  stageKey: string | null;
  gateKey: string;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
  requiredRole: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
}

export interface FakeSapOutboxEvent {
  eventId: string;
  type: FakeSapEventType;
  demandId: string | null;
  data: Record<string, unknown>;
  state: 'NEW' | 'SENT' | 'FAILED';
  createdAt: string;
}

export interface FakeWritebackRecord {
  demandId: string;
  ifMatch: string | null;
  patch: Record<string, unknown>;
  status: number;
  at: string;
}

export type FakeIcfFault =
  | {
      kind: 'timeout';
      /** Only apply to this method. */
      method?: string;
      /** Only apply when the URL path contains this fragment. */
      pathIncludes?: string;
      delayMs?: number;
    }
  | {
      kind: 'status';
      status: number;
      body?: unknown;
      method?: string;
      pathIncludes?: string;
    }
  | {
      kind: 'bad_json';
      /** Raw response text, e.g. truncated JSON. */
      bodyText?: string;
      status?: number;
      method?: string;
      pathIncludes?: string;
    };

export interface FakeIcfServerOptions {
  serviceUser?: string;
  servicePassword?: string;
  /** Secret used by `deliverEvents` to sign outbound webhook events. */
  hookSecret?: string;
  clock?: () => number;
}

export interface FakeIcfDeliveryResult {
  eventId: string;
  type: FakeSapEventType;
  status: number;
  body: unknown;
  deliveryHeader: string;
}

export interface FakeIcfDeliveryOptions {
  secret?: string;
  /** Tamper with the request to exercise negative paths in tests. */
  tamper?: 'signature' | 'timestamp' | 'body' | 'delivery';
  /** Header timestamp override (e.g. a stale timestamp). */
  timestamp?: string;
  /** Inject a delivery-id override (duplicate-delivery tests). */
  delivery?: string;
  /** Abort the delivery after this many events (partial delivery tests). */
  limit?: number;
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  at: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

function jsonBody(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function errorBody(response: ServerResponse, status: number, code: string, message: string): void {
  jsonBody(response, status, { error: { code, message } });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  return JSON.parse(text) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function hmacSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/**
 * In-memory stand-in for the SAP ICF + MIME demand system. Start it with
 * `start()`; it listens on an ephemeral port so Phase A tests never touch a
 * real SAP system or an external process.
 */
export class FakeIcfServer {
  readonly demands = new Map<string, FakeIcfDemand>();
  readonly artifacts = new Map<string, FakeIcfArtifact>();
  readonly approvals = new Map<string, FakeIcfApproval[]>();
  readonly outbox: FakeSapOutboxEvent[] = [];
  readonly writebacks: FakeWritebackRecord[] = [];
  readonly requests: RecordedRequest[] = [];

  private readonly options: FakeIcfServerOptions;
  private readonly clock: () => number;
  private server: Server | null = null;
  private faults: FakeIcfFault[] = [];
  private sequence = 0;

  constructor(options: FakeIcfServerOptions = {}) {
    this.options = options;
    this.clock = options.clock ?? ((): number => Date.now());
  }

  get url(): string {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('fake ICF server is not listening');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  get hookSecret(): string {
    return this.options.hookSecret ?? 'fake-sap-hook-secret';
  }

  async start(): Promise<this> {
    if (this.server !== null) return this;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          errorBody(response, 500, 'internal_error', String(error));
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

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  reset(): void {
    this.demands.clear();
    this.artifacts.clear();
    this.approvals.clear();
    this.outbox.length = 0;
    this.writebacks.length = 0;
    this.requests.length = 0;
    this.faults = [];
    this.sequence = 0;
  }

  // -- fault injection -----------------------------------------------------

  injectFault(fault: FakeIcfFault): void {
    this.faults.push(fault);
  }

  clearFaults(): void {
    this.faults = [];
  }

  // -- SAP-side business simulation ---------------------------------------

  seedDemand(
    input: Partial<Omit<FakeIcfDemand, 'demandId' | 'demandNo' | 'version' | 'createdAt' | 'changedAt'>> & {
      title: string;
    },
  ): FakeIcfDemand {
    this.sequence += 1;
    const at = nowIso(this.clock);
    const demand: FakeIcfDemand = {
      demandId: randomUUID().replace(/-/g, ''),
      demandNo: `R-${2_000 + this.sequence}`,
      title: input.title,
      description: input.description ?? '',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      requesterUserId: input.requesterUserId ?? 'REQ001',
      orgUnit: input.orgUnit ?? 'PDO',
      priority: input.priority ?? 'normal',
      status: input.status ?? '待分析',
      statusText: input.statusText ?? input.status ?? '待分析',
      stageKey: input.stageKey ?? null,
      repoKey: input.repoKey ?? null,
      projectKey: input.projectKey ?? null,
      templateId: input.templateId ?? null,
      version: 1,
      createdAt: at,
      changedAt: at,
    };
    this.demands.set(demand.demandId, demand);
    return demand;
  }

  /** Create a demand the way the SAP Web page does: persist + enqueue the webhook event. */
  createDemandFromUi(input: {
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
    requesterUserId?: string;
    orgUnit?: string;
    priority?: FakeIcfDemand['priority'];
    repoKey?: string;
    projectKey?: string;
    templateId?: string;
  }): { demand: FakeIcfDemand; event: FakeSapOutboxEvent } {
    const demand = this.seedDemand({
      title: input.title,
      description: input.description ?? '',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      requesterUserId: input.requesterUserId ?? 'REQ001',
      orgUnit: input.orgUnit ?? 'PDO',
      priority: input.priority ?? 'normal',
      repoKey: input.repoKey ?? null,
      projectKey: input.projectKey ?? null,
      templateId: input.templateId ?? null,
    });
    const event = this.enqueueEvent('demand.submitted', demand.demandId, {
      demand: this.demandSnapshot(demand),
      sapVersion: demand.version,
    });
    return { demand, event };
  }

  /** Record a SAP-side approval decision and enqueue the webhook event. */
  decideApproval(input: {
    demandId: string;
    gateKey: string;
    decision: 'approve' | 'reject';
    decidedBy: string;
    comment?: string;
    stageKey?: string;
    artifactId?: string;
    artifactVersion?: number;
  }): { approval: FakeIcfApproval; event: FakeSapOutboxEvent } {
    const demand = this.requireDemand(input.demandId);
    const at = nowIso(this.clock);
    const approval: FakeIcfApproval = {
      approvalId: randomUUID().replace(/-/g, ''),
      demandId: demand.demandId,
      stageKey: input.stageKey ?? demand.stageKey ?? null,
      gateKey: input.gateKey,
      state: input.decision === 'approve' ? 'approved' : 'rejected',
      requiredRole: 'consultant',
      decidedBy: input.decidedBy,
      decidedAt: at,
      comment: input.comment ?? null,
    };
    const list = this.approvals.get(demand.demandId) ?? [];
    list.push(approval);
    this.approvals.set(demand.demandId, list);
    this.touchDemand(demand);
    const event = this.enqueueEvent(
      input.decision === 'approve' ? 'artifact.approved' : 'artifact.rejected',
      demand.demandId,
      {
        demandId: demand.demandId,
        approvalId: approval.approvalId,
        gateKey: approval.gateKey,
        stageKey: approval.stageKey,
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt,
        comment: approval.comment,
        ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
        ...(input.artifactVersion === undefined ? {} : { version: input.artifactVersion }),
        sapVersion: demand.version,
      },
    );
    return { approval, event };
  }

  enqueueEvent(
    type: FakeSapEventType,
    demandId: string | null,
    data: Record<string, unknown>,
  ): FakeSapOutboxEvent {
    // Every type except demand.submitted carries the demand id in the payload;
    // fill it in like the ABAP outbox job does so tests only pass the deltas.
    const payload =
      demandId !== null && data['demandId'] === undefined
        ? { demandId, ...data }
        : data;
    const event: FakeSapOutboxEvent = {
      eventId: randomUUID().replace(/-/g, ''),
      type,
      demandId,
      data: payload,
      state: 'NEW',
      createdAt: nowIso(this.clock),
    };
    this.outbox.push(event);
    return event;
  }

  /** Build the signed webhook request the ABAP outbox job would send. */
  buildDelivery(
    event: FakeSapOutboxEvent,
    options: FakeIcfDeliveryOptions = {},
  ): { body: string; headers: Record<string, string> } {
    const secret = options.secret ?? this.hookSecret;
    const body = JSON.stringify({
      eventId: event.eventId,
      occurredAt: event.createdAt,
      data: { type: event.type, ...event.data },
    });
    const timestamp = options.timestamp ?? nowIso(this.clock);
    const delivery = options.delivery ?? event.eventId;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-sa-signature': hmacSignature(secret, body),
      'x-sa-timestamp': timestamp,
      'x-sa-delivery': delivery,
    };
    if (options.tamper === 'signature') headers['x-sa-signature'] = hmacSignature('wrong-secret', body);
    if (options.tamper === 'timestamp') headers['x-sa-timestamp'] = '2000-01-01T00:00:00.000Z';
    if (options.tamper === 'delivery') headers['x-sa-delivery'] = '';
    if (options.tamper === 'body') {
      headers['x-sa-signature'] = hmacSignature(secret, `${body} `);
    }
    return { body, headers };
  }

  /**
   * Deliver NEW outbox events to `POST <controlPlaneUrl>/hooks/sap` exactly like
   * the SAP push job: sign, POST, mark SENT/FAILED. Returns per-event results.
   */
  async deliverEvents(
    controlPlaneUrl: string,
    options: FakeIcfDeliveryOptions = {},
  ): Promise<FakeIcfDeliveryResult[]> {
    const results: FakeIcfDeliveryResult[] = [];
    const pending = this.outbox.filter((event) => event.state === 'NEW');
    const limit = options.limit ?? pending.length;
    for (const event of pending.slice(0, limit)) {
      const { body, headers } = this.buildDelivery(event, options);
      let status = 0;
      let parsed: unknown;
      try {
        const response = await fetch(`${controlPlaneUrl}/hooks/sap`, { method: 'POST', headers, body });
        status = response.status;
        const text = await response.text();
        try {
          parsed = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
        } catch {
          parsed = text;
        }
      } catch (error) {
        parsed = String(error);
      }
      event.state = status >= 200 && status < 300 ? 'SENT' : 'FAILED';
      results.push({
        eventId: event.eventId,
        type: event.type,
        status,
        body: parsed,
        deliveryHeader: headers['x-sa-delivery'] ?? '',
      });
    }
    return results;
  }

  demandSnapshot(demand: FakeIcfDemand): Record<string, unknown> {
    return { ...demand };
  }

  listDemandArtifacts(demandId: string): FakeIcfArtifact[] {
    return [...this.artifacts.values()].filter((artifact) => artifact.demandId === demandId);
  }

  listDemandApprovals(demandId: string): FakeIcfApproval[] {
    return [...(this.approvals.get(demandId) ?? [])];
  }

  // -- HTTP handling -------------------------------------------------------

  private nextFault(request: { method: string; path: string }): FakeIcfFault | undefined {
    const index = this.faults.findIndex((fault) => {
      if (fault.method !== undefined && fault.method !== request.method) return false;
      if (fault.pathIncludes !== undefined && !request.path.includes(fault.pathIncludes)) return false;
      return true;
    });
    if (index < 0) return undefined;
    return this.faults.splice(index, 1)[0];
  }

  private checkAuth(request: IncomingMessage, response: ServerResponse): boolean {
    const user = this.options.serviceUser;
    if (user === undefined) return true;
    const expected = Buffer.from(
      `${user}:${this.options.servicePassword ?? ''}`,
      'utf8',
    ).toString('base64');
    const header = request.headers.authorization;
    if (header !== `Basic ${expected}`) {
      errorBody(response, 401, 'unauthorized', 'invalid SAP service credentials');
      return false;
    }
    return true;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://fake.local');
    const body = await readBody(request);
    this.requests.push({ method, path: url.pathname, headers: request.headers, body, at: nowIso(this.clock) });

    const fault = this.nextFault({ method, path: url.pathname });
    if (fault !== undefined) {
      if (fault.kind === 'timeout') {
        await new Promise((resolve) => setTimeout(resolve, fault.delayMs ?? 100));
        jsonBody(response, 200, { status: 'ok', delayed: true });
        return;
      }
      if (fault.kind === 'bad_json') {
        const text = fault.bodyText ?? '{"status": "ok"';
        response.writeHead(fault.status ?? 200, { 'content-type': 'application/json' });
        response.end(text);
        return;
      }
      jsonBody(response, fault.status, fault.body ?? { error: { code: 'injected', message: 'fault' } });
      return;
    }

    if (!this.checkAuth(request, response)) return;

    if (url.pathname === '/api/health' && method === 'GET') {
      jsonBody(response, 200, { status: 'ok', system: 'FAKE-SAP', version: '2.2.0' });
      return;
    }

    if (url.pathname === '/api/demands' && method === 'GET') {
      this.handleListDemands(url, response);
      return;
    }

    if (url.pathname === '/api/demands' && method === 'POST') {
      this.handleCreateDemand(body, response);
      return;
    }

    const detailMatch = /^\/api\/demands\/([^/]+)$/.exec(url.pathname);
    if (detailMatch !== null && method === 'GET') {
      this.handleGetDemand(decodeURIComponent(detailMatch[1] ?? ''), response);
      return;
    }
    if (detailMatch !== null && method === 'PATCH') {
      this.handlePatchDemand(decodeURIComponent(detailMatch[1] ?? ''), request, body, response);
      return;
    }

    const approvalMatch = /^\/api\/demands\/([^/]+)\/approvals$/.exec(url.pathname);
    if (approvalMatch !== null && method === 'POST') {
      this.handleCreateApproval(decodeURIComponent(approvalMatch[1] ?? ''), body, response);
      return;
    }

    // /ui/* is served by MIME in the real system; the fake only needs the API
    // surface for Phase A, but answers the health-like probe for the UI root.
    if (url.pathname.startsWith('/ui')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>fake SAP UI</title><p>ZSA demand UI</p>');
      return;
    }

    errorBody(response, 404, 'not_found', `unknown route ${method} ${url.pathname}`);
  }

  private handleListDemands(url: URL, response: ServerResponse): void {
    const status = url.searchParams.get('status');
    const changedSince = url.searchParams.get('changedSince');
    const q = url.searchParams.get('q');
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null ? 50 : Math.max(1, Number.parseInt(limitRaw, 10) || 50);
    let demands = [...this.demands.values()];
    if (status !== null) demands = demands.filter((demand) => demand.status === status);
    if (changedSince !== null) {
      demands = demands.filter((demand) => demand.changedAt > changedSince);
    }
    if (q !== null) {
      const needle = q.toLowerCase();
      demands = demands.filter((demand) => demand.title.toLowerCase().includes(needle));
    }
    demands = demands
      .sort((left, right) => left.changedAt.localeCompare(right.changedAt))
      .slice(0, limit);
    jsonBody(response, 200, { demands, serverTime: nowIso(this.clock) });
  }

  private handleCreateDemand(rawBody: string, response: ServerResponse): void {
    const body = asRecord(parseJson(rawBody));
    if (body === undefined) {
      errorBody(response, 400, 'validation', 'request body must be a JSON object');
      return;
    }
    const title = stringField(body, 'title');
    if (title === undefined || title.trim().length === 0) {
      errorBody(response, 400, 'validation', 'title is required');
      return;
    }
    const acceptanceCriteria = Array.isArray(body['acceptanceCriteria'])
      ? body['acceptanceCriteria'].filter((entry): entry is string => typeof entry === 'string')
      : [];
    const priority = stringField(body, 'priority');
    const description = stringField(body, 'description');
    const requesterUserId = stringField(body, 'requesterUserId');
    const orgUnit = stringField(body, 'orgUnit');
    const repoKey = stringField(body, 'repoKey');
    const projectKey = stringField(body, 'projectKey');
    const templateId = stringField(body, 'templateId');
    const created = this.createDemandFromUi({
      title: title.trim(),
      ...(description === undefined ? {} : { description }),
      acceptanceCriteria,
      ...(requesterUserId === undefined ? {} : { requesterUserId }),
      ...(orgUnit === undefined ? {} : { orgUnit }),
      ...(priority === 'high' || priority === 'normal' || priority === 'low' ? { priority } : {}),
      ...(repoKey === undefined ? {} : { repoKey }),
      ...(projectKey === undefined ? {} : { projectKey }),
      ...(templateId === undefined ? {} : { templateId }),
    });
    jsonBody(response, 201, { demand: created.demand, eventId: created.event.eventId });
  }

  private handleGetDemand(demandId: string, response: ServerResponse): void {
    const demand = this.demands.get(demandId);
    if (demand === undefined) {
      errorBody(response, 404, 'not_found', `demand ${demandId} not found`);
      return;
    }
    jsonBody(response, 200, {
      demand,
      artifacts: this.listDemandArtifacts(demandId),
      approvals: this.listDemandApprovals(demandId),
      serverTime: nowIso(this.clock),
    });
  }

  private parseIfMatch(raw: string | undefined): number | null {
    if (raw === undefined) return null;
    const match = /^"?(\d+)"?$/.exec(raw.trim().replace(/^W\//, ''));
    if (match === null) return null;
    return Number.parseInt(match[1] ?? '', 10);
  }

  private handlePatchDemand(
    demandId: string,
    request: IncomingMessage,
    rawBody: string,
    response: ServerResponse,
  ): void {
    const demand = this.demands.get(demandId);
    if (demand === undefined) {
      errorBody(response, 404, 'not_found', `demand ${demandId} not found`);
      return;
    }
    const ifMatch = this.parseIfMatch(request.headers['if-match'] as string | undefined);
    if (ifMatch === null) {
      errorBody(response, 428, 'precondition_required', 'PATCH requires an If-Match version');
      return;
    }
    if (ifMatch !== demand.version) {
      const record: FakeWritebackRecord = {
        demandId,
        ifMatch: String(ifMatch),
        patch: {},
        status: 409,
        at: nowIso(this.clock),
      };
      this.writebacks.push(record);
      jsonBody(response, 409, {
        error: { code: 'conflict', message: 'version mismatch' },
        currentVersion: demand.version,
        demand,
      });
      return;
    }

    const body = asRecord(parseJson(rawBody));
    if (body === undefined) {
      errorBody(response, 400, 'validation', 'request body must be a JSON object');
      return;
    }
    const allowed = new Set(['status', 'statusText', 'stageKey', 'artifacts', 'approval']);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        errorBody(response, 400, 'validation', `field "${key}" is not writable by the control plane`);
        return;
      }
    }
    this.writebacks.push({
      demandId,
      ifMatch: String(ifMatch),
      patch: body,
      status: 200,
      at: nowIso(this.clock),
    });

    const status = stringField(body, 'status');
    if (status !== undefined) demand.status = status;
    const statusText = stringField(body, 'statusText');
    if (statusText !== undefined) demand.statusText = statusText;
    if ('stageKey' in body) {
      demand.stageKey = typeof body['stageKey'] === 'string' ? body['stageKey'] : null;
    }
    const artifacts = body['artifacts'];
    if (Array.isArray(artifacts)) {
      for (const entry of artifacts) {
        const record = asRecord(entry);
        const artifactId = record === undefined ? undefined : stringField(record, 'artifactId');
        if (record === undefined || artifactId === undefined) continue;
        this.artifacts.set(artifactId, {
          artifactId,
          demandId,
          stageKey: stringField(record, 'stageKey') ?? demand.stageKey ?? '',
          stageRunId: typeof record['stageRunId'] === 'string' ? record['stageRunId'] : null,
          kind: stringField(record, 'kind') ?? 'free_note',
          version: typeof record['version'] === 'number' ? record['version'] : 1,
          checksum: stringField(record, 'checksum') ?? '',
          contentRef: stringField(record, 'contentRef') ?? '',
          contentType: stringField(record, 'contentType') ?? 'application/json',
          status: stringField(record, 'status') ?? 'generated',
        });
      }
    }
    const approval = asRecord(body['approval']);
    if (approval !== undefined) {
      const gateKey = stringField(approval, 'gateKey') ?? 'GATE';
      const state = stringField(approval, 'state');
      const list = this.approvals.get(demandId) ?? [];
      list.push({
        approvalId: randomUUID().replace(/-/g, ''),
        demandId,
        stageKey: demand.stageKey,
        gateKey,
        state:
          state === 'approved' ||
          state === 'rejected' ||
          state === 'withdrawn' ||
          state === 'expired' ||
          state === 'pending'
            ? state
            : 'pending',
        requiredRole: null,
        decidedBy: stringField(approval, 'decidedBy') ?? null,
        decidedAt: typeof approval['decidedAt'] === 'string' ? approval['decidedAt'] : null,
        comment: typeof approval['comment'] === 'string' ? approval['comment'] : null,
      });
      this.approvals.set(demandId, list);
    }

    this.touchDemand(demand);
    jsonBody(response, 200, { demand, version: demand.version, serverTime: nowIso(this.clock) });
  }

  private handleCreateApproval(demandId: string, rawBody: string, response: ServerResponse): void {
    const demand = this.demands.get(demandId);
    if (demand === undefined) {
      errorBody(response, 404, 'not_found', `demand ${demandId} not found`);
      return;
    }
    const body = asRecord(parseJson(rawBody));
    if (body === undefined) {
      errorBody(response, 400, 'validation', 'request body must be a JSON object');
      return;
    }
    const gateKey = stringField(body, 'gateKey');
    const decision = stringField(body, 'decision');
    const decidedBy = stringField(body, 'decidedBy');
    if (gateKey === undefined || (decision !== 'approve' && decision !== 'reject') || decidedBy === undefined) {
      errorBody(response, 400, 'validation', 'gateKey, decision and decidedBy are required');
      return;
    }
    const comment = stringField(body, 'comment');
    const stageKey = stringField(body, 'stageKey');
    const artifactId = stringField(body, 'artifactId');
    const artifactVersion = body['artifactVersion'];
    const result = this.decideApproval({
      demandId,
      gateKey,
      decision,
      decidedBy,
      ...(comment === undefined ? {} : { comment }),
      ...(stageKey === undefined ? {} : { stageKey }),
      ...(artifactId === undefined ? {} : { artifactId }),
      ...(typeof artifactVersion === 'number' ? { artifactVersion } : {}),
    });
    jsonBody(response, 201, {
      approval: result.approval,
      demand,
      eventId: result.event.eventId,
      serverTime: nowIso(this.clock),
    });
  }

  private requireDemand(demandId: string): FakeIcfDemand {
    const demand = this.demands.get(demandId);
    if (demand === undefined) throw new Error(`unknown demand ${demandId}`);
    return demand;
  }

  private touchDemand(demand: FakeIcfDemand): void {
    demand.version += 1;
    demand.changedAt = nowIso(this.clock);
  }
}
