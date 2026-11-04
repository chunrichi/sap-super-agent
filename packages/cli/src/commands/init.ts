// `sap-superagent init` — write `.sap-superagent/workspace.json` (H0 §1.6).
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { envFilePath, findEnvExample, workspaceDir } from '../lib/paths.js';
import { CliError } from '../lib/errors.js';
import type { CliIo } from '../lib/io.js';
import { writeWorkspaceConfig } from '../lib/workspace-config.js';

export interface InitOptions {
  cwd: string;
  repo?: string | undefined;
  projectKey?: string | undefined;
  baseBranch?: string | undefined;
  prepare?: string | undefined;
  force?: boolean | undefined;
  io: CliIo;
}

export interface InitResult {
  filePath: string;
  /** `.sap-superagent/state`, created so `dev` starts from a clean directory. */
  stateDir: string;
  overwritten: boolean;
  envFilePresent: boolean;
  envExamplePath: string | undefined;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const { cwd, io } = options;
  const written = await writeWorkspaceConfig(
    cwd,
    {
      repo: options.repo,
      projectKey: options.projectKey,
      baseBranch: options.baseBranch,
      prepare: options.prepare,
    },
    { force: options.force === true },
  );

  const stateDir = `${workspaceDir(cwd)}/state`;
  await mkdir(stateDir, { recursive: true });
  await mkdir(workspaceDir(cwd), { recursive: true });

  const envExamplePath = findEnvExample(cwd);
  const envFilePresent = existsSync(envFilePath(cwd));

  if (written.overwritten) {
    io.out(`已覆盖 ${written.filePath}`);
  } else {
    io.out(`已写入 ${written.filePath}`);
  }
  io.out(`状态目录：${stateDir}`);
  io.out('下一步：');
  io.out('  sap-superagent dev                     启动本地控制平面（M1）');
  io.out('  sap-superagent token                   为 VSCode 扩展签发 user token');
  if (!envFilePresent) {
    if (envExamplePath !== undefined) {
      io.out(`提示：未找到 ${envFilePath(cwd)}，可从模板复制：cp ${envExamplePath} ${envFilePath(cwd)}`);
      io.out('      不复制也能跑：默认使用 fake AI provider（离线、无网络）。');
    } else {
      io.out(`提示：未找到 ${envFilePath(cwd)}；默认使用 fake AI provider，无需任何配置即可启动。`);
    }
  }
  if (options.baseBranch === undefined) {
    io.out('（baseBranch 默认 main；可用 --base-branch 指定其他基线分支。）');
  }
  if (options.repo !== undefined && options.repo.trim() === '') {
    throw new CliError('--repo 不能为空。');
  }
  return {
    filePath: written.filePath,
    stateDir,
    overwritten: written.overwritten,
    envFilePresent,
    envExamplePath,
  };
}
