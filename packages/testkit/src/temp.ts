import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fresh state directory for an isolated control-plane instance. */
export async function createTempStateDir(prefix = 'sap-superagent-e2e-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempStateDir(stateDir: string): Promise<void> {
  await rm(stateDir, { recursive: true, force: true });
}

/** Repository root, resolved from any file inside `packages/<pkg>/src`. */
export function resolveRepoRoot(fromUrl: string | URL = import.meta.url): string {
  return fileURLToPath(new URL('../../../', fromUrl));
}

export function resolveTemplatesDir(fromUrl: string | URL = import.meta.url): string {
  return join(resolveRepoRoot(fromUrl), 'templates');
}
