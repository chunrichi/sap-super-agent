import { createHash } from 'node:crypto';

/** `sha256:<64 lowercase hex>` as required by artifact checksum validation. */
export function sha256Checksum(content: string | Uint8Array): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return `sha256:${hash}`;
}

export function toBase64(content: string | Uint8Array): string {
  return Buffer.from(content).toString('base64');
}
