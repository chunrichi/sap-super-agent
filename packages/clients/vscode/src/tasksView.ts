// Activity Bar "任务箱" tree (docs/005 §2.2): three groups — 可领取 / 我的任务 /
// 等待我回答. The third group stays empty in H0 because approvals arrive in H1.
import * as vscode from 'vscode';
import type { Task } from '@sap-superagent/protocol';

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

export interface InboxData {
  available: Task[];
  mine: Task[];
  waiting: Task[];
}

export function emptyInboxData(): InboxData {
  return { available: [], mine: [], waiting: [] };
}

export type InboxNode =
  | { kind: 'group'; group: InboxGroupId; label: string; count: number }
  | { kind: 'task'; group: InboxGroupId; task: Task; description: string; tooltip: string };

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
  return sortTasks(data[parent.group]).map((task) => ({
    kind: 'task',
    group: parent.group,
    task,
    description: describeTask(task),
    tooltip: tooltipForTask(task),
  }));
}

/** Open-task command used by both the tree click and the command palette. */
export const OPEN_TASK_COMMAND = 'sapSuperAgent.openTask';

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
      item.contextValue = `sapSuperAgent.group.${node.group}`;
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
