import { afterEach, describe, expect, it } from 'vitest';
import { newDemandId, newUlid } from '@sap-superagent/protocol';
import {
  APPROVAL_ACTION_COMMAND,
  CONNECTED_CONTEXT_KEY,
  GROUP_ICONS,
  GROUP_PLACEHOLDER_LABELS,
  INBOX_GROUP_LABELS,
  PRIORITY_ICONS,
  READ_NOTIFICATION_COMMAND,
  WAITING_ICONS,
  TaskInboxProvider,
  buildInboxNodes,
  describeTask,
  emptyInboxData,
  groupAccessibilityLabel,
  groupTooltip,
  shortDemandId,
  shouldShowWelcome,
} from '../src/tasksView.js';
import { ThemeIcon, resetVscodeMock } from './mocks/vscode.js';
import { makeTask } from './fixtures.js';

afterEach(() => {
  resetVscodeMock();
});

describe('buildInboxNodes', () => {
  it('exposes the three H0 groups with counts', () => {
    const available = makeTask({ title: '可领取任务' });
    const mine = makeTask({ title: '我的任务', state: 'in_progress' });
    const nodes = buildInboxNodes({
      available: [available],
      mine: [mine],
      waiting: [],
    });

    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ kind: 'group', group: 'available', label: '可领取', count: 1 });
    expect(nodes[1]).toMatchObject({ kind: 'group', group: 'mine', label: '我的任务', count: 1 });
    expect(nodes[2]).toMatchObject({ kind: 'group', group: 'waiting', label: '等待我回答', count: 0 });
    expect(INBOX_GROUP_LABELS.waiting).toBe('等待我回答');
  });

  it('sorts tasks by priority then creation time inside a group', () => {
    const low = makeTask({ priority: 'low', createdAt: '2026-11-01T00:00:00.000Z' });
    const high = makeTask({ priority: 'high', createdAt: '2026-11-03T00:00:00.000Z' });
    const normal = makeTask({ priority: 'normal', createdAt: '2026-11-02T00:00:00.000Z' });

    const groups = buildInboxNodes({ ...emptyInboxData(), available: [low, high, normal] });
    const group = groups[0]!;
    const children = buildInboxNodes({ ...emptyInboxData(), available: [low, high, normal] }, group);

    expect(children.map((node) => (node.kind === 'task' ? node.task.priority : 'group'))).toEqual([
      'high',
      'normal',
      'low',
    ]);
  });

  it('returns no children for a task node', () => {
    const task = makeTask();
    const groups = buildInboxNodes({ ...emptyInboxData(), mine: [task] });
    const children = buildInboxNodes({ ...emptyInboxData(), mine: [task] }, groups[1]!);
    expect(buildInboxNodes(emptyInboxData(), children[0]!)).toEqual([]);
  });

  it('describes bound and unbound tasks', () => {
    expect(describeTask(makeTask())).toContain('SALES');
    expect(describeTask(makeTask({ workspaceBinding: null }))).toContain('通用');
    expect(describeTask(makeTask({ priority: 'high' }))).toContain('高');
  });

  it('shows the Chinese task state instead of the raw protocol value', () => {
    expect(describeTask(makeTask({ state: 'pending' }))).toContain('待领取');
    expect(describeTask(makeTask({ state: 'in_progress' }))).toContain('进行中');
    expect(describeTask(makeTask({ state: 'in_progress' }))).not.toContain('in_progress');
  });
});

describe('empty groups and welcome state', () => {
  it('gives an individual empty group one non-clickable placeholder row', () => {
    const provider = new TaskInboxProvider();
    provider.refresh({ available: [makeTask()], mine: [], waiting: [] });
    const groups = provider.getChildren();
    expect(groups).toHaveLength(3);
    for (const [index, group] of (['mine', 'waiting'] as const).entries()) {
      const children = provider.getChildren(groups[index + 1]!);
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({
        kind: 'placeholder',
        group,
        label: GROUP_PLACEHOLDER_LABELS[group],
      });
      const item = provider.getTreeItem(children[0]!);
      expect(item.command).toBeUndefined();
      expect(item.contextValue).toBe(`sapSuperAgent.placeholder.${group}`);
      expect(item.accessibilityInformation?.label).toBeTruthy();
      expect(item.iconPath).toBeInstanceOf(ThemeIcon);
      // Placeholders are leaves; they never nest further rows.
      expect(provider.getChildren(children[0]!)).toEqual([]);
      // Empty groups stay expanded so the placeholder is visible.
      expect(provider.getTreeItem(groups[index + 1]!).collapsibleState).toBe(2);
    }
  });

  it('renders an empty root so viewsWelcome can show (disconnected or idle)', () => {
    const idle = new TaskInboxProvider();
    expect(shouldShowWelcome(true, emptyInboxData())).toBe(true);
    expect(idle.getChildren()).toEqual([]);
    idle.refresh({ available: [makeTask()], mine: [], waiting: [] });
    expect(idle.getChildren()).toHaveLength(3);
    idle.dispose();

    const offline = new TaskInboxProvider(false);
    expect(offline.connected).toBe(false);
    expect(shouldShowWelcome(false, { available: [makeTask()], mine: [], waiting: [] })).toBe(true);
    expect(offline.getChildren()).toEqual([]);
    let fired = 0;
    offline.onDidChangeTreeData(() => {
      fired += 1;
    });
    offline.setConnected(true);
    expect(fired).toBe(1);
    offline.refresh({ available: [makeTask()], mine: [], waiting: [] });
    expect(offline.getChildren()).toHaveLength(3);
    offline.setConnected(true);
    expect(fired).toBe(2); // setConnected no-op; the refresh above fired once.
    expect(CONNECTED_CONTEXT_KEY).toBe('sapSuperAgent.connected');
    offline.dispose();
  });
});

describe('tree icons and accessibility', () => {
  it('uses group codicons and screen-reader labels', () => {
    const provider = new TaskInboxProvider();
    provider.refresh({ available: [makeTask()], mine: [], waiting: [] });
    const groups = provider.getChildren();
    for (const [index, group] of (['available', 'mine', 'waiting'] as const).entries()) {
      const item = provider.getTreeItem(groups[index]!);
      expect((item.iconPath as ThemeIcon).id).toBe(GROUP_ICONS[group]);
      expect(item.accessibilityInformation?.label).toContain(INBOX_GROUP_LABELS[group]);
    }
    expect(groupAccessibilityLabel('available', 0)).toBe('可领取，暂无待办');
    expect(groupAccessibilityLabel('waiting', 2)).toBe('等待我回答，2 项');
    expect(GROUP_ICONS.available).toBe('inbox');
    expect(GROUP_ICONS.mine).toBe('account');
    expect(GROUP_ICONS.waiting).toBe('bell');
  });

  it('uses a priority codicon and a readable label for task rows', () => {
    const provider = new TaskInboxProvider();
    const high = makeTask({ priority: 'high', title: '高优先级任务' });
    provider.refresh({ available: [high], mine: [], waiting: [] });
    const group = provider.getChildren()[0]!;
    const item = provider.getTreeItem(provider.getChildren(group)[0]!);
    expect((item.iconPath as ThemeIcon).id).toBe(PRIORITY_ICONS.high);
    expect(PRIORITY_ICONS.high).toBe('arrow-up');
    expect(PRIORITY_ICONS.normal).toBe('dash');
    expect(PRIORITY_ICONS.low).toBe('arrow-down');
    expect(item.accessibilityInformation?.label).toContain('高优先级任务');
    expect(item.accessibilityInformation?.label).toContain('高优先级');
    expect(item.accessibilityInformation?.label).toContain('待领取');
  });
});

describe('TaskInboxProvider', () => {
  it('creates tree items with the open-task command and group context values', () => {
    const provider = new TaskInboxProvider();
    const task = makeTask({ title: '取数逻辑' });
    provider.refresh({ available: [task], mine: [], waiting: [] });

    const groupNodes = provider.getChildren();
    const groupItem = provider.getTreeItem(groupNodes[0]!);
    expect(groupItem.contextValue).toBe('sapSuperAgent.group.available');

    const taskNodes = provider.getChildren(groupNodes[0]!);
    const taskItem = provider.getTreeItem(taskNodes[0]!);
    expect(taskItem.label).toBe('取数逻辑');
    expect(taskItem.contextValue).toBe('sapSuperAgent.task.available');
    expect((taskItem.command as { command: string }).command).toBe('sapSuperAgent.openTask');
  });

  it('fires onDidChangeTreeData on refresh', () => {
    const provider = new TaskInboxProvider();
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });
    provider.refresh(emptyInboxData());
    expect(fired).toBe(1);
    provider.dispose();
  });
});

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: newUlid(),
    demandId: newDemandId(),
    stageRunId: newUlid(),
    gateKey: 'G1',
    artifactId: newUlid(),
    artifactVersion: 1,
    state: 'pending' as const,
    requiredRole: 'consultant' as const,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    comment: null,
    expiresAt: null,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: newUlid(),
    demandId: newDemandId(),
    stageRunId: null,
    approvalId: null,
    kind: 'stage.waiting_human' as const,
    requiredRole: 'developer' as const,
    title: '阶段等待人工确认',
    body: '需要你确认输出',
    createdAt: '2026-11-05T00:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('waiting group (S3: approvals + notifications)', () => {
  it('counts gates and unread notifications in the group', () => {
    const nodes = buildInboxNodes({
      ...emptyInboxData(),
      waiting: [
        { kind: 'approval', approval: makeApproval() },
        { kind: 'notification', notification: makeNotification() },
      ],
    });
    expect(nodes[2]).toMatchObject({ kind: 'group', group: 'waiting', count: 2 });
  });

  it('shows gates before notifications, oldest gate first', () => {
    const older = makeApproval({ gateKey: 'G1', createdAt: '2026-11-01T00:00:00.000Z' });
    const newer = makeApproval({ gateKey: 'G3', createdAt: '2026-11-03T00:00:00.000Z' });
    const note = makeNotification({ title: '通知 A', createdAt: '2026-11-04T00:00:00.000Z' });
    const data = {
      ...emptyInboxData(),
      waiting: [
        { kind: 'notification' as const, notification: note },
        { kind: 'approval' as const, approval: newer },
        { kind: 'approval' as const, approval: older },
      ],
    };
    const group = buildInboxNodes(data)[2]!;
    const children = buildInboxNodes(data, group);
    expect(children.map((node) => (node.kind === 'waiting' ? node.label : 'group'))).toEqual([
      '审批 G1 · 需求顾问',
      '审批 G3 · 需求顾问',
      '通知 A',
    ]);
  });

  it('localizes the gate role, version and times in the row details', () => {
    const provider = new TaskInboxProvider();
    const approval = makeApproval({
      gateKey: 'G3',
      requiredRole: 'developer',
      artifactVersion: 4,
      expiresAt: '2026-11-06T00:00:00.000Z',
    });
    provider.refresh({
      ...emptyInboxData(),
      waiting: [{ kind: 'approval', approval }],
    });
    const group = provider.getChildren()[2]!;
    const item = provider.getTreeItem(provider.getChildren(group)[0]!);
    expect(item.label).toBe('审批 G3 · 开发');
    expect(String(item.description)).toContain('v4');
    expect(String(item.description)).toContain('需求');
    expect(String(item.tooltip)).toContain('所需角色：开发');
    expect(String(item.tooltip)).toContain('到期时间：');
    expect(String(item.tooltip)).toContain('创建时间：');
    expect((item.iconPath as ThemeIcon).id).toBe(WAITING_ICONS.approval);
    expect(WAITING_ICONS.approval).toBe('pass');
    expect(item.accessibilityInformation?.label).toContain('角色 开发');
  });

  it('localizes notification kinds and keeps demand/time in the row', () => {
    const provider = new TaskInboxProvider();
    const notification = makeNotification({ kind: 'stage.failed' });
    provider.refresh({
      ...emptyInboxData(),
      waiting: [{ kind: 'notification', notification }],
    });
    const group = provider.getChildren()[2]!;
    const item = provider.getTreeItem(provider.getChildren(group)[0]!);
    expect(String(item.description)).toContain('阶段失败');
    expect(String(item.description)).toContain('需求');
    expect(String(item.tooltip)).toContain('类型：阶段失败');
    expect((item.iconPath as ThemeIcon).id).toBe(WAITING_ICONS.notification);
    expect(WAITING_ICONS.notification).toBe('bell');
    expect(item.accessibilityInformation?.label).toContain('阶段失败');
  });

  it('creates clickable tree items for gates and notifications', () => {
    const provider = new TaskInboxProvider();
    const approval = makeApproval({ gateKey: 'G1' });
    const notification = makeNotification({ title: '待确认' });
    provider.refresh({
      ...emptyInboxData(),
      waiting: [
        { kind: 'approval', approval },
        { kind: 'notification', notification },
      ],
    });
    const group = provider.getChildren()[2]!;
    const [approvalNode, notificationNode] = provider.getChildren(group);
    const approvalItem = provider.getTreeItem(approvalNode!);
    expect(approvalItem.contextValue).toBe('sapSuperAgent.waiting.approval');
    expect((approvalItem.command as { command: string }).command).toBe(APPROVAL_ACTION_COMMAND);
    expect((approvalItem.command as { arguments: unknown[] }).arguments).toEqual([approval]);
    expect(String(approvalItem.tooltip)).toContain('通过');

    const notificationItem = provider.getTreeItem(notificationNode!);
    expect(notificationItem.label).toBe('待确认');
    expect(notificationItem.contextValue).toBe('sapSuperAgent.waiting.notification');
    expect((notificationItem.command as { command: string }).command).toBe(
      READ_NOTIFICATION_COMMAND,
    );
  });

  it('gives the next action for empty groups and short demand ids', () => {
    expect(groupTooltip('waiting', 0)).toContain('没有等待你回答');
    expect(groupTooltip('available', 0)).toContain('可领取');
    expect(groupTooltip('mine', 2)).toContain('2');
    expect(shortDemandId('4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3')).toBe('…f7a1c3');
    expect(shortDemandId('short')).toBe('short');
  });
});
