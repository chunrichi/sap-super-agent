import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildHookSignatureHeaders,
  computeHookSignature,
  verifyHookSignature,
} from '../src/hooks/hook-signature.js';
import { parseRetryAfter } from '../src/workers/hook-delivery.js';

// ---------------------------------------------------------------------------
// S4 §1.3 unit tests: the generic Hook webhook rule (docs/003 §4.1,
// docs/008 §2/§4/§5) — HMAC body signature, +/-5min replay window, delivery
// idempotency header and the 429 Retry-After parser.
// ---------------------------------------------------------------------------

const SECRET = 'unit-hook-secret';
const BODY = JSON.stringify({ eventId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q', eventType: 'hook.receipt' });
const NOW = Date.parse('2026-11-05T12:00:00.000Z');

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'x-sa-signature': computeHookSignature(SECRET, BODY),
    'x-sa-timestamp': new Date(NOW).toISOString(),
    'x-sa-delivery': 'delivery-1',
    ...overrides,
  };
}

describe('hook signature rule (docs/003 §4.1)', () => {
  it('computes sha256=<hex> over the raw body', () => {
    expect(computeHookSignature(SECRET, BODY)).toBe(
      `sha256=${createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex')}`,
    );
    expect(() => computeHookSignature('', BODY)).toThrow(/must not be empty/);
  });

  it('builds and verifies the three X-SA-* headers', () => {
    const built = buildHookSignatureHeaders({
      secret: SECRET,
      body: BODY,
      delivery: 'delivery-1',
      timestamp: new Date(NOW).toISOString(),
    });
    expect(built['x-sa-signature']).toBe(computeHookSignature(SECRET, BODY));
    expect(built['x-sa-delivery']).toBe('delivery-1');

    expect(verifyHookSignature({ secret: SECRET, body: BODY, headers: built, now: NOW })).toMatchObject({
      ok: true,
      delivery: 'delivery-1',
    });
  });

  it('accepts epoch-seconds timestamps and rejects every malformed/missing header', () => {
    const epochSeconds = String(Math.floor(NOW / 1_000));
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: BODY,
        headers: headers({ 'x-sa-timestamp': epochSeconds }),
        now: NOW,
      }),
    ).toMatchObject({ ok: true });

    expect(
      verifyHookSignature({ secret: SECRET, body: BODY, headers: {}, now: NOW }),
    ).toMatchObject({ ok: false, code: 'missing_signature' });
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: BODY,
        headers: headers({ 'x-sa-delivery': '' }),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'missing_delivery' });
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: BODY,
        headers: headers({ 'x-sa-timestamp': '' }),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'missing_timestamp' });
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: BODY,
        headers: headers({ 'x-sa-signature': computeHookSignature('wrong', BODY) }),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_signature' });
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: `${BODY} `,
        headers: headers(),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_signature' });
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: BODY,
        headers: headers({ 'x-sa-timestamp': 'not-a-date' }),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_timestamp' });
  });

  it('enforces the +/-5min replay window against the server clock', () => {
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: BODY,
        headers: headers({ 'x-sa-timestamp': '2000-01-01T00:00:00.000Z' }),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'stale_timestamp' });
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: BODY,
        headers: headers({ 'x-sa-timestamp': new Date(NOW + 4 * 60_000).toISOString() }),
        now: NOW,
      }),
    ).toMatchObject({ ok: true });
    expect(
      verifyHookSignature({
        secret: SECRET,
        body: BODY,
        headers: headers({ 'x-sa-timestamp': new Date(NOW + 6 * 60_000).toISOString() }),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'stale_timestamp' });
  });
});

describe('parseRetryAfter (docs/008 §5, 429)', () => {
  it('parses delta-seconds and HTTP dates, ignores invalid values', () => {
    expect(parseRetryAfter('3', NOW)).toBe(3_000);
    expect(parseRetryAfter('0', NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000);
    expect(parseRetryAfter(new Date(NOW - 5_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter('soon', NOW)).toBeNull();
  });
});
