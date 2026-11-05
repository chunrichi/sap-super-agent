// Commander program factory. Kept separate from the bin entry so tests can
// inspect commands/options without executing anything.
import { Command } from 'commander';
import type { PortCheckResult } from './commands/doctor.js';
import { diagnose, printDoctorReport, runDoctor } from './commands/doctor.js';
import { runDev } from './commands/dev.js';
import { runInit } from './commands/init.js';
import { runToken } from './commands/token.js';
import { CliError } from './lib/errors.js';
import { consoleIo, type CliIo } from './lib/io.js';

export const CLI_NAME = 'sap-superagent';
export const CLI_VERSION = '1.0.0';

export interface ProgramDeps {
  io?: CliIo;
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
}

interface InitCliOptions {
  repo?: string;
  projectKey?: string;
  baseBranch: string;
  prepare?: string;
  force?: boolean;
}

interface DevCliOptions {
  port?: string;
  stateDir?: string;
  host?: string;
}

interface TokenCliOptions {
  kind: string;
  user: string;
  stateDir?: string;
  ttl: string;
}

interface DoctorCliOptions {
  port?: string;
  stateDir?: string;
  json?: boolean;
}

export function createProgram(deps: ProgramDeps = {}): Command {
  const io = deps.io ?? consoleIo;
  const cwd = deps.cwd ?? (() => process.cwd());
  const env = deps.env ?? process.env;

  const program = new Command();
  program
    .name(CLI_NAME)
    .description('SAP Super Agent 本地控制平面 CLI（M1：init / dev / token / doctor）')
    .version(CLI_VERSION)
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => {
        io.out(text.replace(/\n$/, ''));
      },
      writeErr: (text) => {
        io.err(text.replace(/\n$/, ''));
      },
    })
    // Throw on parse errors instead of calling process.exit, so `runCli` owns
    // the exit code (and tests can build the program safely).
    .exitOverride();

  program
    .command('init')
    .description('写入 .sap-superagent/workspace.json 与状态目录')
    .option('--repo <repo>', '仓库名（写入 workspace.json）')
    .option('--project-key <key>', '项目 key')
    .option('--base-branch <branch>', '基线分支', 'main')
    .option('--prepare <cmd>', '准备命令（如 pnpm install）')
    .option('--force', '覆盖已存在的 workspace.json')
    .action(async (options: InitCliOptions) => {
      await runInit({
        cwd: cwd(),
        io,
        repo: options.repo,
        projectKey: options.projectKey,
        baseBranch: options.baseBranch,
        prepare: options.prepare,
        force: options.force === true,
      });
    });

  program
    .command('dev')
    .description('启动 M1 本地控制平面（打印 URL 与 dev token）')
    .option('--port <port>', 'HTTP 端口（默认 SA_HTTP_PORT 或 3080）')
    .option('--state-dir <dir>', '状态目录（默认 .sap-superagent/state）')
    .option('--host <host>', '监听地址（默认 127.0.0.1）')
    .action(async (options: DevCliOptions) => {
      await runDev({
        cwd: cwd(),
        env,
        io,
        port: options.port,
        stateDir: options.stateDir,
        host: options.host,
      });
    });

  program
    .command('token')
    .description('签发本地 token（user / admin / executor）')
    .option('--kind <kind>', 'user | admin | executor', 'user')
    .option('--user <id>', 'token 主体（sub）', 'dev')
    .option('--state-dir <dir>', '状态目录（默认 .sap-superagent/state）')
    .option('--ttl <duration>', '有效期（如 30m、24h、7d）', '24h')
    .action((options: TokenCliOptions) => {
      runToken({
        cwd: cwd(),
        env,
        io,
        kind: options.kind,
        user: options.user,
        stateDir: options.stateDir,
        ttl: options.ttl,
      });
    });

  program
    .command('doctor')
    .description('环境自检（Node / pnpm / 端口 / 状态目录 / 模板 / AI 配置）')
    .option('--port <port>', '要检查的端口（默认 SA_HTTP_PORT 或 3080）')
    .option('--state-dir <dir>', '要检查的状态目录')
    .option('--json', '以 JSON 输出检查结果')
    .action(async (options: DoctorCliOptions) => {
      const exitCode = await runDoctor({
        cwd: cwd(),
        env,
        io,
        port: options.port,
        stateDir: options.stateDir,
        json: options.json === true,
      });
      if (exitCode !== 0) {
        // The report is already printed; only the exit code remains.
        throw new CliError('', exitCode);
      }
    });

  return program;
}

/** Re-exported for programmatic callers (e2e, tests) that want the raw pieces. */
export { diagnose, printDoctorReport, runDoctor, runDev, runInit, runToken };
export type { PortCheckResult };
