#!/usr/bin/env node
// ---------------------------------------------------------------------------
// H2: `pnpm --filter @sap-superagent/server sap:reconcile`
//
// Read-only daily reconcile (docs/004 §3.1 chunk 3, docs/008 §6): pull the SAP
// demand delta by the CHANGED_AT cursor, diff it against the demands stored in
// the control-plane SQLite state and print the difference report. It never
// writes business fields and never replays creation actions (docs/008 §5).
//
// Configuration comes from the same environment as the server (.env is loaded):
//   SA_STATE_DIR (default .sap-superagent/state), SA_SAP_BASE_URL,
//   SA_SAP_SERVICE_USER/PASSWORD (or SA_SAP_SERVICE_TOKEN).
// Usage: sap:reconcile [--state-dir <dir>] [--changed-since <ISO>] [--limit <n>] [--json]
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { reconcileSapDemands, SapIcfClient, type ReconcileLocalDemand } from '@sap-superagent/sap-adapter';
import { resolveEnv } from './config.js';
import { openDatabase } from './db/database.js';
import { resolveSapConfig } from './hooks/sap-config.js';

interface CliOptions {
  stateDir: string;
  changedSince: string;
  limit?: number;
  json: boolean;
}

const DEFAULT_CHANGED_SINCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function fail(message: string): never {
  console.error(`sap:reconcile: ${message}`);
  process.exit(2);
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliOptions {
  let stateDir = env['SA_STATE_DIR']?.trim() ?? '';
  let changedSince = new Date(Date.now() - DEFAULT_CHANGED_SINCE_WINDOW_MS).toISOString();
  let limit: number | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--state-dir') {
      stateDir = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--changed-since') {
      changedSince = argv[index + 1] ?? changedSince;
      index += 1;
    } else if (arg === '--limit') {
      const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
      if (!Number.isInteger(parsed) || parsed <= 0) fail('--limit must be a positive integer');
      limit = parsed;
      index += 1;
    } else if (arg === '--json' || arg === '--pretty-json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: sap:reconcile [--state-dir <dir>] [--changed-since <ISO>] [--limit <n>] [--json]',
      );
      process.exit(0);
    } else {
      fail(`unknown argument "${arg}"`);
    }
  }
  if (stateDir.length === 0) stateDir = '.sap-superagent/state';
  if (Number.isNaN(Date.parse(changedSince))) fail('--changed-since must be an ISO-8601 timestamp');
  return {
    stateDir,
    changedSince,
    json,
    ...(limit === undefined ? {} : { limit }),
  };
}

async function main(): Promise<void> {
  const env = resolveEnv();
  const options = parseArgs(process.argv.slice(2), env);
  const dbPath = resolve(options.stateDir, 'state.db');
  if (!existsSync(dbPath)) fail(`control-plane state database not found at ${dbPath}`);
  const sap = resolveSapConfig(env);
  if (!sap.enabled) {
    fail(
      'SAP integration is not configured (set SA_SAP_BASE_URL + SA_SAP_SERVICE_USER/PASSWORD or SA_SAP_SERVICE_TOKEN)',
    );
  }

  const db = openDatabase(dbPath);
  let local: ReconcileLocalDemand[];
  try {
    const rows = db
      .prepare(`SELECT id, status, title, source FROM demands WHERE source = 'sap' ORDER BY id ASC`)
      .all() as unknown as Array<{ id: string; status: string; title: string; source: string }>;
    local = rows.map((row) => ({
      id: String(row.id),
      status: String(row.status) as ReconcileLocalDemand['status'],
      title: String(row.title),
      source: 'sap',
    }));
  } finally {
    db.close();
  }

  const client = new SapIcfClient({
    baseUrl: sap.baseUrl,
    timeoutMs: sap.timeoutMs,
    ...(sap.token === undefined ? {} : { token: sap.token }),
    ...(sap.username === undefined ? {} : { username: sap.username }),
    ...(sap.password === undefined ? {} : { password: sap.password }),
  });
  const report = await reconcileSapDemands(client, local, {
    changedSince: options.changedSince,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `SAP reconcile @ ${report.checkedAt} (changedSince ${report.changedSince}): ` +
        `${report.sapCount} SAP demands / ${report.localCount} control-plane SAP demands, ` +
        `${report.differences.length} difference(s)`,
    );
    for (const [kind, count] of Object.entries(report.counts)) {
      if (count > 0) console.log(`  ${kind}: ${count}`);
    }
    for (const difference of report.differences) {
      console.log(`  - [${difference.kind}] ${difference.demandId} ${JSON.stringify(difference.details)}`);
    }
    console.log(`next cursor: ${report.nextCursor}`);
  }
  // Reconcile is report-only; a non-empty report needs a human, not a retry.
  process.exit(report.differences.length === 0 ? 0 : 3);
}

main().catch((error: unknown) => {
  console.error(`sap:reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
