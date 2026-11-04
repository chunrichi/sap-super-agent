import { describe, expect, it } from 'vitest';
import { FakeExecutor } from '../src/fake-executor.js';
import { FakeSap } from '../src/fake-sap.js';
import { sha256Checksum, toBase64 } from '../src/checksum.js';
import { waitFor } from '../src/http.js';

describe('testkit checksums', () => {
  it('produces the sha256:<hex> artifact checksum format', () => {
    expect(sha256Checksum('hello')).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(toBase64('hello')).toBe('aGVsbG8=');
  });
});

describe('testkit fakes', () => {
  it('keeps the fake SAP in-memory surface minimal but usable', () => {
    const sap = new FakeSap();
    const created = sap.handle({ method: 'POST', path: '/api/demands', body: { title: 'x' } });
    expect(created.status).toBe(200);
    expect(sap.demands.size).toBe(1);
    expect(sap.events.map((event) => event.type)).toEqual(['demand.submitted']);
    expect(sap.handle({ method: 'GET', path: '/api/health' }).status).toBe(200);
    expect(sap.handle({ method: 'GET', path: '/api/nope' }).status).toBe(404);
  });

  it('constructs a fake executor without a live server (shape only)', () => {
    const executor = new FakeExecutor({
      baseUrl: 'http://127.0.0.1:1',
      executorToken: 'token',
      executorId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
      user: 'DEV001',
    });
    expect(executor.user).toBe('DEV001');
    expect(typeof executor.claim).toBe('function');
  });
});

describe('waitFor', () => {
  it('resolves when the probe becomes truthy', async () => {
    let calls = 0;
    const value = await waitFor(
      async () => {
        calls += 1;
        return calls >= 2 ? 'ready' : undefined;
      },
      { timeoutMs: 1_000, intervalMs: 5, label: 'probe' },
    );
    expect(value).toBe('ready');
  });

  it('throws a labelled timeout error', async () => {
    await expect(
      waitFor(async () => undefined, { timeoutMs: 30, intervalMs: 5, label: 'never' }),
    ).rejects.toThrow(/never/);
  });
});
