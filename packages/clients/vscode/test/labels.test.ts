import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_KINDS,
  NOTIFICATION_KINDS,
  ROLES,
  TASK_STATES,
} from '@sap-superagent/protocol';
import {
  ARTIFACT_KIND_LABELS,
  NOTIFICATION_KIND_LABELS,
  ROLE_LABELS,
  TASK_STATE_LABELS,
  artifactKindLabel,
  formatTimestamp,
  notificationKindLabel,
  roleLabel,
  taskStateLabel,
} from '../src/labels.js';

describe('Chinese protocol labels', () => {
  it('covers every task state with a Chinese label', () => {
    expect(Object.keys(TASK_STATE_LABELS).sort()).toEqual([...TASK_STATES].sort());
    for (const state of TASK_STATES) {
      expect(taskStateLabel(state)).not.toBe(state);
      expect(taskStateLabel(state)).toMatch(/[\u4e00-\u9fff]/);
    }
    expect(taskStateLabel('pending')).toBe('待领取');
    expect(taskStateLabel('in_progress')).toBe('进行中');
    expect(taskStateLabel('completed')).toBe('已完成');
    expect(taskStateLabel('failed')).toBe('失败');
    expect(taskStateLabel('cancelled')).toBe('已取消');
    expect(taskStateLabel('claimed')).toBe('已领取');
  });

  it('covers every gate role with the wording from docs/005', () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...ROLES].sort());
    expect(roleLabel('consultant')).toBe('需求顾问');
    expect(roleLabel('developer')).toBe('开发');
    expect(roleLabel('requester')).toBe('需求方');
    expect(roleLabel('ops')).toBe('运维');
  });

  it('covers every notification kind', () => {
    expect(Object.keys(NOTIFICATION_KIND_LABELS).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    expect(notificationKindLabel('approval.requested')).toBe('审批请求');
    expect(notificationKindLabel('stage.waiting_human')).toBe('阶段等待人工确认');
    expect(notificationKindLabel('stage.failed')).toBe('阶段失败');
  });

  it('covers every artifact kind', () => {
    expect(Object.keys(ARTIFACT_KIND_LABELS).sort()).toEqual([...ARTIFACT_KINDS].sort());
    expect(artifactKindLabel('code_change')).toBe('代码变更');
  });
});

describe('formatTimestamp', () => {
  it('renders local wall-clock time in a compact form', () => {
    expect(formatTimestamp('2026-11-05T00:00:00.000Z', { timeZone: 'Asia/Shanghai' })).toBe(
      '2026-11-05 08:00',
    );
    expect(formatTimestamp('2026-11-05T00:00:00.000Z', { timeZone: 'UTC' })).toBe(
      '2026-11-05 00:00',
    );
  });

  it('normalizes offsets to the requested zone', () => {
    expect(formatTimestamp('2026-11-05T08:00:00+08:00', { timeZone: 'UTC' })).toBe(
      '2026-11-05 00:00',
    );
  });

  it('keeps empty and invalid values verbatim instead of Invalid Date', () => {
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp(null)).toBe('');
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});
