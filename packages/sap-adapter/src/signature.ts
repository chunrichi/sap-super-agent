import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// HMAC webhook signature for SAP → control-plane events (docs/003 §4.1,
// docs/004 §3.3). The SAP outbox push (ZCL_ZSA_EVENT_PUSH) signs the raw
// request body with a shared secret and sends three headers:
//
//   X-SA-Signature: sha256=<hex(HMAC-SHA256(secret, rawBody))>
//   X-SA-Timestamp: ISO-8601 UTC timestamp (epoch seconds are also accepted)
//   X-SA-Delivery:  stable idempotency key (the SAP outbox EVENT_ID)
//
// The timestamp protects against replay beyond the tolerance window; the
// delivery header is the idempotency key (docs/004 §2.2).
// ---------------------------------------------------------------------------

export const SAP_SIGNATURE_HEADER = 'x-sa-signature';
export const SAP_TIMESTAMP_HEADER = 'x-sa-timestamp';
export const SAP_DELIVERY_HEADER = 'x-sa-delivery';

export const SAP_SIGNATURE_PREFIX = 'sha256=';
export const DEFAULT_SAP_HOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Lower-case header map accepted by the verifier (Node lowercases header names). */
export type SapHookHeaders = Record<string, string | string[] | undefined>;

function headerValue(headers: SapHookHeaders, name: string): string | undefined {
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

/**
 * Compute the canonical `sha256=<hex>` signature over the raw body bytes.
 * Kept dependency-free so the SAP side (ABAP `cl_abap_hmac`) and tests can
 * reproduce the same value from the documented rule.
 */
export function computeSapSignature(secret: string, body: string | Uint8Array): string {
  if (secret.length === 0) throw new Error('SAP hook secret must not be empty');
  const digest = createHmac('sha256', secret).update(bodyBytes(body)).digest('hex');
  return `${SAP_SIGNATURE_PREFIX}${digest}`;
}

export interface SapHookHeaderInput {
  secret: string;
  body: string | Uint8Array;
  /** Idempotency key; defaults to a fresh ULID only when explicitly allows (never random here). */
  delivery: string;
  /** ISO-8601 timestamp; defaults to `new Date().toISOString()`. */
  timestamp?: string;
}

/** Build the three headers SAP must attach to `POST /hooks/sap`. */
export function buildSapHookHeaders(input: SapHookHeaderInput): Record<string, string> {
  if (input.delivery.length === 0) throw new Error('SAP hook delivery id must not be empty');
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    [SAP_SIGNATURE_HEADER]: computeSapSignature(input.secret, input.body),
    [SAP_TIMESTAMP_HEADER]: timestamp,
    [SAP_DELIVERY_HEADER]: input.delivery,
  };
}

export type SapHookVerificationCode =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'missing_delivery'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'invalid_signature';

export interface SapHookVerificationOk {
  ok: true;
  delivery: string;
  timestamp: string;
}

export interface SapHookVerificationFailure {
  ok: false;
  code: SapHookVerificationCode;
  message: string;
}

export type SapHookVerification = SapHookVerificationOk | SapHookVerificationFailure;

export interface VerifySapHookInput {
  secret: string;
  body: string | Uint8Array;
  headers: SapHookHeaders;
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
  // Strip an optional extra `sha256=` the caller may have kept in the value.
  const normalized = received.startsWith(SAP_SIGNATURE_PREFIX)
    ? received
    : `${SAP_SIGNATURE_PREFIX}${received}`;
  const receivedBytes = Buffer.from(normalized, 'utf8');
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

/**
 * Verify an inbound SAP webhook: signature first (constant time), then the
 * replay window. Returns a structured result instead of throwing so the HTTP
 * handler can map it onto the docs/003 §4.1 error envelope.
 */
export function verifySapHookSignature(input: VerifySapHookInput): SapHookVerification {
  const signature = headerValue(input.headers, SAP_SIGNATURE_HEADER);
  if (signature === undefined) {
    return { ok: false, code: 'missing_signature', message: 'missing X-SA-Signature header' };
  }
  const delivery = headerValue(input.headers, SAP_DELIVERY_HEADER);
  if (delivery === undefined) {
    return { ok: false, code: 'missing_delivery', message: 'missing X-SA-Delivery header' };
  }
  const timestamp = headerValue(input.headers, SAP_TIMESTAMP_HEADER);
  if (timestamp === undefined) {
    return { ok: false, code: 'missing_timestamp', message: 'missing X-SA-Timestamp header' };
  }

  const expected = computeSapSignature(input.secret, input.body);
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
  const toleranceMs = input.toleranceMs ?? DEFAULT_SAP_HOOK_TOLERANCE_MS;
  if (Math.abs(now - timestampMs) > toleranceMs) {
    return {
      ok: false,
      code: 'stale_timestamp',
      message: `timestamp outside the ${Math.round(toleranceMs / 1_000)}s replay window`,
    };
  }

  return { ok: true, delivery, timestamp };
}
