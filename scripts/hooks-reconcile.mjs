#!/usr/bin/env node
// S4 root command `pnpm hooks:reconcile` (docs/008 §7).
//
// Delegates to the typed implementation in @sap-superagent/server (mirrors
// scripts/e2e.mjs delegating to the testkit suite), so the reconcile logic is
// unit/e2e testable and shares the server's .env / SA_* resolution.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@sap-superagent/server',
    'exec',
    'tsx',
    'src/hooks-reconcile.ts',
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);

if (result.error !== undefined) {
  console.error(`hooks:reconcile failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
