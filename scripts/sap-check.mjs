#!/usr/bin/env node
// ---------------------------------------------------------------------------
// H2 acceptance gate: `pnpm sap:check`
//
// The SAP-side sources must be verifiable without a SAP system (CI). This script
// runs, offline only:
//   1. structural checks on sap/ (abapGit layout, required objects, no secrets);
//   2. `abap validate:aff sap/` — official AFF JSON schemas + companions;
//   3. `abap check content <*.abap>` — local structural check (no SAP round-trip).
//
// `abap check syntax` needs a bound SAP system, so it is skipped by default with
// an explicit message; set SA_SAP_CHECK_ONLINE=1 (and provide .abap.json) to run
// it against a *test* system. Nothing here ever writes to SAP or needs network.
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAP_DIR = resolve(ROOT, 'sap');
const failures = [];
const warnings = [];
const checks = [];

function pass(message) {
  checks.push({ status: 'pass', message });
  console.log(`  ok   ${message}`);
}

function fail(message) {
  failures.push(message);
  checks.push({ status: 'fail', message });
  console.log(`  FAIL ${message}`);
}

function warn(message) {
  warnings.push(message);
  checks.push({ status: 'warn', message });
  console.log(`  skip ${message}`);
}

function hasBinary(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function runAbap(args) {
  return spawnSync('abap', args, { cwd: ROOT, encoding: 'utf8' });
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// ---------------------------------------------------------------------------
// 1. Structural checks (docs/004 §2, §3.2, §4, H2 §1.1)
// ---------------------------------------------------------------------------
console.log('sap:check — offline SAP source gate');

const requiredFiles = [
  'sap/.abapgit.xml',
  'sap/README.md',
  'sap/tests/README.md',
  'sap/src/zsa_demand.tabl.json',
  'sap/src/zsa_demand.tabl.ddic',
  'sap/src/zsa_demand_t.tabl.json',
  'sap/src/zsa_artifact.tabl.json',
  'sap/src/zsa_approval.tabl.json',
  'sap/src/zsa_event_out.tabl.json',
  'sap/src/zsa_cfg.tabl.json',
  'sap/src/zcl_zsa_json.clas.json',
  'sap/src/zcl_zsa_json.clas.abap',
  'sap/src/zcl_zsa_event_push.clas.json',
  'sap/src/zcl_zsa_event_push.clas.abap',
  'sap/src/zcl_zsa_event_push.clas.testclasses.abap',
  'sap/src/zcl_zsa_http_handler.clas.json',
  'sap/src/zcl_zsa_http_handler.clas.abap',
  'sap/src/zcl_zsa_http_handler.clas.testclasses.abap',
  // S5 / M3: SAP batch AI executor (docs/003 section 4.8).
  'sap/src/zcl_zsa_ai_batch.clas.json',
  'sap/src/zcl_zsa_ai_batch.clas.abap',
  'sap/src/zcl_zsa_ai_batch.clas.testclasses.abap',
  'sap/src/zsa_ai_batch_run.prog.json',
  'sap/src/zsa_ai_batch_run.prog.abap',
  'sap/src/zsa.http.json',
  'sap/src/zsa_outbox_push.prog.json',
  'sap/src/zsa_outbox_push.prog.abap',
  'sap/ui/index.html',
  'sap/ui/app.js',
  'sap/ui/styles.css',
];
for (const file of requiredFiles) {
  if (!existsSync(resolve(ROOT, file))) fail(`missing required file: ${file}`);
}
if (failures.length === 0) pass(`abapGit/AFF layout complete (${requiredFiles.length} files)`);

const uiFiles = requiredFiles.filter((file) => file.startsWith('sap/ui/'));
for (const file of uiFiles) {
  const stats = statSync(resolve(ROOT, file));
  if (stats.size === 0) fail(`empty MIME asset: ${file}`);
}
if (uiFiles.every((file) => statSync(resolve(ROOT, file)).size > 0)) {
  pass('MIME UI assets are non-empty (index.html/app.js/styles.css)');
}

// No credentials, system addresses, local SAP configs or transfer requests.
// Filename-level bans (local SAP configs, keys, env files).
const forbiddenPaths = [/\.abap\.json$/, /\.abap-cli\//, /(^|\/)\.env$/, /(^|\/)id_rsa$/];
// Content-level bans: real credentials or a hard-coded SAP system address.
const forbiddenContent = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /SA_SAP_SERVICE_PASSWORD\s*=\s*\S+/,
  /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/,
];
const sapFiles = existsSync(SAP_DIR) ? walk(SAP_DIR) : [];
// Syntax/content checks only target the committed SAP sources. Using
// `abap check syntax --all` would also walk gitignored scratch copies under
// tmp/ (abap pull output), which turns a local UI/ABAP experiment into a
// false CI failure. Keep the explicit list: sap/ is the delivery unit.
const sapAbapFiles = sapFiles.filter((file) => file.endsWith('.abap'));
let secretIssues = 0;
for (const file of sapFiles) {
  const rel = relative(ROOT, file);
  if (forbiddenPaths.some((pattern) => pattern.test(rel))) {
    fail(`forbidden file in sap/: ${rel}`);
    secretIssues += 1;
    continue;
  }
  if (!/\.(json|abap|ddic|md|html|js|css|xml)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (forbiddenContent.some((pattern) => pattern.test(text))) {
    fail(`possible secret/system address pattern in ${rel}`);
    secretIssues += 1;
  }
}
if (secretIssues === 0) pass('no SAP credentials, addresses or transfer requests under sap/');

// ---------------------------------------------------------------------------
// 2. Offline AFF validation (`abap validate:aff`)
// ---------------------------------------------------------------------------
if (!hasBinary('abap')) {
  warn('abap-cli not found — AFF validation skipped (install abap-cli >= 2.2.0 to run it)');
} else {
  const result = runAbap(['validate:aff', 'sap/', '--json']);
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = undefined;
  }
  if (result.status === 0 && body?.data?.summary !== undefined && body.data.summary.fail === 0) {
    pass(
      `abap validate:aff: ${body.data.summary.pass} file(s) pass, ` +
        `${body.data.summary.warn} warn, ${body.data.summary.fail} fail`,
    );
  } else {
    const details =
      body?.error?.message ?? body?.data?.files?.filter((file) => file.status === 'fail') ?? raw;
    fail(`abap validate:aff failed: ${JSON.stringify(details).slice(0, 2000)}`);
  }

  // -------------------------------------------------------------------------
  // 3. Offline local content check (`abap check content`, no SAP round-trip)
  // -------------------------------------------------------------------------
  const abapFiles = sapAbapFiles;
  const content = runAbap(['check', 'content', ...abapFiles, '--json']);
  let contentBody;
  try {
    contentBody = JSON.parse(content.stdout);
  } catch {
    contentBody = undefined;
  }
  if (content.status === 0 && contentBody?.status === 'success') {
    pass(`abap check content: ${abapFiles.length} local ABAP file(s) structurally valid`);
  } else {
    fail(
      `abap check content failed: ${JSON.stringify(
        contentBody?.error ?? `${content.stdout}${content.stderr}`,
      ).slice(0, 2000)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Optional online syntax check (test system only, never in CI)
// ---------------------------------------------------------------------------
const onlineRequested = process.env.SA_SAP_CHECK_ONLINE === '1';
const workspaceConfig = ['sap/.abap.json', '.abap.json'].find((file) =>
  existsSync(resolve(ROOT, file)),
);
if (!onlineRequested) {
  warn(
    'abap check syntax skipped: no SAP system required for CI (set SA_SAP_CHECK_ONLINE=1 ' +
      'with a bound test system to enable it)',
  );
} else if (!hasBinary('abap')) {
  warn('abap check syntax skipped: abap-cli not found');
} else if (workspaceConfig === undefined) {
  warn('abap check syntax skipped: no .abap.json workspace config bound to a test system');
} else if (!existsSync(resolve(ROOT, 'sap/src'))) {
  warn('abap check syntax skipped: sap/src not found');
} else {
  const syntax = runAbap(['check', 'syntax', ...sapAbapFiles, '--json']);
  if (syntax.status === 0) {
    pass(
      `abap check syntax: ${sapAbapFiles.length} local ABAP file(s) passed on the bound test system`,
    );
  } else {
    fail(
      `abap check syntax failed: ${`${syntax.stdout ?? ''}${syntax.stderr ?? ''}`.slice(0, 2000)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = checks.filter((check) => check.status === 'pass').length;
console.log(
  `\nsap:check summary: ${passed} check(s) passed, ${warnings.length} skipped, ${failures.length} failed`,
);
if (failures.length > 0) {
  console.error('sap:check FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  onlineRequested
    ? 'sap:check OK (offline checks + online syntax check on the bound test system)'
    : 'sap:check OK (offline; no SAP system contacted)',
);
