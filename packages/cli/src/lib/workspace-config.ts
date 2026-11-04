// `.sap-superagent/workspace.json` — shared workspace binding (docs/005 §2.5).
// Every field is optional: an unbound repository simply has `baseBranch`.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CliError } from './errors.js';
import { DEFAULT_BASE_BRANCH, workspaceDir, workspaceFilePath } from './paths.js';

export interface WorkspaceConfig {
  repo?: string;
  projectKey?: string;
  baseBranch: string;
  prepare?: string;
}

export interface WorkspaceConfigWriteResult {
  filePath: string;
  overwritten: boolean;
}

export interface WorkspaceConfigInput {
  repo?: string | undefined;
  projectKey?: string | undefined;
  baseBranch?: string | undefined;
  prepare?: string | undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result === undefined || result === '' ? undefined : result;
}

function isEmptyRecord(record: Record<string, unknown>): boolean {
  return Object.keys(record).length === 0;
}

export async function readWorkspaceConfig(cwd: string): Promise<WorkspaceConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(workspaceFilePath(cwd), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new CliError(`读取 ${workspaceFilePath(cwd)} 失败：${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`无法解析 ${workspaceFilePath(cwd)}：不是合法的 JSON。`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${workspaceFilePath(cwd)} 必须是 JSON 对象。`);
  }
  const record = parsed as Record<string, unknown>;
  const repo = typeof record['repo'] === 'string' ? record['repo'].trim() : undefined;
  const projectKey = typeof record['projectKey'] === 'string' ? record['projectKey'].trim() : undefined;
  const baseBranch = typeof record['baseBranch'] === 'string' ? record['baseBranch'].trim() : undefined;
  const prepare = typeof record['prepare'] === 'string' ? record['prepare'].trim() : undefined;
  const config: WorkspaceConfig = { baseBranch: baseBranch ?? DEFAULT_BASE_BRANCH };
  if (repo !== undefined && repo !== '') {
    config.repo = repo;
  }
  if (projectKey !== undefined && projectKey !== '') {
    config.projectKey = projectKey;
  }
  if (prepare !== undefined && prepare !== '') {
    config.prepare = prepare;
  }
  return config;
}

/**
 * Write the workspace binding. Refuses to silently replace an existing file
 * unless `force` is set (H0 §1.6); returns the path written.
 */
export async function writeWorkspaceConfig(
  cwd: string,
  input: WorkspaceConfigInput,
  options: { force?: boolean } = {},
): Promise<WorkspaceConfigWriteResult> {
  const filePath = workspaceFilePath(cwd);
  const exists = existsSync(filePath);
  if (exists && options.force !== true) {
    throw new CliError(
      `${filePath} 已存在；如需覆盖请加 --force（例如：sap-superagent init --force）。`,
    );
  }
  const payload: Record<string, string> = {};
  const repo = trimmed(input.repo);
  const projectKey = trimmed(input.projectKey);
  const baseBranch = trimmed(input.baseBranch) ?? DEFAULT_BASE_BRANCH;
  const prepare = trimmed(input.prepare);
  if (repo !== undefined) {
    payload['repo'] = repo;
  }
  if (projectKey !== undefined) {
    payload['projectKey'] = projectKey;
  }
  payload['baseBranch'] = baseBranch;
  if (prepare !== undefined) {
    payload['prepare'] = prepare;
  }
  if (isEmptyRecord(payload)) {
    throw new CliError('工作区配置为空。');
  }
  await mkdir(workspaceDir(cwd), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { filePath, overwritten: exists };
}
