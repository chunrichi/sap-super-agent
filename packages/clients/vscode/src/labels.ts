// Chinese display labels for protocol enums + human-friendly timestamps.
// Pure module (no `vscode` import) so every mapping is unit-testable and the
// inbox/status bar/command feedback all use the same wording (docs/005 §5).
import type { ArtifactKind, NotificationKind, Role, TaskState } from '@sap-superagent/protocol';

/** `Task.state` — the one-line summary under a task title must not leak English. */
export const TASK_STATE_LABELS: Record<TaskState, string> = {
  pending: '待领取',
  claimed: '已领取',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** Gate roles (docs/003 §2.5): who has to answer. */
export const ROLE_LABELS: Record<Role, string> = {
  requester: '需求方',
  consultant: '需求顾问',
  developer: '开发',
  ops: '运维',
};

/** `Notification.kind` (docs/003 §2.5) in the "必须你处理" wording. */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  'approval.requested': '审批请求',
  'approval.decided': '审批已决定',
  'approval.expired': '审批已过期',
  'stage.waiting_human': '阶段等待人工确认',
  'stage.failed': '阶段失败',
};

/** Artifact kinds shown in the submit-artifact quick pick. */
export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  requirement_analysis: '需求分析',
  dev_spec: '开发规范',
  code_change: '代码变更',
  test_doc: '测试文档',
  knowledge_entry: '知识条目',
  free_note: '自由笔记',
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

export function taskStateLabel(state: TaskState): string {
  return TASK_STATE_LABELS[state];
}

export function notificationKindLabel(kind: NotificationKind): string {
  return NOTIFICATION_KIND_LABELS[kind];
}

export function artifactKindLabel(kind: ArtifactKind): string {
  return ARTIFACT_KIND_LABELS[kind];
}

export interface FormatTimestampOptions {
  /** IANA zone for deterministic display/tests; defaults to the host zone. */
  timeZone?: string;
}

/**
 * `2026-11-05T00:00:00.000Z` → `2026-11-05 08:00` in the host zone. Invalid or
 * empty input is returned as-is so tooltips never show `Invalid Date`.
 */
export function formatTimestamp(
  value: string | null | undefined,
  options: FormatTimestampOptions = {},
): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}
