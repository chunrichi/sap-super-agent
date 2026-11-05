// Local paths shared by init/dev/token/doctor (docs/005 §2.5).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';

export const WORKSPACE_DIR_NAME = '.sap-superagent';
export const WORKSPACE_FILE_NAME = 'workspace.json';
export const DEFAULT_STATE_DIR = path.join(WORKSPACE_DIR_NAME, 'state');
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3080;
export const DEFAULT_BASE_BRANCH = 'main';
export const ENV_FILE_NAME = '.env';
export const ENV_EXAMPLE_FILE_NAME = '.env.example';

/** `<cwd>/.sap-superagent` */
export function workspaceDir(cwd: string): string {
  return path.join(path.resolve(cwd), WORKSPACE_DIR_NAME);
}

/** `<cwd>/.sap-superagent/workspace.json` */
export function workspaceFilePath(cwd: string): string {
  return path.join(workspaceDir(cwd), WORKSPACE_FILE_NAME);
}

/**
 * State dir resolution shared with the server: explicit flag > `SA_STATE_DIR` >
 * `.sap-superagent/state`. Relative paths resolve against `cwd`.
 */
export function resolveStateDir(cwd: string, env: NodeJS.ProcessEnv, override?: string): string {
  const fromEnv = env['SA_STATE_DIR']?.trim();
  const raw = override?.trim() ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_STATE_DIR);
  if (raw === '') {
    throw new CliError('状态目录不能为空。');
  }
  return path.resolve(cwd, raw);
}

/** Parsed HTTP port: explicit flag > `SA_HTTP_PORT` > 3080. */
export function resolvePort(env: NodeJS.ProcessEnv, override?: string | number): number {
  if (typeof override === 'number') {
    guardPort(override);
    return override;
  }
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number.parseInt(override.trim(), 10);
    guardPort(parsed);
    return parsed;
  }
  const fromEnv = env['SA_HTTP_PORT']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number.parseInt(fromEnv, 10);
    guardPort(parsed);
    return parsed;
  }
  return DEFAULT_PORT;
}

function guardPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CliError(`端口不合法：${port}（应为 0–65535 的整数）。`);
  }
}

/**
 * Walk up from `startDir` until a directory containing `templates/default.yaml`
 * is found; returns that `templates/` directory. Works no matter which
 * subdirectory `sap-superagent dev` is started from (H0 §1.6).
 */
export function findTemplatesDir(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, 'templates', 'default.yaml');
    if (existsSync(candidate)) {
      return path.join(current, 'templates');
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** First `.env.example` found at or above `startDir` (repo root for M1 checkouts). */
export function findEnvExample(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, ENV_EXAMPLE_FILE_NAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function envFilePath(cwd: string): string {
  return path.join(path.resolve(cwd), ENV_FILE_NAME);
}
