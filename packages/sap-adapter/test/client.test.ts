import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { SapIcfClient, SapIcfError } from '../src/index.js';

const BASE_URL = 'https://sap.example.test/sap/zsa';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

type FetchHandler = (request: CapturedRequest) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(handler: FetchHandler): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const request: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function demandPayload() {
  return {
    demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
    demandNo: 'R-2041',
    title: '取数逻辑',
    status: '待分析',
    version: 3,
    changedAt: '2026-11-05T00:00:00.000Z',
  };
}

describe('SAP ICF client (docs/004 §3.2)', () => {
  it('calls /api/health with basic auth and parses the response', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(200, { status: 'ok', system: 'S4H', version: '2.2.0' }),
    );
    const client = new SapIcfClient({
      baseUrl: `${BASE_URL}/`,
      username: 'ZSA_CP_SERVICE',
      password: 'secret',
      fetchImpl,
    });
    await expect(client.health()).resolves.toEqual({ status: 'ok', system: 'S4H', version: '2.2.0' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://sap.example.test/sap/zsa/api/health');
    expect(calls[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('ZSA_CP_SERVICE:secret').toString('base64')}`,
    );
  });

  it('supports a service token instead of basic auth', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, { status: 'ok' }));
    const client = new SapIcfClient({ baseUrl: BASE_URL, token: 'svc-token', fetchImpl });
    await client.health();
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer svc-token');
  });

  it('serializes list filters and maps the demand list', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(200, { demands: [demandPayload()], serverTime: '2026-11-05T00:00:00.000Z' }),
    );
    const client = new SapIcfClient({ baseUrl: BASE_URL, token: 't', fetchImpl });
    const list = await client.listDemands({
      status: '开发中',
      changedSince: '2026-11-04T00:00:00.000Z',
      q: 'R-2041',
      limit: 50,
    });
    expect(list.demands).toHaveLength(1);
    expect(list.demands[0]?.demandId).toBe('4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3');
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/sap/zsa/api/demands');
    expect(url.searchParams.get('status')).toBe('开发中');
    expect(url.searchParams.get('changedSince')).toBe('2026-11-04T00:00:00.000Z');
    expect(url.searchParams.get('q')).toBe('R-2041');
    expect(url.searchParams.get('limit')).toBe('50');
  });

  it('parses demand detail with artifacts and approvals', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(200, {
        demand: demandPayload(),
        artifacts: [
          {
            artifactId: '01J9ZZZZZZZZZZZZZZZZZZZZZ',
            demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
            stageKey: 'requirement_analysis',
            kind: 'requirement_analysis',
            version: 1,
            checksum: `sha256:${'a'.repeat(64)}`,
            contentRef: 'artifact://01J9ZZZZZZZZZZZZZZZZZZZZZ/v1',
          },
        ],
        approvals: [
          {
            approvalId: 'APPROVAL01',
            demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
            gateKey: 'G1',
            state: 'pending',
          },
        ],
      }),
    );
    const client = new SapIcfClient({ baseUrl: BASE_URL, token: 't', fetchImpl });
    const detail = await client.getDemand('4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3');
    expect(detail.demand.demandNo).toBe('R-2041');
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.approvals[0]?.gateKey).toBe('G1');
  });

  it('writes with If-Match and maps 409 to a non-retryable conflict (docs/009 #12)', async () => {
    let call = 0;
    const { fetchImpl, calls } = makeFetch((request) => {
      call += 1;
      if (request.headers.get('if-match') !== '7') {
        return jsonResponse(428, { error: { code: 'precondition_required', message: 'If-Match' } });
      }
      return jsonResponse(409, {
        error: { code: 'conflict', message: 'version mismatch', currentVersion: 9 },
      });
    });
    const client = new SapIcfClient({ baseUrl: BASE_URL, token: 't', fetchImpl });
    await expect(
      client.patchDemand('4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3', { status: '开发中' }, { ifMatch: 7 }),
    ).rejects.toMatchObject({ name: 'SapIcfError', kind: 'conflict', status: 409, retryable: false });
    expect(call).toBe(1);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.headers.get('if-match')).toBe('7');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ status: '开发中' });

    await expect(
      client.patchDemand('4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3', { status: '开发中' }),
    ).rejects.toMatchObject({ kind: 'precondition_required' });
  });

  it('never retries writes: a single 401 fails immediately (docs/009 #9)', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(401, { error: { code: 'unauthorized', message: 'bad credentials' } }),
    );
    const client = new SapIcfClient({
      baseUrl: BASE_URL,
      username: 'u',
      password: 'p',
      getRetries: 3,
      retryDelayMs: 0,
      fetchImpl,
    });
    await expect(client.patchDemand('a'.repeat(32), { status: '开发中' })).rejects.toMatchObject({
      kind: 'unauthorized',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('classifies a 400 session timeout as non-retryable (docs/009 #6)', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(400, { message: 'Session Timed Out. Log on again' }),
    );
    const client = new SapIcfClient({ baseUrl: BASE_URL, token: 't', fetchImpl });
    await expect(client.getDemand('a'.repeat(32))).rejects.toMatchObject({
      kind: 'session_timeout',
      retryable: false,
    });
  });

  it('retries idempotent GETs on 5xx and succeeds on the next attempt', async () => {
    let attempts = 0;
    const { fetchImpl, calls } = makeFetch(() => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse(503, { error: { code: 'unavailable', message: 'busy' } });
      }
      return jsonResponse(200, { status: 'ok' });
    });
    const client = new SapIcfClient({
      baseUrl: BASE_URL,
      token: 't',
      getRetries: 1,
      retryDelayMs: 0,
      fetchImpl,
    });
    await expect(client.health()).resolves.toEqual({ status: 'ok' });
    expect(calls).toHaveLength(2);
  });

  it('maps transport failures and invalid JSON', async () => {
    const networkClient = new SapIcfClient({
      baseUrl: BASE_URL,
      token: 't',
      getRetries: 0,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(networkClient.health()).rejects.toMatchObject({
      kind: 'network_error',
      retryable: true,
    });

    const badJson = new SapIcfClient({
      baseUrl: BASE_URL,
      token: 't',
      getRetries: 0,
      fetchImpl: (async () => new Response('<html>not json</html>', { status: 200 })) as typeof fetch,
    });
    await expect(badJson.health()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('times out slow SAP responses with AbortSignal.timeout', async () => {
    const slow: Server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ok"}');
      }, 150);
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const address = slow.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const client = new SapIcfClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 't',
        timeoutMs: 25,
        getRetries: 0,
      });
      const error = await client.health().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SapIcfError);
      expect(error).toMatchObject({ kind: 'timeout', retryable: true });
    } finally {
      await new Promise<void>((resolve, reject) =>
        slow.close((closeError) => (closeError === undefined ? resolve() : reject(closeError))),
      );
    }
  });

  it('rejects malformed demand payloads instead of propagating them', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(200, { demands: [{ title: 'no id' }] }));
    const client = new SapIcfClient({ baseUrl: BASE_URL, token: 't', fetchImpl });
    await expect(client.listDemands()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
