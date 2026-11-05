import { describe, expect, it } from 'vitest';
import {
  evaluateGoldenSet,
  type GoldenCase,
  type GoldenChecklistResult,
  type GoldenSuite,
  type GoldenThresholds,
} from '../src/index.js';

const thresholds: GoldenThresholds = {
  schemaPassRateMin: 0.9,
  checklistPassRateMin: 0.8,
  referenceIntegrityMin: 0.8,
  humanEditRateMaxForAuto: 0.15,
  maxStageCostUsd: 0.05,
};

function goldenCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: 'g-1',
    title: 'R-3001 测试用例',
    description: '虚构需求',
    acceptanceCriteria: ['金额一致'],
    expected: { schemaPass: true, checklist: { sections_present: true, acceptance_covered: true } },
    humanBaseline: { editedLines: 1, totalLines: 10, summary: '小幅修改' },
    ...overrides,
  };
}

function suite(cases: GoldenCase[]): GoldenSuite {
  return { suiteId: 'test', version: 1, promptVersion: 'requirement-analysis/v1', cases };
}

function checklist(overrides: Partial<GoldenChecklistResult> = {}): GoldenChecklistResult {
  return {
    passed: true,
    results: [
      { key: 'sections_present', passed: true, detail: 'ok' },
      { key: 'acceptance_covered', passed: true, detail: 'ok' },
    ],
    failures: [],
    ...overrides,
  };
}

const ledger = {
  model: 'fake-model',
  promptVersion: 'requirement-analysis/v1',
  attempt: 1,
  schemaOk: true,
  tokens: 100,
  costUsd: 0,
  durationMs: 0,
};

describe('golden set evaluation (docs/009 §3)', () => {
  it('scores cases and recommends auto below the human-edit threshold', async () => {
    const report = await evaluateGoldenSet(
      suite([goldenCase(), goldenCase({ id: 'g-2', humanBaseline: { editedLines: 2, totalLines: 20, summary: 'x' } })]),
      thresholds,
      {
        runStage: async () => ({ output: { summary: 'x' }, ledger }),
        evaluateChecklist: () => checklist(),
      },
      { providerName: 'fake', model: 'fake-model' },
    );
    expect(report.metrics).toMatchObject({
      caseCount: 2,
      schemaPassRate: 1,
      checklistPassRate: 1,
      referenceIntegrity: 1,
      humanEditRate: 0.1,
      totalTokens: 200,
      costPerCaseUsd: 0,
    });
    expect(report.autonomyRecommendation.mode).toBe('auto');
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.cases[0]).toMatchObject({ id: 'g-1', expectedMatch: true });
  });

  it('recommends observe when the human edit rate reaches the threshold', async () => {
    const report = await evaluateGoldenSet(
      suite([goldenCase({ humanBaseline: { editedLines: 3, totalLines: 10, summary: 'x' } })]),
      thresholds,
      {
        runStage: async () => ({ output: {}, ledger }),
        evaluateChecklist: () => checklist(),
      },
      { providerName: 'fake', model: 'fake-model' },
    );
    expect(report.autonomyRecommendation.mode).toBe('observe');
    expect(report.autonomyRecommendation.reason).toContain('15%');
  });

  it('fails the report on threshold breaches and fixture mismatches', async () => {
    const report = await evaluateGoldenSet(
      suite([goldenCase({ id: 'g-bad', expected: { schemaPass: true, checklist: { sections_present: true, acceptance_covered: false } } })]),
      thresholds,
      {
        runStage: async () => ({ output: {}, ledger: { ...ledger, schemaOk: false } }),
        evaluateChecklist: () => checklist({ passed: false }),
      },
      { providerName: 'fake', model: 'fake-model' },
    );
    expect(report.passed).toBe(false);
    expect(report.metrics.schemaPassRate).toBe(0);
    expect(report.metrics.checklistPassRate).toBe(0);
    expect(report.failures.join(' ')).toContain('schema pass rate');
    expect(report.failures.join(' ')).toContain('expectation mismatch');
    expect(report.cases[0]?.expectedMatch).toBe(false);
  });

  it('keeps reports deterministic (no timestamps/durations)', async () => {
    const run = () =>
      evaluateGoldenSet(
        suite([goldenCase()]),
        thresholds,
        {
          runStage: async () => ({ output: { summary: 'x' }, ledger }),
          evaluateChecklist: () => checklist(),
        },
        { providerName: 'fake', model: 'fake-model' },
      );
    const first = JSON.stringify(await run());
    const second = JSON.stringify(await run());
    expect(first).toBe(second);
  });
});
