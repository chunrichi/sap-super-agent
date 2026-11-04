import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `sha256:<hex>` over the stored bytes (docs/003 §4.6). */
export function checksumOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function artifactContentRef(artifactId: string, version: number): string {
  return `artifact://${artifactId}/v${version}`;
}

export function artifactContentPath(
  stateDir: string,
  artifactId: string,
  version: number,
): string {
  return join(stateDir, 'artifacts', artifactId, `v${version}.bin`);
}

export function writeArtifactBytes(
  stateDir: string,
  artifactId: string,
  version: number,
  bytes: Uint8Array,
): string {
  const path = artifactContentPath(stateDir, artifactId, version);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

export function readArtifactBytes(
  stateDir: string,
  artifactId: string,
  version: number,
): Uint8Array {
  return readFileSync(artifactContentPath(stateDir, artifactId, version));
}
