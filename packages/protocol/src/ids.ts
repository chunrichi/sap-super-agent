import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';

/** Crockford-base32 ULID, 26 chars (docs/003 §4.1). */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ulidSchema = z.string().regex(ULID_PATTERN, 'expected a 26-char ULID');

/** External primary key for demands: SAP UUID in C32 (32 lowercase hex chars). */
export const DEMAND_ID_PATTERN = /^[0-9a-f]{32}$/;
export const demandIdSchema = z
  .string()
  .regex(DEMAND_ID_PATTERN, 'expected a 32-char lowercase UUID C32');

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

export function isDemandId(value: string): boolean {
  return DEMAND_ID_PATTERN.test(value);
}

/** Generate a control-plane entity ID (ULID). Optional seed time is epoch ms. */
export function newUlid(seedTime?: number): string {
  return seedTime === undefined ? ulid() : ulid(seedTime);
}

/** Generate a demand ID in the external UUID-C32 shape so local and SAP agree. */
export function newDemandId(): string {
  return randomUUID().replace(/-/g, '');
}

export function newIdFactory(): () => string {
  return () => newUlid();
}
