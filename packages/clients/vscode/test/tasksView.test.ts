import { afterEach, describe, expect, it } from 'vitest';
import { newDemandId, newUlid } from '@sap-superagent/protocol';
import {
  APPROVAL_ACTION_COMMAND,
  INBOX_GROUP_LABELS,
  READ_NOTIFICATION_COMMAND,
  TaskInboxProvider,
  buildInboxNodes,
  describeTask,
  emptyInboxData,
  groupTooltip,
  shortDemandId,
} from '../src/tasksView.js';
import { resetVscodeMock } from './mocks/vscode.js';
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
      '审批 G1 · consultant',
      '审批 G3 · consultant',
      '通知 A',
    ]);
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
