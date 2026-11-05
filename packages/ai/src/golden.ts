import type { ModelProvider } from './types.js';
import type { StageRunLedger } from './schema.js';

// ---------------------------------------------------------------------------
// Golden-set evaluation core (docs/009 §3, H1 task book §1.6).
//
// This module is deliberately orchestration-free: callers inject how a case is
// executed (`runStage`) and how its checklist is evaluated. The `eval:golden`
// script wires the real requirement-analysis stage + core checklist; tests can
// inject deterministic fakes. Reports never contain timestamps so committed
// snapshots stay stable under the fake provider.
// ---------------------------------------------------------------------------

export interface GoldenChecklistAssertion {
  key: string;
  passed: boolean;
  detail: string;
}

export interface GoldenChecklistResult {
  passed: boolean;
  results: GoldenChecklistAssertion[];
  failures: string[];
}

export interface GoldenCase {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /** Expected results recorded with the fixture (regression baseline). */
  expected: {
    schemaPass: boolean;
    checklist: Record<string, boolean>;
  };
  /** Human baseline summary used to estimate the manual-edit ratio. */
  humanBaseline: {
    editedLines: number;
    totalLines: number;
    summary: string;
  };
}

export interface GoldenSuite {
  suiteId: string;
  version: number;
  promptVersion: string;
  cases: GoldenCase[];
}

export interface GoldenThresholds {
  schemaPassRateMin: number;
  checklistPassRateMin: number;
  referenceIntegrityMin: number;
  humanEditRateMaxForAuto: number;
  maxStageCostUsd: number;
}

export interface GoldenStageRunResult {
  output: unknown;
  ledger: StageRunLedger;
}

export interface GoldenEvaluationHooks {
  /** Run the pinned server-AI stage for one fixture (prompt/model are caller owned). */
  runStage: (testCase: GoldenCase) => Promise<GoldenStageRunResult>;
  /** Evaluate the stage checklist against the produced output. */
  evaluateChecklist: (testCase: GoldenCase, output: unknown) => GoldenChecklistResult;
}

export interface GoldenCaseResult {
  id: string;
  title: string;
  schemaPass: boolean;
  checklistPass: boolean;
  referenceIntegrity: boolean;
  checklistAssertions: GoldenChecklistAssertion[];
  expectedMatch: boolean;
  humanEditRate: number;
  editedLines: number;
  totalLines: number;
  tokens: number;
  costUsd: number;
  model: string;
  promptVersion: string;
}

export interface GoldenMetrics {
  caseCount: number;
  schemaPassRate: number;
  checklistPassRate: number;
  referenceIntegrity: number;
  humanEditRate: number;
  totalTokens: number;
  totalCostUsd: number;
  costPerCaseUsd: number;
}

export interface GoldenAutonomyRecommendation {
  mode: 'auto' | 'observe';
  reason: string;
}

export interface GoldenReport {
  version: 1;
  suiteId: string;
  promptVersion: string;
  provider: string;
  model: string;
  metrics: GoldenMetrics;
  autonomyRecommendation: GoldenAutonomyRecommendation;
  thresholds: GoldenThresholds;
  passed: boolean;
  failures: string[];
  cases: GoldenCaseResult[];
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(passed: number, total: number): number {
  return total === 0 ? 1 : round(passed / total);
}

function expectedMatches(
  testCase: GoldenCase,
  schemaPass: boolean,
  checklist: GoldenChecklistResult,
): boolean {
  if (schemaPass !== testCase.expected.schemaPass) return false;
  for (const [key, expected] of Object.entries(testCase.expected.checklist)) {
    const actual = checklist.results.find((result) => result.key === key);
    if (actual === undefined || actual.passed !== expected) return false;
  }
  return true;
}

function scoreCase(
  testCase: GoldenCase,
  schemaPass: boolean,
  checklist: GoldenChecklistResult,
  ledger: StageRunLedger,
): GoldenCaseResult {
  const referenceIntegrity =
    checklist.results.find((result) => result.key === 'acceptance_covered')?.passed ?? false;
  const { editedLines, totalLines } = testCase.humanBaseline;
  return {
    id: testCase.id,
    title: testCase.title,
    schemaPass,
    checklistPass: checklist.passed,
    referenceIntegrity,
    checklistAssertions: checklist.results,
    expectedMatch: expectedMatches(testCase, schemaPass, checklist),
    humanEditRate: totalLines === 0 ? 0 : round(editedLines / totalLines),
    editedLines,
    totalLines,
    tokens: ledger.tokens,
    costUsd: ledger.costUsd,
    model: ledger.model,
    promptVersion: ledger.promptVersion,
  };
}

/**
 * Evaluate the golden set and build a deterministic report (no timestamps, no
 * durations). The script only *recommends* autonomy; templates are never
 * mutated here.
 */
export async function evaluateGoldenSet(
  suite: GoldenSuite,
  thresholds: GoldenThresholds,
  hooks: GoldenEvaluationHooks,
  options: { providerName: string; model: string },
): Promise<GoldenReport> {
  const cases: GoldenCaseResult[] = [];
  for (const testCase of suite.cases) {
    const result = await hooks.runStage(testCase);
    const checklist = hooks.evaluateChecklist(testCase, result.output);
    cases.push(scoreCase(testCase, result.ledger.schemaOk, checklist, result.ledger));
  }

  const caseCount = cases.length;
  const schemaPassed = cases.filter((entry) => entry.schemaPass).length;
  const checklistPassed = cases.filter((entry) => entry.checklistPass).length;
  const referencePassed = cases.filter((entry) => entry.referenceIntegrity).length;
  const expectedMatched = cases.filter((entry) => entry.expectedMatch).length;
  const editedLines = cases.reduce((total, entry) => total + entry.editedLines, 0);
  const totalLines = cases.reduce((total, entry) => total + entry.totalLines, 0);
  const totalTokens = cases.reduce((total, entry) => total + entry.tokens, 0);
  const totalCostUsd = cases.reduce((total, entry) => total + entry.costUsd, 0);

  const metrics: GoldenMetrics = {
    caseCount,
    schemaPassRate: ratio(schemaPassed, caseCount),
    checklistPassRate: ratio(checklistPassed, caseCount),
    referenceIntegrity: ratio(referencePassed, caseCount),
    humanEditRate: totalLines === 0 ? 0 : round(editedLines / totalLines),
    totalTokens,
    totalCostUsd: round(totalCostUsd, 6),
    costPerCaseUsd: caseCount === 0 ? 0 : round(totalCostUsd / caseCount, 6),
  };

  const failures: string[] = [];
  if (metrics.schemaPassRate < thresholds.schemaPassRateMin) {
    failures.push(
      `schema pass rate ${metrics.schemaPassRate} < ${thresholds.schemaPassRateMin}`,
    );
  }
  if (metrics.checklistPassRate < thresholds.checklistPassRateMin) {
    failures.push(
      `checklist pass rate ${metrics.checklistPassRate} < ${thresholds.checklistPassRateMin}`,
    );
  }
  if (metrics.referenceIntegrity < thresholds.referenceIntegrityMin) {
    failures.push(
      `reference integrity ${metrics.referenceIntegrity} < ${thresholds.referenceIntegrityMin}`,
    );
  }
  if (metrics.costPerCaseUsd > thresholds.maxStageCostUsd) {
    failures.push(
      `cost per case $${metrics.costPerCaseUsd} > $${thresholds.maxStageCostUsd}`,
    );
  }
  if (expectedMatched !== caseCount) {
    failures.push(`${caseCount - expectedMatched} fixture expectation mismatch(es)`);
  }

  const autonomyRecommendation: GoldenAutonomyRecommendation =
    metrics.humanEditRate < thresholds.humanEditRateMaxForAuto
      ? {
          mode: 'auto',
          reason: `aggregate human edit rate ${(metrics.humanEditRate * 100).toFixed(1)}% is below the ${(thresholds.humanEditRateMaxForAuto * 100).toFixed(0)}% auto threshold`,
        }
      : {
          mode: 'observe',
          reason: `aggregate human edit rate ${(metrics.humanEditRate * 100).toFixed(1)}% is at or above the ${(thresholds.humanEditRateMaxForAuto * 100).toFixed(0)}% auto threshold; keep the stage on observe`,
        };

  return {
    version: 1,
    suiteId: suite.suiteId,
    promptVersion: suite.promptVersion,
    provider: options.providerName,
    model: options.model,
    metrics,
    autonomyRecommendation,
    thresholds,
    passed: failures.length === 0,
    failures,
    cases,
  };
}

/** Build a `GoldenCase` input shape for `runRequirementAnalysisStage`. */
export function caseToRequirementAnalysisInput(
  testCase: GoldenCase,
  promptVersion: string,
): {
  demand: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requester: { userId: string };
    priority: string;
  };
  promptVersion: string;
} {
  return {
    promptVersion,
    demand: {
      id: `eval-${testCase.id}`,
      title: testCase.title,
      description: testCase.description,
      acceptanceCriteria: testCase.acceptanceCriteria,
      requester: { userId: 'EVAL' },
      priority: 'normal',
    },
  };
}

export type { ModelProvider };
