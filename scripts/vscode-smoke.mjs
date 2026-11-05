#!/usr/bin/env node
// Root `pnpm vscode:smoke` (task-1 deliverable 2, v1.0 release gate).
//
// End-to-end smoke against a REAL VSCode Extension Host (not a mock):
//   1. build the extension's single-file bundle (same artifact the VSIX ships);
//   2. boot a real M1 local control plane on a free port with a temp state dir
//      (never 3080 — that port belongs to the DSH Web GUI on this machine);
//   3. create a demand + wait for its G1 approval, and a vscode dev task bound
//      to a temp workspace, through the control-plane HTTP API;
//   4. stage the extension + a test-only UI wrapper (the runner cannot patch the
//      extension's `vscode` API object: the host creates one API instance per
//      extension) and launch the real host with:
//      `Code --extensionDevelopmentPath=<staged> --extensionTestsPath=<runner>`
//      plus throwaway user-data/extensions dirs and the temp workspace;
//   5. the runner activates the extension and drives the REAL commands:
//      任务箱 → claim → context pack → 审批动作 (the wrapper answers the
//      prompt-only UI deterministically; the bundle under test is byte-identical
//      to the shipped one);
//   6. assert over HTTP + filesystem (claim, context.md, approval decision,
//      event log), clean up processes/temp dirs and exit 0 with evidence lines.
//
// CI does not run this (it needs a desktop VSCode install). Local release gate:
//   pnpm vscode:smoke
// macOS default binary: /Applications/Visual Studio Code.app/.../Code
// Override with SAP_SUPERAGENT_VSCODE_BIN=/path/to/Code.
// Debug: SAP_SUPERAGENT_SMOKE_KEEP=1 keeps the temp run dir (logs/state/workspace).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const extensionDir = path.join(root, 'packages', 'clients', 'vscode');
const KEEP = process.env.SAP_SUPERAGENT_SMOKE_KEEP === '1';
const HOST_TIMEOUT_MS = Number(process.env.SAP_SUPERAGENT_SMOKE_TIMEOUT_MS ?? 240_000);
const CONTROL_PLANE_TIMEOUT_MS = 120_000;
const SMOKE_REPO = 'z-smoke';
const SMOKE_PROJECT = 'SMOKE';

function log(message) {
  console.log(`[vscode-smoke] ${message}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  throw new Error(
    `timeout after ${timeoutMs}ms waiting for ${label}${lastError === undefined ? '' : `: ${lastError.message}`}`,
  );
}

function resolveVSCodeBinary() {
  const explicit = process.env.SAP_SUPERAGENT_VSCODE_BIN?.trim();
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) {
      throw new Error(`SAP_SUPERAGENT_VSCODE_BIN does not exist: ${explicit}`);
    }
    return explicit;
  }
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code',
    );
  } else if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    );
  } else {
    candidates.push('/usr/share/code/code', '/usr/bin/code', '/snap/bin/code');
  }
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'VSCode desktop binary not found. Install VSCode or set SAP_SUPERAGENT_VSCODE_BIN=/path/to/Code ' +
      '(the smoke test needs a real Extension Host; CI does not run it).',
  );
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (port === 0) {
    throw new Error('could not allocate a free TCP port');
  }
  return port;
}

async function api(baseUrl, pathname, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

async function expectOk(label, promise, allowedStatuses = [200]) {
  const response = await promise;
  if (!allowedStatuses.includes(response.status)) {
    throw new Error(
      `${label} failed: HTTP ${response.status} ${response.text.slice(0, 300)}`,
    );
  }
  return response;
}

/** Rebuild the exact bundle the VSIX ships (esbuild single file, vscode external). */
function buildBundle() {
  const script = path.join(root, 'scripts', 'vsix-package.mjs');
  const result = spawnSync(process.execPath, [script, '--bundle-only'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    throw new Error(`failed to run the bundle step: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`bundle step exited with code ${String(result.status)}`);
  }
  const bundlePath = path.join(extensionDir, 'dist', 'extension.cjs');
  if (!existsSync(bundlePath)) {
    throw new Error(`bundle not found after build: ${bundlePath}`);
  }
  return bundlePath;
}

/**
 * Stage the extension under test: same manifest (name/publisher/contributes) and
 * the same bundle, with `main` pointing at a wrapper that stubs only the
 * prompt-only UI (showQuickPick/showInputBox/…) and captures the task-inbox tree
 * data provider. Each extension gets its own `vscode` API object, so the runner
 * cannot apply that stub to the extension directly; the wrapper is loaded by the
 * host as part of the extension and requires the real bundle unchanged.
 */
async function stageExtensionUnderTest(bundlePath, stagedDir) {
  await mkdir(path.join(stagedDir, 'dist'), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
  const stagedManifest = { ...manifest, main: './smoke-wrapper.cjs' };
  await writeFile(
    path.join(stagedDir, 'package.json'),
    `${JSON.stringify(stagedManifest, null, 2)}\n`,
  );
  await cp(bundlePath, path.join(stagedDir, 'dist', 'extension.cjs'));
  await writeFile(path.join(stagedDir, 'smoke-wrapper.cjs'), WRAPPER_SOURCE);
}

/** Spawn `sap-superagent dev` (real M1 control plane) and parse URL + tokens. */
function startControlPlane(port, stateDir) {
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliEntry = path.join(root, 'packages', 'cli', 'src', 'cli.ts');
  const child = spawn(
    process.execPath,
    [tsxCli, cliEntry, 'dev', '--port', String(port), '--host', '127.0.0.1', '--state-dir', stateDir],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const handle = { child, url: null, userToken: null, adminToken: null, output: () => output };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`control plane did not start in ${CONTROL_PLANE_TIMEOUT_MS}ms:\n${output.slice(-1500)}`));
    }, CONTROL_PLANE_TIMEOUT_MS);
    const onData = (chunk) => {
      output += chunk.toString();
      if (handle.url === null) {
        const match = output.match(/control plane: (https?:\/\/\S+)/);
        if (match !== null) handle.url = match[1];
      }
      if (handle.userToken === null) {
        const match = output.match(/^\s*user\s+\(([^)]+)\)\s+(\S+)\s*$/m);
        if (match !== null) handle.userToken = match[2];
      }
      if (handle.adminToken === null) {
        const match = output.match(/^\s*admin\s+\(([^)]+)\)\s+(\S+)\s*$/m);
        if (match !== null) handle.adminToken = match[2];
      }
      if (handle.url !== null && handle.userToken !== null && handle.adminToken !== null) {
        finish(handle);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn control plane: ${error.message}`));
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`control plane exited before becoming ready (code ${String(code)}):\n${output.slice(-1500)}`),
      );
    });
  });
}

async function stopChild(child, label) {
  if (child === null || child === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([exited.then(() => false), wait(10_000).then(() => true)]);
  if (timedOut) {
    log(`${label} did not exit after SIGTERM; sending SIGKILL`);
    child.kill('SIGKILL');
    await Promise.race([exited, wait(5_000)]);
  }
}

/** Launch the real Extension Host and collect its stdout/stderr. */
function runExtensionHost({ binary, extensionPath, runnerPath, userDataDir, extensionsDir, workspaceDir, env, logPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        `--extensionDevelopmentPath=${extensionPath}`,
        `--extensionTestsPath=${runnerPath}`,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-workspace-trust',
        workspaceDir,
      ],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const logStream = createWriteStream(logPath, { flags: 'w' });
    let output = '';
    let pending = '';
    let settled = false;
    let timedOut = false;
    const append = (chunk) => {
      const text = chunk.toString();
      output += text;
      logStream.write(text);
      // Surface only runner evidence lines; the rest stays in the log file.
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('[vscode-smoke]')) console.log(line);
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      log(`extension host did not exit within ${HOST_TIMEOUT_MS}ms; killing it`);
      child.kill('SIGKILL');
    }, HOST_TIMEOUT_MS);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to launch VSCode Extension Host: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logStream.end();
      resolve({ code, signal, output, timedOut, child });
    });
  });
}

/**
 * Test-only wrapper loaded by the extension host as the extension entrypoint.
 * It is NOT part of the VSIX: the smoke test stages it next to the unchanged
 * bundle. It stubs the prompt-only UI and exposes the captured inbox provider on
 * `globalThis` for the runner (same process).
 */
const WRAPPER_SOURCE = `'use strict';
// Generated by scripts/vscode-smoke.mjs — test-only extension entrypoint.
const vscode = require('vscode');

const state = {
  provider: null,
  viewId: null,
  createTreeViewCalls: 0,
  warnings: [],
  errors: [],
  messages: [],
};
globalThis.__sapSuperAgentSmoke = state;

const window = vscode.window;
window.showQuickPick = async (items) => (Array.isArray(items) ? items[0] : undefined);
window.showInputBox = async () => '';
window.showWarningMessage = async (message) => {
  state.warnings.push(String(message));
  return undefined;
};
window.showErrorMessage = async (message) => {
  state.errors.push(String(message));
  return undefined;
};
window.showInformationMessage = async (message) => {
  state.messages.push(String(message));
  return undefined;
};
const originalCreateTreeView = window.createTreeView.bind(window);
window.createTreeView = (id, options) => {
  state.createTreeViewCalls += 1;
  state.viewId = id;
  state.provider = options && options.treeDataProvider ? options.treeDataProvider : null;
  return originalCreateTreeView(id, options);
};

const realExtension = require('./dist/extension.cjs');
exports.activate = realExtension.activate;
exports.deactivate = realExtension.deactivate;
`;

/** The runner executed inside the extension host (CommonJS, exports.run). */
const RUNNER_SOURCE = `'use strict';
// Generated by scripts/vscode-smoke.mjs — runs in the real VS Code Extension Host.
// Activates the extension, then drives the real commands: task inbox → claim →
// context pack → approval decision. Server state is re-asserted by the parent.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const RESULT_PATH = process.env.SMOKE_RESULT;
const URL = process.env.SMOKE_URL;
const TOKEN = process.env.SAP_SUPERAGENT_TOKEN;
const TASK = JSON.parse(process.env.SMOKE_TASK_JSON);
const APPROVAL = JSON.parse(process.env.SMOKE_APPROVAL_JSON);
const WORKSPACE = process.env.SMOKE_WORKSPACE;

const result = {
  ok: false,
  vscodeVersion: vscode.version,
  steps: {},
  evidence: {},
  warnings: [],
  errors: [],
  error: null,
};

function save() {
  try {
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[vscode-smoke] could not write runner result: ' + error.message);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, probe, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error('timeout waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
}

async function getJson(pathname) {
  const response = await fetch(URL + pathname, {
    headers: { authorization: 'Bearer ' + TOKEN },
  });
  if (!response.ok) throw new Error('GET ' + pathname + ' -> HTTP ' + response.status);
  return response.json();
}

exports.run = async () => {
  try {
    const configuration = vscode.workspace.getConfiguration('sapSuperAgent');
    await configuration.update('controlPlaneUrl', URL, vscode.ConfigurationTarget.Global);
    await configuration.update('accepting', true, vscode.ConfigurationTarget.Global);
    result.steps.configured = true;

    const extension = vscode.extensions.all.find(
      (entry) => entry.packageJSON && entry.packageJSON.name === 'sap-superagent-vscode',
    );
    if (extension === undefined) throw new Error('sap-superagent-vscode is not loaded in the extension host');
    result.evidence.extensionId = extension.id;
    result.evidence.extensionVersion = extension.packageJSON.version;
    await extension.activate();
    result.steps.activated = true;

    const wrapper = globalThis.__sapSuperAgentSmoke;
    if (wrapper === undefined) throw new Error('smoke wrapper did not run in the extension host');
    const provider = wrapper.provider;
    if (provider === null) throw new Error('activation did not create the task inbox tree view');
    result.evidence.inboxViewId = wrapper.viewId;

    // 1) 任务箱: executor registered + bound task listed under 可领取.
    const availableTask = await waitFor(
      'task in 可领取',
      () => provider.currentData.available.find((task) => task.id === TASK.id),
      30000,
      250,
    );
    result.steps.inbox = true;
    const snapshot = provider.currentData;
    result.evidence.inbox = {
      available: snapshot.available.map((task) => task.id),
      mine: snapshot.mine.map((task) => task.id),
      waiting: snapshot.waiting.length,
    };

    // 2) 等待我回答: the pending G1 gate is listed before the decision.
    const waitingGate = snapshot.waiting.find(
      (item) => item.kind === 'approval' && item.approval.id === APPROVAL.id,
    );
    if (waitingGate === undefined) throw new Error('pending approval is not listed under 等待我回答');
    result.steps.inboxApproval = true;

    // 3) claim via the real command (direct task argument skips the quick pick).
    await vscode.commands.executeCommand('sapSuperAgent.claimTask', availableTask);
    const mineTask = await waitFor(
      'task in 我的任务',
      () => provider.currentData.mine.find((task) => task.id === TASK.id),
      15000,
      200,
    );
    result.steps.claimed = true;
    result.evidence.claimed = { taskId: mineTask.id, state: mineTask.state };

    // 4) context pack on disk (written by the open-task path of the claim command).
    const contextPath = path.join(WORKSPACE, '.sap-superagent', 'task', TASK.id, 'context.md');
    const contextText = await waitFor(
      'context pack',
      () => {
        try {
          return fs.readFileSync(contextPath, 'utf8');
        } catch {
          return undefined;
        }
      },
      15000,
      200,
    );
    if (!contextText.includes(TASK.title)) throw new Error('context.md does not mention the task title');
    result.steps.contextPack = true;
    result.evidence.contextPack = { path: contextPath, bytes: Buffer.byteLength(contextText, 'utf8') };

    // 5) approval action via the real command (wrapper answers 通过 + empty comment).
    await vscode.commands.executeCommand('sapSuperAgent.approvalAction', APPROVAL);
    const approved = await waitFor(
      'approval decided',
      async () => {
        const body = await getJson('/api/v1/approvals?state=approved');
        return (body.approvals || []).find((approval) => approval.id === APPROVAL.id);
      },
      20000,
      250,
    );
    if (approved.state !== 'approved') throw new Error('approval is ' + approved.state + ', expected approved');
    result.steps.approvalDecided = true;
    result.evidence.approval = {
      id: approved.id,
      gateKey: approved.gateKey,
      state: approved.state,
      decidedBy: approved.decidedBy,
    };

    result.warnings = wrapper.warnings.slice();
    result.errors = wrapper.errors.slice();
    result.evidence.uiMessages = wrapper.messages.slice(0, 10);
    result.ok = true;
    console.log(
      '[vscode-smoke] runner OK: inbox=' + JSON.stringify(result.evidence.inbox) +
        ' claim=' + TASK.id +
        ' context=' + result.evidence.contextPack.bytes + 'B' +
        ' approval=' + APPROVAL.id + ':approved',
    );
  } catch (error) {
    const wrapper = globalThis.__sapSuperAgentSmoke;
    if (wrapper !== undefined) {
      result.warnings = wrapper.warnings.slice();
      result.errors = wrapper.errors.slice();
    }
    result.error = error && error.stack ? error.stack : String(error);
    console.log('[vscode-smoke] runner FAIL: ' + (error && error.message ? error.message : error));
  } finally {
    save();
  }
  if (!result.ok) throw new Error(result.error || 'smoke runner failed');
};
`;

async function main() {
  const binary = resolveVSCodeBinary();
  log(`VSCode binary: ${binary}`);
  const bundlePath = buildBundle();
  const runDir = path.join(root, 'tmp', 'vscode-smoke', `run-${Date.now()}-${process.pid}`);
  const stateDir = path.join(runDir, 'state');
  const workspaceDir = path.join(runDir, 'workspace');
  const userDataDir = path.join(runDir, 'user-data');
  const extensionsDir = path.join(runDir, 'extensions');
  const stagedExtensionDir = path.join(runDir, 'extension-under-test');
  const runnerPath = path.join(runDir, 'smoke-runner.cjs');
  const resultPath = path.join(runDir, 'runner-result.json');
  const hostLogPath = path.join(runDir, 'extension-host.log');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(workspaceDir, '.sap-superagent'), { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  await mkdir(extensionsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, '.sap-superagent', 'workspace.json'),
    `${JSON.stringify({ repo: SMOKE_REPO, projectKey: SMOKE_PROJECT, baseBranch: 'main' }, null, 2)}\n`,
  );
  await stageExtensionUnderTest(bundlePath, stagedExtensionDir);
  await writeFile(runnerPath, RUNNER_SOURCE);

  const port = await freePort();
  log(`free port: ${port} (3080 is the DSH Web GUI; never reused here)`);
  const plane = await startControlPlane(port, stateDir);
  log(`control plane: ${plane.url} (temp state dir)`);
  let hostResult;
  try {
    await expectOk('healthz', api(plane.url, '/api/v1/healthz'));
    const demandResponse = await expectOk(
      'create demand',
      api(plane.url, '/api/v1/demands', {
        method: 'POST',
        token: plane.userToken,
        body: {
          title: `VSIX smoke 需求 ${Date.now()}`,
          description: 'v1.0 VSIX / Extension Host 发布 gate 冒烟（临时数据，跑完即删）。',
          acceptanceCriteria: ['任务箱能领取任务', '上下文包写入临时工作区'],
          priority: 'normal',
          requester: { userId: 'SMOKE001', orgUnit: 'QA' },
        },
      }),
    );
    const demand = demandResponse.body.demand;
    log(`demand: ${demand.id}`);
    const approval = await waitFor(
      'G1 pending approval',
      async () => {
        const detail = await api(plane.url, `/api/v1/demands/${demand.id}`, { token: plane.userToken });
        return detail.body?.approvals?.find((entry) => entry.gateKey === 'G1' && entry.state === 'pending');
      },
      30_000,
    );
    log(`approval: ${approval.id} (${approval.gateKey}, ${approval.requiredRole}) pending`);
    const taskResponse = await expectOk(
      'create dev task',
      api(plane.url, '/api/v1/admin/tasks', {
        method: 'POST',
        token: plane.adminToken,
        body: {
          demandId: demand.id,
          title: `VSIX smoke 实现任务 ${Date.now()}`,
          executorKind: 'vscode',
          requiredRoles: ['developer'],
          workspaceBinding: { repo: SMOKE_REPO, projectKey: SMOKE_PROJECT, baseBranch: 'main' },
        },
      }),
      [200, 201],
    );
    const task = taskResponse.body.task;
    log(`task: ${task.id} (bound to ${SMOKE_REPO}/${SMOKE_PROJECT})`);

    const hostEnv = { ...process.env };
    // The shell globally exports ELECTRON_RUN_AS_NODE=1; the real VSCode binary
    // must not see it (otherwise it starts as plain Node). Also drop Node
    // injection so the extension host starts with its own loader settings.
    delete hostEnv.ELECTRON_RUN_AS_NODE;
    delete hostEnv.NODE_OPTIONS;
    delete hostEnv.VSCODE_NODE_OPTIONS;
    hostEnv.SAP_SUPERAGENT_TOKEN = plane.userToken;
    hostEnv.SMOKE_URL = plane.url;
    hostEnv.SMOKE_TASK_JSON = JSON.stringify(task);
    hostEnv.SMOKE_APPROVAL_JSON = JSON.stringify(approval);
    hostEnv.SMOKE_WORKSPACE = workspaceDir;
    hostEnv.SMOKE_RESULT = resultPath;

    hostResult = await runExtensionHost({
      binary,
      extensionPath: stagedExtensionDir,
      runnerPath,
      userDataDir,
      extensionsDir,
      workspaceDir,
      env: hostEnv,
      logPath: hostLogPath,
    });
    log(`extension host exited: code=${String(hostResult.code)} signal=${String(hostResult.signal)}`);
    if (hostResult.timedOut) {
      throw new Error(`extension host did not exit within ${HOST_TIMEOUT_MS}ms`);
    }
    let runner;
    try {
      runner = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch {
      throw new Error(
        `extension host produced no runner result; last log lines:\n${hostResult.output.slice(-2500)}`,
      );
    }
    if (!runner.ok) {
      throw new Error(`in-host smoke failed: ${runner.error}\n${hostResult.output.slice(-1500)}`);
    }
    if (hostResult.code !== 0) {
      throw new Error(`extension host exited with code ${String(hostResult.code)}`);
    }
    for (const step of [
      'configured',
      'activated',
      'inbox',
      'inboxApproval',
      'claimed',
      'contextPack',
      'approvalDecided',
    ]) {
      if (runner.steps[step] !== true) {
        throw new Error(`runner step not confirmed: ${step}`);
      }
    }

    // --- Parent-side re-assertions (server state + filesystem) -------------
    const contextPath = runner.evidence.contextPack.path;
    const contextStats = await stat(contextPath);
    const contextText = await readFile(contextPath, 'utf8');
    if (!contextText.includes(task.title)) {
      throw new Error('context.md on disk does not contain the task title');
    }

    const detail = await expectOk(
      'demand detail after approval',
      api(plane.url, `/api/v1/demands/${demand.id}`, { token: plane.adminToken }),
    );
    const decided = detail.body.approvals.find((entry) => entry.id === approval.id);
    if (decided === undefined || decided.state !== 'approved') {
      throw new Error(`approval ${approval.id} is not approved on the control plane`);
    }

    const events = await expectOk(
      'event log',
      api(plane.url, '/api/v1/events?after=0&limit=1000', { token: plane.adminToken }),
    );
    const eventTypes = events.body.events.map((event) => event.type);
    const seqOf = (type) => events.body.events.find((event) => event.type === type)?.seq;
    for (const required of ['executor.registered', 'task.claimed', 'approval.decided']) {
      if (!eventTypes.includes(required)) {
        throw new Error(`event log is missing ${required}`);
      }
    }
    const taskDetail = await expectOk(
      'task detail',
      api(plane.url, `/api/v1/tasks/${task.id}`, { token: plane.adminToken }),
    );

    const authWarnings = runner.warnings.filter((warning) =>
      /401|403|unauthorized|forbidden|token/i.test(warning),
    );
    if (authWarnings.length > 0) {
      throw new Error(`extension reported auth warnings: ${authWarnings.join(' | ')}`);
    }
    if (runner.errors.length > 0) {
      throw new Error(`extension reported errors: ${runner.errors.join(' | ')}`);
    }

    log(`extension activated: ${runner.evidence.extensionId} v${runner.evidence.extensionVersion}`);
    log(
      `任务箱: available=[${runner.evidence.inbox.available.join(',')}] waiting=${runner.evidence.inbox.waiting} ` +
        `(view ${runner.evidence.inboxViewId})`,
    );
    log(`claim: task ${task.id} → claimed (mine=${runner.evidence.claimed.state})`);
    log(`context pack: ${path.relative(root, contextPath)} (${contextStats.size} bytes)`);
    log(
      `approval: ${approval.id} ${approval.gateKey} → ${decided.state} (decidedBy=${String(decided.decidedBy)})`,
    );
    log(
      `events: executor.registered@${String(seqOf('executor.registered'))} ` +
        `task.claimed@${String(seqOf('task.claimed'))} approval.decided@${String(seqOf('approval.decided'))}`,
    );
    // Graceful host shutdown unregisters the executor, which releases the lease
    // and puts the task back in the pool; the claim itself is proven by the
    // `task.claimed` event above (and the runner's 我的任务 assertion).
    if (!['pending', 'claimed'].includes(taskDetail.body.task.state)) {
      throw new Error(`unexpected task state after host exit: ${taskDetail.body.task.state}`);
    }
    log(
      `server task state after host exit: ${taskDetail.body.task.state} ` +
        '(unregister released the lease; claim proven by task.claimed event)',
    );
    if (runner.warnings.length > 0) {
      log(`runner warnings (non-blocking): ${runner.warnings.slice(0, 5).join(' | ')}`);
    }
    log('server-side assertions: claim + context.md + approval decision ✓');
  } finally {
    await stopChild(hostResult?.child, 'extension host');
    await stopChild(plane.child, 'control plane');
    if (KEEP) {
      log(`KEEP=1: run dir retained at ${path.relative(root, runDir)}`);
    } else {
      await rm(runDir, { recursive: true, force: true });
      log('cleanup: temp dirs, state dir and VSCode profile removed');
    }
  }
  log('PASS');
}

main().catch((error) => {
  log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
