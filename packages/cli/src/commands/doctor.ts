// `sap-superagent doctor` — environment preflight, no server required (H0 §1.6).
// Checks are deliberately dependency-free and offline: they must work before
// `pnpm install`, on a fresh machine.
import { execFileSync } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { BYOK_REQUIRED_VARS, FAKE_PROVIDER, describeAiConfig } from '../lib/ai-config.js';
import { NODE_REQUIREMENT, satisfiesNodeRequirement } from '../lib/node-version.js';
import type { CliIo } from '../lib/io.js';
import { findTemplatesDir, resolvePort, resolveStateDir } from '../lib/paths.js';

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  nodeVersion: string;
  checks: DoctorCheck[];
}

export interface PortCheckResult {
  ok: boolean;
  detail: string;
}

export interface DoctorOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  port?: string | number | undefined;
  stateDir?: string | undefined;
  json?: boolean | undefined;
  /** Injectable for tests. */
  nodeVersion?: string | undefined;
  checkPnpm?: (() => Promise<{ ok: boolean; detail: string }>) | undefined;
  checkPort?: ((port: number, host: string) => Promise<PortCheckResult>) | undefined;
  checkStateDir?: ((dir: string) => Promise<{ ok: boolean; detail: string; hint?: string }>) | undefined;
  findTemplates?: ((startDir: string) => string | undefined) | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pnpmVersion(): { ok: boolean; detail: string } {
  try {
    const output = execFileSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    return output === ''
      ? { ok: false, detail: 'pnpm --version 输出为空' }
      : { ok: true, detail: `pnpm ${output}` };
  } catch (error) {
    return { ok: false, detail: `无法执行 pnpm --version：${errorMessage(error)}` };
  }
}

/** Try to bind the port once and release it; no traffic, no privileged default. */
export async function isPortFree(port: number, host = '127.0.0.1'): Promise<PortCheckResult> {
  if (port === 0) {
    return { ok: true, detail: '端口 0（由操作系统分配，不检查占用）' };
  }
  return new Promise<PortCheckResult>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        detail:
          error.code === 'EADDRINUSE'
            ? `端口 ${port} 已被占用（另一个 sap-superagent dev？）`
            : `端口 ${port} 不可用：${error.message}`,
      });
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => {
        resolve({ ok: true, detail: `端口 ${port} 可用` });
      });
    });
  });
}

export async function isStateDirWritable(
  dir: string,
): Promise<{ ok: boolean; detail: string; hint?: string }> {
  const probe = path.join(dir, `.doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe);
    return { ok: true, detail: `${dir} 可写` };
  } catch (error) {
    return {
      ok: false,
      detail: `${dir} 不可写：${errorMessage(error)}`,
      hint: '检查目录权限，或用 --state-dir 指向可写目录（默认 .sap-superagent/state）。',
    };
  }
}

export async function diagnose(options: DoctorOptions): Promise<DoctorReport> {
  const { cwd, env } = options;
  const checks: DoctorCheck[] = [];

  const version = options.nodeVersion ?? process.version;
  const nodeOk = satisfiesNodeRequirement(version);
  checks.push({
    id: 'node',
    label: 'Node 版本',
    ok: nodeOk,
    detail: `Node ${version}（要求 ${NODE_REQUIREMENT}）`,
    ...(nodeOk ? {} : { hint: '用 .nvmrc 切到 Node 24（corepack enable && pnpm install）。' }),
  });

  const pnpm = options.checkPnpm === undefined ? pnpmVersion() : await options.checkPnpm();
  checks.push({
    id: 'pnpm',
    label: 'pnpm 可用',
    ok: pnpm.ok,
    detail: pnpm.detail,
    ...(pnpm.ok ? {} : { hint: 'corepack enable && pnpm install。' }),
  });

  let port: number;
  try {
    port = resolvePort(env, options.port);
  } catch (error) {
    checks.push({
      id: 'port',
      label: '端口',
      ok: false,
      detail: errorMessage(error),
      hint: '用 --port 或 SA_HTTP_PORT 指定 0–65535 的端口。',
    });
    port = 0;
  }
  if (port !== 0) {
    const checkPort = options.checkPort ?? isPortFree;
    const result = await checkPort(port, '127.0.0.1');
    checks.push({
      id: 'port',
      label: '端口可用',
      ok: result.ok,
      detail: result.detail,
      ...(result.ok ? {} : { hint: '停掉占用进程，或用 sap-superagent dev --port <other> 换端口。' }),
    });
  }

  const stateDir = resolveStateDir(cwd, env, options.stateDir);
  const checkStateDir = options.checkStateDir ?? isStateDirWritable;
  const stateResult = await checkStateDir(stateDir);
  checks.push({
    id: 'state-dir',
    label: '状态目录可写',
    ok: stateResult.ok,
    detail: stateResult.detail,
    ...(stateResult.hint === undefined ? {} : { hint: stateResult.hint }),
  });

  const findTemplates = options.findTemplates ?? findTemplatesDir;
  const templatesDir = findTemplates(cwd);
  checks.push({
    id: 'templates',
    label: '阶段模板',
    ok: templatesDir !== undefined,
    detail: templatesDir ?? '找不到 templates/default.yaml',
    ...(templatesDir === undefined
      ? { hint: '在仓库根目录运行 doctor（需要 templates/default.yaml）。' }
      : {}),
  });

  const ai = describeAiConfig(env);
  const aiDetail =
    ai.provider === FAKE_PROVIDER
      ? 'SA_AI_PROVIDER=fake（离线，无需 Key）'
      : ai.ok
        ? `SA_AI_PROVIDER=${ai.provider}（${BYOK_REQUIRED_VARS.join(' / ')} 已配置）`
        : `SA_AI_PROVIDER=${ai.provider}，缺少 ${ai.missing.join(' / ')}`;
  checks.push({
    id: 'ai',
    label: 'AI 配置',
    ok: ai.ok,
    detail: aiDetail,
    ...(ai.ok ? {} : { hint: '在 .env 补齐 BYOK 变量，或设置 SA_AI_PROVIDER=fake 使用离线模式。' }),
  });

  return {
    ok: checks.every((check) => check.ok),
    nodeVersion: version,
    checks,
  };
}

export function printDoctorReport(report: DoctorReport, io: CliIo): void {
  for (const check of report.checks) {
    io.out(`${check.ok ? '✓' : '✗'} ${check.label}: ${check.detail}`);
    if (!check.ok && check.hint !== undefined) {
      io.out(`   → ${check.hint}`);
    }
  }
  const failed = report.checks.filter((check) => !check.ok).length;
  io.out('');
  io.out(
    failed === 0
      ? `doctor: ${report.checks.length} 项全部通过。`
      : `doctor: ${failed} 项失败，按上面的提示修复后重跑 sap-superagent doctor。`,
  );
}

/** Run every check, print (human or JSON), return the process exit code. */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const report = await diagnose(options);
  if (options.json === true) {
    options.io.out(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report, options.io);
  }
  return report.ok ? 0 : 1;
}
