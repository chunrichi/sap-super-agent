// Activity Bar "任务箱" tree (docs/005 §2.2): three groups — 可领取 / 我的任务 /
// 等待我回答. S3 fills the third group from the H1 approvals/notifications APIs
// so the developer sees gates and must-act alerts without leaving the inbox.
import * as vscode from 'vscode';
import type { Approval, Notification, Task } from '@sap-superagent/protocol';

export const INBOX_VIEW_ID = 'sapSuperAgent.inbox';

export const INBOX_GROUPS = ['available', 'mine', 'waiting'] as const;
export type InboxGroupId = (typeof INBOX_GROUPS)[number];

export const INBOX_GROUP_LABELS: Record<InboxGroupId, string> = {
  available: '可领取',
  mine: '我的任务',
  waiting: '等待我回答',
};

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
    };

/** One-line summary under the task title. */
export function describeTask(task: Task): string {
  const priority = PRIORITY_LABELS[task.priority];
  const binding =
    task.workspaceBinding === null
      ? '通用'
      : task.workspaceBinding.projectKey ?? task.workspaceBinding.repo;
  return `${priority} · ${task.state} · ${binding}`;
}

function tooltipForTask(task: Task): string {
  const lines = [
    task.title,
    `需求：${task.demandId}`,
    `优先级：${PRIORITY_LABELS[task.priority]}`,
    `状态：${task.state}`,
  ];
  if (task.workspaceBinding === null) {
    lines.push('工作区：通用任务箱');
  } else {
    const { repo, projectKey, baseBranch } = task.workspaceBinding;
    lines.push(`工作区：${repo}${projectKey === undefined ? '' : ` / ${projectKey}`}`);
    lines.push(`基线分支：${baseBranch ?? 'main'}`);
  }
  if (task.requiredRoles.length > 0) {
    lines.push(`所需角色：${task.requiredRoles.join('、')}`);
  }
  return lines.join('\n');
}

/** Short demand reference for one-line inbox rows (SAP ids are long C32 hex). */
export function shortDemandId(demandId: string): string {
  return demandId.length <= 8 ? demandId : `…${demandId.slice(-6)}`;
}

function approvalLabel(approval: Approval): string {
  return `审批 ${approval.gateKey} · ${approval.requiredRole}`;
}

function approvalDescription(approval: Approval): string {
  return `需求 ${shortDemandId(approval.demandId)} · v${approval.artifactVersion}`;
}

function approvalTooltip(approval: Approval): string {
  const lines = [
    `门禁：${approval.gateKey}`,
    `需求：${approval.demandId}`,
    `所需角色：${approval.requiredRole}`,
    `绑定工件：${approval.artifactId} v${approval.artifactVersion}`,
    `创建时间：${approval.createdAt}`,
  ];
  if (approval.expiresAt !== null) lines.push(`到期时间：${approval.expiresAt}`);
  lines.push('点击选择「通过」或「驳回」；决策后会刷新任务箱与状态栏。');
  return lines.join('\n');
}

function notificationLabel(notification: Notification): string {
  return notification.title;
}

function notificationDescription(notification: Notification): string {
  return notification.requiredRole === null
    ? `需求 ${shortDemandId(notification.demandId)}`
    : `${notification.requiredRole} · 需求 ${shortDemandId(notification.demandId)}`;
}

function notificationTooltip(notification: Notification): string {
  const lines = [
    `类型：${notification.kind}`,
    `需求：${notification.demandId}`,
    `时间：${notification.createdAt}`,
  ];
  if (notification.body !== null) lines.push('', notification.body);
  lines.push('', '点击标记已读；审批类待办请在上方审批条目处理。');
  return lines.join('\n');
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
    return sortWaiting(data.waiting).map((item) =>
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
  return sortTasks(data[parent.group]).map((task) => ({
    kind: 'task',
    group: parent.group,
    task,
    description: describeTask(task),
    tooltip: tooltipForTask(task),
  }));
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

  get currentData(): InboxData {
    return this.data;
  }

  refresh(data: InboxData): void {
    this.data = data;
    this.changed.fire(undefined);
  }

  getTreeItem(node: InboxNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        node.label,
        node.count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      item.id = `group:${node.group}`;
      item.description = node.count > 0 ? `${node.count}` : '';
      item.tooltip = groupTooltip(node.group, node.count);
      item.contextValue = `sapSuperAgent.group.${node.group}`;
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
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
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
    item.iconPath = new vscode.ThemeIcon(node.group === 'waiting' ? 'comment-discussion' : 'tasklist');
    item.command = {
      command: OPEN_TASK_COMMAND,
      title: '打开任务',
      arguments: [node.task],
    };
    return item;
  }

  getChildren(node?: InboxNode): InboxNode[] {
    return buildInboxNodes(this.data, node);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
