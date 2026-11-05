import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// S4: webhook HMAC helpers for the generic Hook surface (docs/003 §4.1,
// docs/008 §2/§4).
//
// Same wire rules as the SAP webhook (`packages/sap-adapter/src/signature.ts`)
// by design: `X-SA-Signature: sha256=<hex>`, `X-SA-Timestamp` (±5min replay
// window) and `X-SA-Delivery` as the idempotency key. The server deliberately
// re-implements the rule locally (it must not import @sap-superagent/sap-adapter
// for a generic mechanism) and the testkit fake re-implements it a third time,
// so the contract is cross-checked by three independent implementations.
// ---------------------------------------------------------------------------

export const HOOK_SIGNATURE_HEADER = 'x-sa-signature';
export const HOOK_TIMESTAMP_HEADER = 'x-sa-timestamp';
export const HOOK_DELIVERY_HEADER = 'x-sa-delivery';
export const HOOK_SIGNATURE_PREFIX = 'sha256=';

export type HookHeaderMap = Record<string, string | string[] | undefined>;

function headerValue(headers: HookHeaderMap, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value[0];
    if (typeof value === 'string' && value.length > 0) return value;
    return undefined;
  }
  return undefined;
}

function bodyBytes(body: string | Uint8Array): Buffer {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
}

/** `sha256=<hex(HMAC-SHA256(secret, rawBody))>` (docs/008 §2). */
export function computeHookSignature(secret: string, body: string | Uint8Array): string {
  if (secret.length === 0) throw new Error('hook secret must not be empty');
  const digest = createHmac('sha256', secret).update(bodyBytes(body)).digest('hex');
  return `${HOOK_SIGNATURE_PREFIX}${digest}`;
}

export interface HookSignatureHeadersInput {
  secret: string;
  body: string | Uint8Array;
  /** Idempotency key sent as X-SA-Delivery (the envelope idempotencyKey on outbound). */
  delivery: string;
  timestamp?: string;
}

export function buildHookSignatureHeaders(input: HookSignatureHeadersInput): Record<string, string> {
  if (input.delivery.length === 0) throw new Error('hook delivery id must not be empty');
  return {
    [HOOK_SIGNATURE_HEADER]: computeHookSignature(input.secret, input.body),
    [HOOK_TIMESTAMP_HEADER]: input.timestamp ?? new Date().toISOString(),
    [HOOK_DELIVERY_HEADER]: input.delivery,
  };
}

export type HookVerificationCode =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'missing_delivery'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'invalid_signature';

export interface HookVerificationOk {
  ok: true;
  delivery: string;
  timestamp: string;
}

export interface HookVerificationFailure {
  ok: false;
  code: HookVerificationCode;
  message: string;
}

export type HookVerification = HookVerificationOk | HookVerificationFailure;

export interface VerifyHookSignatureInput {
  secret: string;
  body: string | Uint8Array;
  headers: HookHeaderMap;
  /** Current time in epoch ms (injectable for tests/determinism). */
  now?: number;
  toleranceMs?: number;
}

function parseTimestamp(raw: string): number | null {
  if (/^\d{10}$/.test(raw)) return Number.parseInt(raw, 10) * 1_000;
  if (/^\d{13}$/.test(raw)) return Number.parseInt(raw, 10);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function constantsMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const normalized = received.startsWith(HOOK_SIGNATURE_PREFIX)
    ? received
    : `${HOOK_SIGNATURE_PREFIX}${received}`;
  const receivedBytes = Buffer.from(normalized, 'utf8');
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

/**
 * Verify an inbound generic-hook webhook: signature first (constant time), then
 * the ±5min replay window. Returns a structured result so the route can map it
 * onto the docs/003 §4.1 error envelope.
 */
export function verifyHookSignature(input: VerifyHookSignatureInput): HookVerification {
  const signature = headerValue(input.headers, HOOK_SIGNATURE_HEADER);
  if (signature === undefined) {
    return { ok: false, code: 'missing_signature', message: 'missing X-SA-Signature header' };
  }
  const delivery = headerValue(input.headers, HOOK_DELIVERY_HEADER);
  if (delivery === undefined) {
    return { ok: false, code: 'missing_delivery', message: 'missing X-SA-Delivery header' };
  }
  const timestamp = headerValue(input.headers, HOOK_TIMESTAMP_HEADER);
  if (timestamp === undefined) {
    return { ok: false, code: 'missing_timestamp', message: 'missing X-SA-Timestamp header' };
  }

  const expected = computeHookSignature(input.secret, input.body);
  if (!constantsMatch(expected, signature)) {
    return { ok: false, code: 'invalid_signature', message: 'signature does not match body' };
  }

  const timestampMs = parseTimestamp(timestamp);
  if (timestampMs === null) {
    return {
      ok: false,
      code: 'invalid_timestamp',
      message: 'X-SA-Timestamp must be ISO-8601 UTC or epoch seconds',
    };
  }
  const now = input.now ?? Date.now();
  const toleranceMs = input.toleranceMs ?? 5 * 60 * 1_000;
  if (Math.abs(now - timestampMs) > toleranceMs) {
    return {
      ok: false,
      code: 'stale_timestamp',
      message: `timestamp outside the ${Math.round(toleranceMs / 1_000)}s replay window`,
    };
  }

  return { ok: true, delivery, timestamp };
}
