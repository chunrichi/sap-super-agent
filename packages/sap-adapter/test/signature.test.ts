import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAP_HOOK_TOLERANCE_MS,
  SAP_SIGNATURE_HEADER,
  buildSapHookHeaders,
  computeSapSignature,
  verifySapHookSignature,
} from '../src/index.js';

const SECRET = 'test-hook-secret';
const BODY = '{"data":{"type":"demand.submitted","demandId":"4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3"}}';
const NOW = Date.parse('2026-11-05T08:00:00Z');

function sign(body = BODY, timestamp = '2026-11-05T08:00:00Z', delivery = 'delivery-1') {
  const headers = buildSapHookHeaders({ secret: SECRET, body, delivery, timestamp });
  return { body, headers, now: NOW };
}

describe('SAP hook signature (docs/003 §4.1, docs/004 §3.3)', () => {
  it('computes the documented HMAC-SHA256 over the raw body', () => {
    const expected = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(computeSapSignature(SECRET, BODY)).toBe(`sha256=${expected}`);
    // Deterministic snapshot: the ABAP side (cl_abap_hmac) must reproduce this.
    expect(computeSapSignature(SECRET, BODY)).toMatchInlineSnapshot(
      `"sha256=5098e3bd422a9efd1f7d802a99e059a00afb3664d0df8358b9cce9f289218a7d"`,
    );
  });

  it('accepts a correctly signed, fresh delivery and returns its idempotency key', () => {
    const input = sign();
    const verified = verifySapHookSignature({
      secret: SECRET,
      body: input.body,
      headers: input.headers,
      now: NOW,
    });
    expect(verified).toEqual({ ok: true, delivery: 'delivery-1', timestamp: '2026-11-05T08:00:00Z' });
  });

  it('verifies header names case-insensitively and tolerates a bare hex signature', () => {
    const input = sign();
    const signature = input.headers[SAP_SIGNATURE_HEADER] ?? '';
    const verified = verifySapHookSignature({
      secret: SECRET,
      body: input.body,
      headers: {
        'X-SA-Signature': signature.slice('sha256='.length),
        'X-SA-Timestamp': input.headers['x-sa-timestamp'] ?? '',
        'X-SA-Delivery': input.headers['x-sa-delivery'] ?? '',
      },
      now: NOW,
    });
    expect(verified.ok).toBe(true);
  });

  it('accepts epoch-seconds timestamps within the replay window', () => {
    const input = sign(BODY, String(Math.floor(NOW / 1_000)));
    const verified = verifySapHookSignature({
      secret: SECRET,
      body: input.body,
      headers: input.headers,
      now: NOW,
    });
    expect(verified.ok).toBe(true);
  });

  it('rejects a tampered body (signature mismatch)', () => {
    const input = sign();
    const verified = verifySapHookSignature({
      secret: SECRET,
      body: `${BODY} `,
      headers: input.headers,
      now: NOW,
    });
    expect(verified).toMatchObject({ ok: false, code: 'invalid_signature' });
  });

  it('rejects a wrong secret', () => {
    const input = sign();
    const verified = verifySapHookSignature({
      secret: 'another-secret',
      body: input.body,
      headers: input.headers,
      now: NOW,
    });
    expect(verified).toMatchObject({ ok: false, code: 'invalid_signature' });
  });

  it('rejects a timestamp outside the ±5 minute replay window', () => {
    const input = sign(BODY, new Date(NOW - DEFAULT_SAP_HOOK_TOLERANCE_MS - 1_000).toISOString());
    const verified = verifySapHookSignature({
      secret: SECRET,
      body: input.body,
      headers: input.headers,
      now: NOW,
    });
    expect(verified).toMatchObject({ ok: false, code: 'stale_timestamp' });
  });

  it('reports missing headers explicitly', () => {
    const input = sign();
    const headers = { ...input.headers };
    const { 'x-sa-delivery': _delivery, ...withoutDelivery } = headers;
    expect(
      verifySapHookSignature({ secret: SECRET, body: BODY, headers: withoutDelivery, now: NOW }),
    ).toMatchObject({ ok: false, code: 'missing_delivery' });
    expect(
      verifySapHookSignature({ secret: SECRET, body: BODY, headers: {}, now: NOW }),
    ).toMatchObject({ ok: false, code: 'missing_signature' });
  });

  it('rejects an unparseable timestamp', () => {
    const input = sign(BODY, 'yesterday-ish');
    const verified = verifySapHookSignature({
      secret: SECRET,
      body: input.body,
      headers: input.headers,
      now: NOW,
    });
    expect(verified).toMatchObject({ ok: false, code: 'invalid_timestamp' });
  });
});
