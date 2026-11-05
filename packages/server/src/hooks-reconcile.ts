#!/usr/bin/env node
// ---------------------------------------------------------------------------
// S4: `pnpm hooks:reconcile` (docs/008 §7, task book §1.6).
//
// Read-only daily reconcile for the generic Hook queue: compares the
// control-plane outbox/receipts with the external list a hook configures via
// `reconcileUrl` and reports differences. It never writes, never repairs and
// never replays creation actions (that is what POST /hooks/{id}/replay is for,
// with a human deciding).
//
// Configuration comes from the same environment as the server (.env is loaded):
//   SA_STATE_DIR (default .sap-superagent/state), SA_HOOKS_CONFIG.
// Usage: hooks:reconcile [--state-dir <dir>] [--config <file>] [--sla-hours <n>]
//                        [--json] [--fail-on-diff]
// Exit: 0 no actionable difference (or --fail-on-diff missing), 3 differences
//       with --fail-on-diff, 2 invalid usage / explicit state dir missing.
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEnv } from './config.js';
import { openDatabase } from './db/database.js';
import { resolveHooksConfig } from './hooks/hook-config.js';
import { DEFAULT_HOOK_RECONCILE_SLA_MS, reconcileHooks } from './hooks/reconcile.js';

interface CliOptions {
  stateDir: string;
  stateDirExplicit: boolean;
  slaHours: number;
  json: boolean;
  failOnDiff: boolean;
  configPath?: string;
}

// The CLI is launched through `scripts/hooks-reconcile.mjs`, which runs tsx from
// packages/server; resolve repo-level defaults (state dir, .env, hook config)
// from the source location so `pnpm hooks:reconcile` behaves like the server
// started from the repo root.
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DEFAULT_STATE_DIR = resolve(REPO_ROOT, '.sap-superagent/state');

function fail(message: string): never {
  console.error(`hooks:reconcile: ${message}`);
  process.exit(2);
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliOptions {
  let stateDir = env['SA_STATE_DIR']?.trim() ?? '';
  let stateDirExplicit = stateDir.length > 0;
  let slaHours = DEFAULT_HOOK_RECONCILE_SLA_MS / (60 * 60 * 1_000);
  let json = false;
  let failOnDiff = false;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--state-dir') {
      stateDir = argv[index + 1] ?? '';
      stateDirExplicit = true;
      index += 1;
    } else if (arg === '--config') {
      configPath = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--sla-hours') {
      const parsed = Number.parseFloat(argv[index + 1] ?? '');
      if (!Number.isFinite(parsed) || parsed < 0) fail('--sla-hours must be a non-negative number');
      slaHours = parsed;
      index += 1;
    } else if (arg === '--json' || arg === '--pretty-json') {
      json = true;
    } else if (arg === '--fail-on-diff') {
      failOnDiff = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: hooks:reconcile [--state-dir <dir>] [--config <file>] [--sla-hours <n>] [--json] [--fail-on-diff]',
      );
      process.exit(0);
    } else {
      fail(`unknown argument "${arg}"`);
    }
  }
  if (stateDir.length === 0) stateDir = DEFAULT_STATE_DIR;
  else if (!stateDir.startsWith('/')) stateDir = resolve(process.cwd(), stateDir);
  return {
    stateDir,
    stateDirExplicit,
    slaHours,
    json,
    failOnDiff,
    ...(configPath === undefined ? {} : { configPath }),
  };
}

async function main(): Promise<void> {
  const env = resolveEnv(REPO_ROOT);
  const options = parseArgs(process.argv.slice(2), env);
  if (options.configPath !== undefined) {
    if (options.configPath.length === 0) fail('--config must not be empty');
    env['SA_HOOKS_CONFIG'] = resolve(process.cwd(), options.configPath);
  } else if (env['SA_HOOKS_CONFIG'] !== undefined && env['SA_HOOKS_CONFIG'].trim().length > 0) {
    env['SA_HOOKS_CONFIG'] = resolve(process.cwd(), env['SA_HOOKS_CONFIG'].trim());
  } else {
    env['SA_HOOKS_CONFIG'] = resolve(REPO_ROOT, 'examples/hooks.yaml');
  }
  // Read-only: reconcile never signs or verifies, so it works without secrets.
  const hooks = resolveHooksConfig(env, REPO_ROOT, { requireSecrets: false });
  const dbPath = resolve(options.stateDir, 'state.db');
  const slaMs = Math.round(options.slaHours * 60 * 60 * 1_000);

  if (!existsSync(dbPath)) {
    if (options.stateDirExplicit) {
      fail(`control-plane state database not found at ${dbPath}; check --state-dir / SA_STATE_DIR`);
    }
    console.log(
      `hooks:reconcile: no control-plane state at ${dbPath} (run pnpm dev once to create it); ` +
        `${hooks.hooks.length === 0 ? 'no hooks configured' : `${hooks.hooks.length} hook(s)`}, no differences`,
    );
    process.exit(0);
  }

  const db = openDatabase(dbPath);
  let report;
  try {
    report = await reconcileHooks(db, hooks, { slaMs });
  } finally {
    db.close();
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `hooks:reconcile @ ${report.checkedAt} (SLA ${options.slaHours}h, config ${hooks.configPath}): ${report.summary}`,
    );
    for (const check of report.external) {
      console.log(
        check.ok
          ? `  external ${check.hookId}: ${check.externalCount} item(s) compared`
          : `  external ${check.hookId}: cannot compare (${check.reason})`,
      );
    }
    for (const difference of report.differences) {
      const external = difference.externalId === undefined ? '' : ` externalId=${difference.externalId}`;
      const event = difference.eventId === undefined ? '' : ` eventId=${difference.eventId}`;
      console.log(
        `  - [${difference.kind}] ${difference.hookId}${external}${event} ${JSON.stringify(difference.details)}`,
      );
    }
    if (report.differences.length === 0) console.log('  no differences');
  }

  // Reconcile is report-only; a difference needs a human, not a retry.
  process.exit(options.failOnDiff && report.differences.length > 0 ? 3 : 0);
}

main().catch((error: unknown) => {
  console.error(`hooks:reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
