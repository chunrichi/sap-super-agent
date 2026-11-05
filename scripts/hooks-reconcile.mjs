#!/usr/bin/env node
// S4 root command `pnpm hooks:reconcile` (docs/008 §7).
//
// Delegates to the typed implementation in @sap-superagent/server (mirrors
// scripts/e2e.mjs delegating to the testkit suite), so the reconcile logic is
// unit/e2e testable and shares the server's .env / SA_* resolution.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverDir = path.join(root, 'packages', 'server');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = path.join(serverDir, 'src', 'hooks-reconcile.ts');

// Spawn tsx directly (not through `pnpm exec`) so the CLI's documented exit
// codes survive: 0 no actionable difference, 3 with --fail-on-diff, 2 usage.
const result = spawnSync(process.execPath, [tsxCli, script, ...process.argv.slice(2)], {
  cwd: serverDir,
  stdio: 'inherit',
});

if (result.error !== undefined) {
  console.error(`hooks:reconcile failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
