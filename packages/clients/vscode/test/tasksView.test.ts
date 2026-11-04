import { afterEach, describe, expect, it } from 'vitest';
import {
  INBOX_GROUP_LABELS,
  TaskInboxProvider,
  buildInboxNodes,
  describeTask,
  emptyInboxData,
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
