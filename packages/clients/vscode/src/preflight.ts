// Client preflight (docs/005 §2.5, docs/009 #6/#7): before claiming/starting a
// task the extension checks the local preconditions it can observe cheaply.
// Failures never auto-retry a write; they explain the next action for the human.
// Pure module: the extension passes real VSCode state in, tests pass fixtures.

export type PreflightIssueCode =
  | 'workspace_untrusted'
  | 'no_workspace'
  | 'repo_dirty'
  | 'abap_missing'
  | 'abap_version'
  | 'sap_session_invalid'
  | 'allowed_system_mismatch';

export interface PreflightIssue {
  code: PreflightIssueCode;
  /** What is wrong, in the developer's language. */
  message: string;
  /** The concrete next action ("现在该做什么"). */
  action: string;
}

export interface PreflightInput {
  /** `vscode.workspace.isTrusted`; restricted-mode workspaces cannot run tools. */
  workspaceTrusted: boolean;
  hasWorkspaceFolder: boolean;
  /** `null` = not checked (e.g. only relevant when the task opens a worktree). */
  repoClean?: boolean | null;
  /** `null` = not checked / no SAP write actions on this task. */
  abapAvailable?: boolean | null;
  /** Detected `abap --version`, if probed. */
  abapVersion?: string | null;
  /** Minimum supported abap-cli version (docs/005 §2.5). */
  minimumAbapVersion?: string;
  /** `null` = SAP session validity not probed (no SAP action on this task). */
  sapSessionValid?: boolean | null;
  /** `null` = no allowedSystems configured / not applying to this task. */
  allowedSystemMatches?: boolean | null;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
  /**
   * The task must not start; surface the issues and let the human fix the
   * local precondition. The extension blocks the claim and keeps the task in
   * the pool instead of silently retrying a write (docs/005 §2.5).
   */
  blocked: boolean;
}

export const MINIMUM_ABAP_VERSION = '2.2.0';

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(actual);
  const right = parse(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Evaluate local preconditions. `ok === false` means: do not claim/start; show
 * the issues (each has an action) and leave the task for another executor.
 */
export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const issues: PreflightIssue[] = [];

  if (!input.hasWorkspaceFolder) {
    issues.push({
      code: 'no_workspace',
      message: '没有打开工作区文件夹。',
      action: '先打开任务对应的仓库目录，再运行 “SAP Super Agent: 领取任务”。',
    });
  }
  if (!input.workspaceTrusted) {
    issues.push({
      code: 'workspace_untrusted',
      message: '当前工作区处于受限模式（Workspace Trust）。',
      action: '确认信任该工作区后重试；受限模式下不会执行本地工具或写操作。',
    });
  }
  if (input.repoClean === false) {
    issues.push({
      code: 'repo_dirty',
      message: '仓库有未提交改动，可能与任务改动冲突。',
      action: '先提交/暂存或清理工作树，再领取任务（或由团队约定使用 worktree）。',
    });
  }
  if (input.abapAvailable === false) {
    issues.push({
      code: 'abap_missing',
      message: '本机找不到 abap-cli。',
      action: '安装并配置 abap-cli（≥2.2.0），或改领不涉及 SAP 写操作的任务。',
    });
  } else if (
    typeof input.abapVersion === 'string' &&
    input.abapVersion !== '' &&
    !versionAtLeast(input.abapVersion, input.minimumAbapVersion ?? MINIMUM_ABAP_VERSION)
  ) {
    issues.push({
      code: 'abap_version',
      message: `abap-cli 版本过低（${input.abapVersion}）。`,
      action: `升级 abap-cli 到 ${input.minimumAbapVersion ?? MINIMUM_ABAP_VERSION} 或更高版本后重试。`,
    });
  }
  if (input.sapSessionValid === false) {
    issues.push({
      code: 'sap_session_invalid',
      message: 'SAP 会话无效或已过期。',
      action: '运行 abap-cli 重新登录测试系统（不要在生产系统上重试写操作）。',
    });
  }
  if (input.allowedSystemMatches === false) {
    issues.push({
      code: 'allowed_system_mismatch',
      message: '任务目标系统不在本地 allowedSystems 白名单内。',
      action: '在扩展设置里补充 allowedSystems 白名单（SID/client），或请负责人调整任务目标；生产系统默认只读。',
    });
  }

  return { ok: issues.length === 0, issues, blocked: issues.length > 0 };
}

/** One-line summary for the warning notification. */
export function describePreflightFailure(result: PreflightResult): string {
  if (result.ok) return '';
  return result.issues.map((issue) => `${issue.message} → ${issue.action}`).join('\n');
}
