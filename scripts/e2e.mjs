#!/usr/bin/env node
// Root `pnpm e2e` entrypoint: runs the walking-skeleton end-to-end suite that
// covers docs/009 failure scenarios #1, #2, #3 and #10 against a real local
// control-plane process (temp state dir, fake AI provider, fake executor).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const result = spawnSync('pnpm', ['--filter', '@sap-superagent/testkit', 'run', 'e2e'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error !== undefined) {
  console.error(`e2e failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
