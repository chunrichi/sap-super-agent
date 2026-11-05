import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeIcfServer } from '../src/fake-icf-server.js';

// ---------------------------------------------------------------------------
// H2 Phase A: the fake ICF server must mirror docs/004 §3.2 closely enough that
// the control-plane integration tests can rely on it (and on fault injection).
// ---------------------------------------------------------------------------

const servers: FakeIcfServer[] = [];
const targets: Server[] = [];

async function startFake(options: ConstructorParameters<typeof FakeIcfServer>[0] = {}) {
  const fake = new FakeIcfServer({ hookSecret: 'fake-secret', ...options });
  servers.push(fake);
  await fake.start();
  return fake;
}

async function startEchoTarget(): Promise<{ url: string; requests: Array<{ headers: Record<string, unknown>; body: string }>; close(): Promise<void> }> {
  const requests: Array<{ headers: Record<string, unknown>; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
    });
  });
  targets.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    targets.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('fake ICF server (docs/004 §3.2)', () => {
  it('serves the six documented routes', async () => {
    const fake = await startFake();
    // GET /api/health
    const health = await fetch(`${fake.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', system: 'FAKE-SAP' });

    // POST /api/demands (SAP Web page)
    const created = await fetch(`${fake.url}/api/demands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '取数逻辑',
        description: '按销售组织汇总',
        acceptanceCriteria: ['金额一致'],
        requesterUserId: 'REQ001',
        repoKey: 'z-sales',
        projectKey: 'SALES',
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { demand: { demandId: string } };
    const demandId = createdBody.demand.demandId;
    expect(demandId).toMatch(/^[0-9a-f]{32}$/);
    expect(fake.outbox.map((event) => event.type)).toEqual(['demand.submitted']);

    // GET /api/demands?status=&q=&changedSince=
    const list = await fetch(`${fake.url}/api/demands?status=${encodeURIComponent('待分析')}&q=取数`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { demands: Array<{ demandId: string }> };
    expect(listBody.demands.map((demand) => demand.demandId)).toContain(demandId);
    const empty = await fetch(`${fake.url}/api/demands?changedSince=2999-01-01T00:00:00.000Z`);
    expect(((await empty.json()) as { demands: unknown[] }).demands).toHaveLength(0);

    // GET /api/demands/{id}
    const detail = await fetch(`${fake.url}/api/demands/${demandId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      demand: { demandId, title: '取数逻辑' },
      artifacts: [],
      approvals: [],
    });
    expect((await fetch(`${fake.url}/api/demands/${'a'.repeat(32)}`)).status).toBe(404);

    // PATCH /api/demands/{id} with If-Match
    const patched = await fetch(`${fake.url}/api/demands/${demandId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '1' },
      body: JSON.stringify({
        status: '开发中',
        statusText: '开发中',
        stageKey: 'dev_implementation',
        artifacts: [
          {
            artifactId: '01J9ZZZZZZZZZZZZZZZZZZZZZ',
            stageKey: 'requirement_analysis',
            stageRunId: '01J8ZZZZZZZZZZZZZZZZZZZZZ',
            kind: 'requirement_analysis',
            version: 1,
            checksum: `sha256:${'a'.repeat(64)}`,
            contentRef: 'artifact://01J9ZZZZZZZZZZZZZZZZZZZZZ/v1',
            contentType: 'application/json',
            status: 'generated',
          },
        ],
      }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { demand: { version: number; status: string } };
    expect(patchedBody.demand).toMatchObject({ status: '开发中', version: 2 });
    expect(fake.writebacks).toHaveLength(1);
    expect(fake.artifacts.get('01J9ZZZZZZZZZZZZZZZZZZZZZ')?.kind).toBe('requirement_analysis');

    // POST /api/demands/{id}/approvals
    const approval = await fetch(`${fake.url}/api/demands/${demandId}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gateKey: 'G1',
        decision: 'approve',
        decidedBy: 'CONSULTANT01',
        comment: '确认',
        stageKey: 'requirement_analysis',
        artifactId: '01J9ZZZZZZZZZZZZZZZZZZZZZ',
      }),
    });
    expect(approval.status).toBe(201);
    expect(fake.approvals.get(demandId)?.[0]).toMatchObject({ gateKey: 'G1', state: 'approved' });
    expect(fake.outbox.at(-1)).toMatchObject({ type: 'artifact.approved' });
  });

  it('enforces auth, If-Match and the writeback whitelist', async () => {
    const fake = await startFake({ serviceUser: 'ZSA_CP_SERVICE', servicePassword: 'pw' });
    const unauth = await fetch(`${fake.url}/api/health`);
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const auth = Buffer.from('ZSA_CP_SERVICE:pw').toString('base64');
    const healthy = await fetch(`${fake.url}/api/health`, { headers: { authorization: `Basic ${auth}` } });
    expect(healthy.status).toBe(200);

    const fake2 = await startFake();
    const demand = fake2.seedDemand({ title: '白名单' });
    const missingIfMatch = await fetch(`${fake2.url}/api/demands/${demand.demandId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: '开发中' }),
    });
    expect(missingIfMatch.status).toBe(428);

    const conflict = await fetch(`${fake2.url}/api/demands/${demand.demandId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '99' },
      body: JSON.stringify({ status: '开发中' }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'conflict' }, currentVersion: 1 });

    const businessField = await fetch(`${fake2.url}/api/demands/${demand.demandId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '1' },
      body: JSON.stringify({ title: 'control plane must not edit business fields' }),
    });
    expect(businessField.status).toBe(400);
    expect(await businessField.json()).toMatchObject({ error: { code: 'validation' } });
  });

  it('injects timeouts, 401s, 409s and malformed JSON for negative-path tests', async () => {
    const fake = await startFake();
    fake.injectFault({ kind: 'status', status: 401, body: { error: { code: 'unauthorized', message: 'x' } } });
    const unauthorized = await fetch(`${fake.url}/api/health`);
    expect(unauthorized.status).toBe(401);

    fake.injectFault({ kind: 'status', status: 409, pathIncludes: '/api/demands/' });
    const demand = fake.seedDemand({ title: 'conflict' });
    const conflict = await fetch(`${fake.url}/api/demands/${demand.demandId}`);
    expect(conflict.status).toBe(409);

    fake.injectFault({ kind: 'bad_json', bodyText: '{"status": "ok"' });
    const broken = await fetch(`${fake.url}/api/health`);
    await expect(broken.text()).resolves.toBe('{"status": "ok"');

    fake.injectFault({ kind: 'timeout', delayMs: 40, pathIncludes: '/api/health' });
    const startedAt = Date.now();
    const slow = await fetch(`${fake.url}/api/health`);
    expect(slow.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
  });

  it('signs outbound webhook deliveries with the documented HMAC headers', async () => {
    const fake = await startFake({ hookSecret: 'integration-secret' });
    const target = await startEchoTarget();
    const { event } = fake.createDemandFromUi({
      title: '签名需求',
      acceptanceCriteria: ['验收 1'],
      requesterUserId: 'REQ009',
    });

    const results = await fake.deliverEvents(target.url, { secret: 'integration-secret' });
    expect(results).toEqual([
      expect.objectContaining({ eventId: event.eventId, type: 'demand.submitted', status: 202 }),
    ]);
    const delivered = target.requests[0];
    expect(delivered).toBeDefined();
    const body = delivered?.body ?? '';
    const expectedSignature = `sha256=${createHmac('sha256', 'integration-secret').update(body).digest('hex')}`;
    expect(delivered?.headers['x-sa-signature']).toBe(expectedSignature);
    expect(delivered?.headers['x-sa-delivery']).toBe(event.eventId);
    expect(new Date(String(delivered?.headers['x-sa-timestamp'])).toString()).not.toBe('Invalid Date');
    expect(JSON.parse(body)).toMatchObject({
      eventId: event.eventId,
      data: { type: 'demand.submitted', demand: { title: '签名需求' } },
    });
    expect(fake.outbox[0]?.state).toBe('SENT');
  });

  it('can tamper deliveries to exercise 401/duplicate paths', async () => {
    const fake = await startFake({ hookSecret: 's3cret' });
    const target = await startEchoTarget();
    fake.createDemandFromUi({ title: '篡改' });
    const event = fake.outbox[0];
    expect(event).toBeDefined();

    const tampered = fake.buildDelivery(event as NonNullable<typeof event>, { tamper: 'signature' });
    expect(tampered.headers['x-sa-signature']).not.toBe(
      `sha256=${createHmac('sha256', 's3cret').update(tampered.body).digest('hex')}`,
    );
    const stale = fake.buildDelivery(event as NonNullable<typeof event>, {
      timestamp: '2000-01-01T00:00:00.000Z',
    });
    expect(stale.headers['x-sa-timestamp']).toBe('2000-01-01T00:00:00.000Z');
    const duplicate = fake.buildDelivery(event as NonNullable<typeof event>, { delivery: 'fixed-delivery' });
    expect(duplicate.headers['x-sa-delivery']).toBe('fixed-delivery');
    fake.clearFaults();
    expect(target.requests).toHaveLength(0);
  });

  it('resets all simulated state between scenarios', async () => {
    const fake = await startFake();
    fake.createDemandFromUi({ title: 'reset me' });
    expect(fake.demands.size).toBe(1);
    expect(fake.outbox).toHaveLength(1);
    fake.reset();
    expect(fake.demands.size).toBe(0);
    expect(fake.outbox).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });
});
