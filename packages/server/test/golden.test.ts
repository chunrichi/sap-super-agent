import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@sap-superagent/ai';
import {
  EVAL_FAKE_MODEL,
  loadGoldenSuite,
  runGoldenEvaluation,
  serializeGoldenReport,
} from '../src/evals/golden.js';

// ---------------------------------------------------------------------------
// `pnpm eval:golden` stability: under the fake provider the committed
// evals/report.json must be reproduced byte-for-byte (H1 §1.6 / docs/009 §3).
// ---------------------------------------------------------------------------

const rootDir = resolve(process.cwd(), '../..');

describe('golden set report (evals/report.json)', () => {
  it('loads the committed suite and thresholds', () => {
    const { suite, thresholds } = loadGoldenSuite(rootDir);
    expect(suite.cases.length).toBeGreaterThanOrEqual(20);
    expect(suite.cases.length).toBeLessThanOrEqual(30);
    expect(thresholds.humanEditRateMaxForAuto).toBe(0.15);
    for (const testCase of suite.cases) {
      expect(testCase.title.length).toBeGreaterThan(0);
      expect(testCase.humanBaseline.totalLines).toBeGreaterThan(0);
      expect(testCase.humanBaseline.summary.length).toBeGreaterThan(0);
      expect(testCase.expected.schemaPass).toBe(true);
    }
  });

  it('reproduces the committed deterministic report with the fake provider', async () => {
    const first = await runGoldenEvaluation(rootDir, {
      provider: new FakeModelProvider(),
      providerName: 'fake',
      model: EVAL_FAKE_MODEL,
    });
    const serialized = serializeGoldenReport(first);
    const committed = readFileSync(join(rootDir, 'evals/report.json'), 'utf8');
    expect(serialized).toBe(committed);
    expect(first.passed).toBe(true);
    expect(first.metrics.schemaPassRate).toBe(1);
    expect(first.metrics.checklistPassRate).toBe(1);
    expect(first.metrics.referenceIntegrity).toBe(1);
    expect(first.metrics.humanEditRate).toBeLessThan(0.15);
    expect(first.autonomyRecommendation.mode).toBe('auto');
    expect(first.cases).toHaveLength(first.metrics.caseCount);
  });

  it('is reproducible across runs (fake provider, offline)', async () => {
    const options = {
      provider: new FakeModelProvider(),
      providerName: 'fake',
      model: EVAL_FAKE_MODEL,
    } as const;
    const first = serializeGoldenReport(await runGoldenEvaluation(rootDir, options));
    const second = serializeGoldenReport(await runGoldenEvaluation(rootDir, options));
    expect(second).toBe(first);
  });
});
