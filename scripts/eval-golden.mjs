#!/usr/bin/env node
// Golden-set evaluation (H1 task book §1.6, docs/009 §3).
//
// Runs the pinned requirement_analysis stage over evals/golden/cases.json with
// the fake provider by default (offline, deterministic) or the configured BYOK
// provider when SA_AI_PROVIDER is not `fake`, then writes evals/report.json and
// prints the metrics + auto/observe recommendation. The script never mutates
// templates; it only recommends the stage autonomy from the human edit ratio.
//
// Usage:
//   pnpm eval:golden            # evaluate, write evals/report.json
//   pnpm eval:golden --check    # re-evaluate and compare with the committed report
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checkOnly = process.argv.includes('--check');

function build() {
  const result = spawnSync(
    'pnpm',
    ['--filter', '@sap-superagent/server...', 'run', 'build'],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.error !== undefined) {
    console.error(`eval:golden build failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    console.error('eval:golden build failed');
    process.exit(result.status ?? 1);
  }
}

build();

const serverDist = path.join(root, 'packages/server/dist/evals/golden.js');
const aiDist = path.join(root, 'packages/ai/dist/index.js');
if (!existsSync(serverDist) || !existsSync(aiDist)) {
  console.error('eval:golden requires built packages (server/ai dist missing after build)');
  process.exit(1);
}

const { runGoldenEvaluation, serializeGoldenReport } = await import(
  pathToFileURL(serverDist).href
);
const ai = await import(pathToFileURL(aiDist).href);
const { FakeModelProvider, createModelProviderFromEnv, DEFAULT_AI_MODEL } = ai;

const configuredProvider = (process.env.SA_AI_PROVIDER ?? '').trim().toLowerCase();
const useRealProvider = configuredProvider.length > 0 && configuredProvider !== 'fake';
const provider = useRealProvider ? createModelProviderFromEnv(process.env) : new FakeModelProvider();
const model = useRealProvider
  ? (process.env.SA_AI_MODEL?.trim() || DEFAULT_AI_MODEL)
  : 'fake-model';

const report = await runGoldenEvaluation(root, {
  provider,
  providerName: useRealProvider ? configuredProvider : 'fake',
  model,
});
const serialized = serializeGoldenReport(report);
const reportPath = path.join(root, 'evals/report.json');

const metrics = report.metrics;
console.log('golden set:', report.suiteId, `(${metrics.caseCount} cases)`);
console.log(`  provider:                ${report.provider} (${report.model})`);
console.log(`  schema pass rate:        ${(metrics.schemaPassRate * 100).toFixed(1)}%`);
console.log(`  checklist pass rate:     ${(metrics.checklistPassRate * 100).toFixed(1)}%`);
console.log(`  reference integrity:     ${(metrics.referenceIntegrity * 100).toFixed(1)}%`);
console.log(`  human edit rate:         ${(metrics.humanEditRate * 100).toFixed(1)}%`);
console.log(`  cost / case:             $${metrics.costPerCaseUsd.toFixed(4)}`);
console.log(`  autonomy suggestion:     ${report.autonomyRecommendation.mode} (${report.autonomyRecommendation.reason})`);
if (report.failures.length > 0) {
  console.error('threshold failures:');
  for (const failure of report.failures) console.error(`  - ${failure}`);
}

if (checkOnly) {
  if (!existsSync(reportPath)) {
    console.error(`missing ${path.relative(root, reportPath)} (run pnpm eval:golden)`);
    process.exit(1);
  }
  const committed = readFileSync(reportPath, 'utf8');
  if (committed !== serialized) {
    console.error('evals/report.json is stale (run pnpm eval:golden)');
    process.exit(1);
  }
  console.log('report check ok: evals/report.json is up to date');
} else {
  writeFileSync(reportPath, serialized);
  console.log(`wrote ${path.relative(root, reportPath)}`);
}

process.exit(report.passed ? 0 : 1);
