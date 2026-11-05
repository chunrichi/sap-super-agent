import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AI_MODEL,
  caseToRequirementAnalysisInput,
  evaluateGoldenSet,
  requireAiStageDefinition,
  runAiStage,
  type GoldenCase,
  type GoldenChecklistResult,
  type GoldenReport,
  type GoldenSuite,
  type GoldenThresholds,
  type ModelProvider,
} from '@sap-superagent/ai';
import { evaluateChecklist } from '@sap-superagent/core';
import type { StageTemplate } from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// `pnpm eval:golden` wiring (H1 task book §1.6, docs/009 §3): runs the pinned
// requirement_analysis stage over `evals/golden/cases.json`, evaluates the real
// core checklist and writes a deterministic `evals/report.json`. The script only
// recommends auto/observe; templates are never mutated.
// ---------------------------------------------------------------------------

/** Deterministic model id used under the fake provider so the report is stable. */
export const EVAL_FAKE_MODEL = 'fake-model';

const EVAL_STAGE_TEMPLATE: StageTemplate = {
  key: 'requirement_analysis',
  name: '需求分析',
  executorKind: 'server-ai',
  inputArtifactKinds: [],
  outputArtifactKind: 'requirement_analysis',
  gate: 'none',
  maxAttempts: 2,
  autonomy: 'observe',
  requiredRoles: [],
  checklist: ['sections_present', 'acceptance_covered'],
};

export interface GoldenSuiteFiles {
  suite: GoldenSuite;
  thresholds: GoldenThresholds;
}

export function loadGoldenSuite(rootDir: string): GoldenSuiteFiles {
  const casesPath = join(rootDir, 'evals', 'golden', 'cases.json');
  const thresholdsPath = join(rootDir, 'evals', 'thresholds.json');
  const suite = JSON.parse(readFileSync(casesPath, 'utf8')) as GoldenSuite;
  const thresholds = JSON.parse(readFileSync(thresholdsPath, 'utf8')) as GoldenThresholds;
  return { suite, thresholds };
}

function evaluateCaseChecklist(
  testCase: GoldenCase,
  output: unknown,
): GoldenChecklistResult {
  return evaluateChecklist(EVAL_STAGE_TEMPLATE.checklist, {
    stage: EVAL_STAGE_TEMPLATE,
    demand: { acceptanceCriteria: testCase.acceptanceCriteria },
    outputText: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
    outputJson: output,
    inputRefs: [],
    latestInputRefs: new Map(),
    outputStale: false,
  });
}

export interface RunGoldenEvaluationOptions {
  provider: ModelProvider;
  providerName?: string;
  model?: string;
}

/** Run the golden suite with the given provider and build the report. */
export async function runGoldenEvaluation(
  rootDir: string,
  options: RunGoldenEvaluationOptions,
): Promise<GoldenReport> {
  const { suite, thresholds } = loadGoldenSuite(rootDir);
  const definition = requireAiStageDefinition('requirement_analysis');
  const model = options.model ?? (options.provider.name === 'fake' ? EVAL_FAKE_MODEL : DEFAULT_AI_MODEL);
  return evaluateGoldenSet(
    suite,
    thresholds,
    {
      runStage: async (testCase) => {
        const input = caseToRequirementAnalysisInput(testCase, definition.promptVersion);
        const result = await runAiStage(
          definition,
          {
            stageKey: definition.key,
            stageName: definition.name,
            promptVersion: definition.promptVersion,
            demand: input.demand,
            upstream: [],
          },
          options.provider,
          { model },
        );
        return result;
      },
      evaluateChecklist: (testCase, output) => evaluateCaseChecklist(testCase, output),
    },
    { providerName: options.providerName ?? options.provider.name, model },
  );
}

/** Stable JSON serialization used for the committed report and its snapshot test. */
export function serializeGoldenReport(report: GoldenReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
