// Activity Bar "任务箱" tree (docs/005 §2.2): three groups — 可领取 / 我的任务 /
// 等待我回答. S3 fills the third group from the H1 approvals/notifications APIs
// so the developer sees gates and must-act alerts without leaving the inbox.
//
// Rows are one line + codicon + screen-reader label; an empty group keeps a
// non-clickable placeholder row that says what to do next (docs/005 §5).
import * as vscode from 'vscode';
import type { Approval, Notification, Task } from '@sap-superagent/protocol';
import { formatTimestamp, notificationKindLabel, roleLabel, taskStateLabel } from './labels.js';

export const INBOX_VIEW_ID = 'sapSuperAgent.inbox';
/** VS Code context key maintained by extension.ts for `viewsWelcome` / menus. */
export const CONNECTED_CONTEXT_KEY = 'sapSuperAgent.connected';

export const INBOX_GROUPS = ['available', 'mine', 'waiting'] as const;
export type InboxGroupId = (typeof INBOX_GROUPS)[number];

export const INBOX_GROUP_LABELS: Record<InboxGroupId, string> = {
  available: '可领取',
  mine: '我的任务',
  waiting: '等待我回答',
};

/** Group codicons: inbox = claimable pool, account = mine, bell = needs an answer. */
export const GROUP_ICONS: Record<InboxGroupId, string> = {
  available: 'inbox',
  mine: 'account',
  waiting: 'bell',
};

/** Task codicon by priority (high first inside each group). */
export const PRIORITY_ICONS: Record<Task['priority'], string> = {
  high: 'arrow-up',
  normal: 'dash',
  low: 'arrow-down',
};

/** "等待我回答" row icons: a gate is an action to take, a notification is a reminder. */
export const WAITING_ICONS: Record<'approval' | 'notification', string> = {
  approval: 'pass',
  notification: 'bell',
};

const PLACEHOLDER_ICON = 'info';

const PRIORITY_LABELS: Record<Task['priority'], string> = {
  high: '高',
  normal: '普通',
  low: '低',
};

const PRIORITY_ORDER: Record<Task['priority'], number> = {
  high: 0,
  normal: 1,
  low: 2,
};

/** Inline hint shown as the only child of an empty group (never clickable). */
export const GROUP_PLACEHOLDER_LABELS: Record<InboxGroupId, string> = {
  available: '（暂无任务，等待控制面派单）',
  mine: '（还没有我的任务，从「可领取」领取）',
  waiting: '（没有等待你回答的审批或通知）',
};

/** Screen-reader text for a placeholder row (brackets omitted). */
const GROUP_PLACEHOLDER_ARIA: Record<InboxGroupId, string> = {
  available: '暂无可领取任务，等待控制面派单',
  mine: '还没有我的任务，从可领取分组领取',
  waiting: '没有等待你回答的审批或通知',
};

/**
 * One "等待我回答" row: a pending gate (approvable right from the inbox) or an
 * unread must-act notification (markable as read).
 */
export type WaitingItem =
  | { kind: 'approval'; approval: Approval }
  | { kind: 'notification'; notification: Notification };

export interface InboxData {
  available: Task[];
  mine: Task[];
  waiting: WaitingItem[];
}

export function emptyInboxData(): InboxData {
  return { available: [], mine: [], waiting: [] };
}

export type InboxNode =
  | { kind: 'group'; group: InboxGroupId; label: string; count: number }
  | { kind: 'task'; group: InboxGroupId; task: Task; description: string; tooltip: string }
  | {
      kind: 'waiting';
      group: 'waiting';
      item: WaitingItem;
      label: string;
      description: string;
      tooltip: string;
    }
  | {
      kind: 'placeholder';
      group: InboxGroupId;
      label: string;
      tooltip: string;
      accessibilityLabel: string;
    };

/** One-line summary under the task title. */
export function describeTask(task: Task): string {
  const priority = PRIORITY_LABELS[task.priority];
  const binding =
    task.workspaceBinding === null
      ? '通用'
      : task.workspaceBinding.projectKey ?? task.workspaceBinding.repo;
  return `${priority} · ${taskStateLabel(task.state)} · ${binding}`;
}

/** Screen-reader label for a task row. */
export function taskAccessibilityLabel(task: Task): string {
  const binding =
    task.workspaceBinding === null
      ? '通用任务箱'
      : (task.workspaceBinding.projectKey ?? task.workspaceBinding.repo);
  return `${task.title}，${PRIORITY_LABELS[task.priority]}优先级，${taskStateLabel(task.state)}，${binding}`;
}

function tooltipForTask(task: Task): string {
  const lines = [
    task.title,
    `需求：${task.demandId}`,
    `优先级：${PRIORITY_LABELS[task.priority]}`,
    `状态：${taskStateLabel(task.state)}`,
  ];
  if (task.dueAt !== null) {
    lines.push(`截止时间：${formatTimestamp(task.dueAt)}`);
  }
  if (task.workspaceBinding === null) {
    lines.push('工作区：通用任务箱');
  } else {
    const { repo, projectKey, baseBranch } = task.workspaceBinding;
    lines.push(`工作区：${repo}${projectKey === undefined ? '' : ` / ${projectKey}`}`);
    lines.push(`基线分支：${baseBranch ?? 'main'}`);
  }
  if (task.requiredRoles.length > 0) {
    lines.push(`所需角色：${task.requiredRoles.map(roleLabel).join('、')}`);
  }
  return lines.join('\n');
}

/** Short demand reference for one-line inbox rows (SAP ids are long C32 hex). */
export function shortDemandId(demandId: string): string {
  return demandId.length <= 8 ? demandId : `…${demandId.slice(-6)}`;
}

function approvalLabel(approval: Approval): string {
  return `审批 ${approval.gateKey} · ${roleLabel(approval.requiredRole)}`;
}

function approvalDescription(approval: Approval): string {
  return `需求 ${shortDemandId(approval.demandId)} · v${approval.artifactVersion}`;
}

function approvalTooltip(approval: Approval): string {
  const lines = [
    `需求：${approval.demandId}`,
    `门禁：${approval.gateKey}`,
    `所需角色：${roleLabel(approval.requiredRole)}`,
    `绑定工件：${approval.artifactId} v${approval.artifactVersion}`,
    `创建时间：${formatTimestamp(approval.createdAt)}`,
  ];
  if (approval.expiresAt !== null) lines.push(`到期时间：${formatTimestamp(approval.expiresAt)}`);
  if (approval.decidedAt !== null) lines.push(`决策时间：${formatTimestamp(approval.decidedAt)}`);
  lines.push('点击选择「通过」或「驳回」；决策后该条目会移除并刷新任务箱与状态栏。');
  return lines.join('\n');
}

function approvalAccessibilityLabel(approval: Approval): string {
  return `审批 ${approval.gateKey}，角色 ${roleLabel(approval.requiredRole)}，需求 ${shortDemandId(
    approval.demandId,
  )} 版本 ${approval.artifactVersion}`;
}

function notificationLabel(notification: Notification): string {
  return notification.title;
}

function notificationDescription(notification: Notification): string {
  return `${notificationKindLabel(notification.kind)} · 需求 ${shortDemandId(notification.demandId)} · ${formatTimestamp(notification.createdAt)}`;
}

function notificationTooltip(notification: Notification): string {
  const lines = [
    `类型：${notificationKindLabel(notification.kind)}`,
    `需求：${notification.demandId}`,
    `时间：${formatTimestamp(notification.createdAt)}`,
  ];
  if (notification.requiredRole !== null) {
    lines.push(`所需角色：${roleLabel(notification.requiredRole)}`);
  }
  if (notification.body !== null) lines.push('', notification.body);
  lines.push('', '点击标记已读；审批类待办请在上方审批条目处理。');
  return lines.join('\n');
}

function notificationAccessibilityLabel(notification: Notification): string {
  return `通知：${notification.title}，${notificationKindLabel(notification.kind)}，需求 ${shortDemandId(
    notification.demandId,
  )}`;
}

function sortWaiting(items: WaitingItem[]): WaitingItem[] {
  // Gates first (actionable), oldest first; unread notifications after, newest first.
  const approvals = items
    .filter((item): item is Extract<WaitingItem, { kind: 'approval' }> => item.kind === 'approval')
    .sort((left, right) => left.approval.createdAt.localeCompare(right.approval.createdAt));
  const notifications = items
    .filter(
      (item): item is Extract<WaitingItem, { kind: 'notification' }> => item.kind === 'notification',
    )
    .sort((left, right) => right.notification.createdAt.localeCompare(left.notification.createdAt));
  return [...approvals, ...notifications];
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (byPriority !== 0) {
      return byPriority;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function placeholderNode(group: InboxGroupId): InboxNode {
  return {
    kind: 'placeholder',
    group,
    label: GROUP_PLACEHOLDER_LABELS[group],
    tooltip: groupTooltip(group, 0),
    accessibilityLabel: GROUP_PLACEHOLDER_ARIA[group],
  };
}

/** Pure tree builder so grouping/labels are unit-testable without a tree view. */
export function buildInboxNodes(data: InboxData, parent?: InboxNode): InboxNode[] {
  if (parent === undefined) {
    return INBOX_GROUPS.map((group) => ({
      kind: 'group',
      group,
      label: INBOX_GROUP_LABELS[group],
      count: data[group].length,
    }));
  }
  if (parent.kind !== 'group') {
    return [];
  }
  if (parent.group === 'waiting') {
    const items = sortWaiting(data.waiting);
    if (items.length === 0) {
      return [placeholderNode('waiting')];
    }
    return items.map((item) =>
      item.kind === 'approval'
        ? {
            kind: 'waiting' as const,
            group: 'waiting' as const,
            item,
            label: approvalLabel(item.approval),
            description: approvalDescription(item.approval),
            tooltip: approvalTooltip(item.approval),
          }
        : {
            kind: 'waiting' as const,
            group: 'waiting' as const,
            item,
            label: notificationLabel(item.notification),
            description: notificationDescription(item.notification),
            tooltip: notificationTooltip(item.notification),
          },
    );
  }
  const tasks = sortTasks(data[parent.group]);
  if (tasks.length === 0) {
    return [placeholderNode(parent.group)];
  }
  return tasks.map((task) => ({
    kind: 'task',
    group: parent.group,
    task,
    description: describeTask(task),
    tooltip: tooltipForTask(task),
  }));
}

/**
 * The root renders the `viewsWelcome` page (instead of three empty groups) when
 * the developer is disconnected or has nothing at all to look at. Individual
 * empty groups still get a placeholder row once the tree has content.
 */
export function shouldShowWelcome(connected: boolean, data: InboxData): boolean {
  if (!connected) {
    return true;
  }
  return data.available.length === 0 && data.mine.length === 0 && data.waiting.length === 0;
}

/** Next-action hint for an empty group (docs/005 §5: 空状态给下一步动作). */
export function groupTooltip(group: InboxGroupId, count: number): string {
  if (count > 0) return `${INBOX_GROUP_LABELS[group]}：${count} 项`;
  switch (group) {
    case 'available':
      return '暂时没有可领取任务。任务到达时会实时出现在这里（也可用命令面板「领取任务」刷新）。';
    case 'mine':
      return '还没有领取任务。从「可领取」里选一项领取，租约与续约由扩展自动处理。';
    case 'waiting':
      return '没有等待你回答的审批或通知。新的门禁/提醒会实时出现在这里。';
  }
}

/** Screen-reader text for a group row. */
export function groupAccessibilityLabel(group: InboxGroupId, count: number): string {
  return count > 0
    ? `${INBOX_GROUP_LABELS[group]}，${count} 项`
    : `${INBOX_GROUP_LABELS[group]}，暂无待办`;
}

/** Open-task command used by both the tree click and the command palette. */
export const OPEN_TASK_COMMAND = 'sapSuperAgent.openTask';
/** Context action for a pending gate row (registered but not in the palette). */
export const APPROVAL_ACTION_COMMAND = 'sapSuperAgent.approvalAction';
/** Context action for an unread notification row (registered, not in the palette). */
export const READ_NOTIFICATION_COMMAND = 'sapSuperAgent.readNotification';

export class TaskInboxProvider implements vscode.TreeDataProvider<InboxNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<InboxNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private data: InboxData = emptyInboxData();
  private connectedState: boolean;

  /**
   * `connected = false` renders an empty root so VS Code shows the
   * `viewsWelcome` connect action; placeholder rows appear once connected.
   */
  constructor(connected = true) {
    this.connectedState = connected;
  }

  get currentData(): InboxData {
    return this.data;
  }

  get connected(): boolean {
    return this.connectedState;
  }

  setConnected(connected: boolean): void {
    if (this.connectedState === connected) {
      return;
    }
    this.connectedState = connected;
    this.changed.fire(undefined);
  }

  refresh(data: InboxData): void {
    this.data = data;
    this.changed.fire(undefined);
  }

  getTreeItem(node: InboxNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.group}`;
      item.description = node.count > 0 ? `${node.count}` : '';
      item.tooltip = groupTooltip(node.group, node.count);
      item.contextValue = `sapSuperAgent.group.${node.group}`;
      item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[node.group]);
      item.accessibilityInformation = { label: groupAccessibilityLabel(node.group, node.count) };
      return item;
    }
    if (node.kind === 'placeholder') {
      // No `command`: VS Code keeps the row visible but click does nothing.
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = `placeholder:${node.group}`;
      item.contextValue = `sapSuperAgent.placeholder.${node.group}`;
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(PLACEHOLDER_ICON);
      item.accessibilityInformation = { label: node.accessibilityLabel };
      return item;
    }
    if (node.kind === 'waiting') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      const id =
        node.item.kind === 'approval' ? node.item.approval.id : node.item.notification.id;
      item.id = `waiting:${id}`;
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.contextValue = `sapSuperAgent.waiting.${node.item.kind}`;
      item.iconPath = new vscode.ThemeIcon(WAITING_ICONS[node.item.kind]);
      item.accessibilityInformation = {
        label:
          node.item.kind === 'approval'
            ? approvalAccessibilityLabel(node.item.approval)
            : notificationAccessibilityLabel(node.item.notification),
      };
      item.command =
        node.item.kind === 'approval'
          ? { command: APPROVAL_ACTION_COMMAND, title: '处理审批', arguments: [node.item.approval] }
          : {
              command: READ_NOTIFICATION_COMMAND,
              title: '标记已读',
              arguments: [node.item.notification],
            };
      return item;
    }
    const item = new vscode.TreeItem(node.task.title, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${node.task.id}`;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = `sapSuperAgent.task.${node.group}`;
    item.iconPath = new vscode.ThemeIcon(PRIORITY_ICONS[node.task.priority]);
    item.accessibilityInformation = { label: taskAccessibilityLabel(node.task) };
    item.command = {
      command: OPEN_TASK_COMMAND,
      title: '打开任务',
      arguments: [node.task],
    };
    return item;
  }

  getChildren(node?: InboxNode): InboxNode[] {
    // An empty root is on purpose: VS Code then shows the matching
    // `viewsWelcome` page (connect when offline, 领取任务 when connected+idle).
    if (node === undefined && shouldShowWelcome(this.connectedState, this.data)) {
      return [];
    }
    if (node !== undefined && node.kind === 'placeholder') {
      return [];
    }
    return buildInboxNodes(this.data, node);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
