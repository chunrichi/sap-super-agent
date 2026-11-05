import type { ModelProvider } from './types.js';
import type {
  RequirementAnalysisInput,
  RequirementAnalysisOutput,
  StageRunResult,
} from './schema.js';
import { REQUIREMENT_ANALYSIS_STAGE_KEY } from './schema.js';
import { requireAiStageDefinition, runAiStage } from './stages.js';

// ---------------------------------------------------------------------------
// Backward-compatible wrapper for the `requirement_analysis` stage (H0 e2e and
// tests use it directly). H1 routes every server-AI stage through the generic
// registry in `stages.ts`.
// ---------------------------------------------------------------------------

export interface RunRequirementAnalysisOptions {
  model?: string;
  attempt?: number;
}

export async function runRequirementAnalysisStage(
  input: RequirementAnalysisInput,
  provider: ModelProvider,
  options: RunRequirementAnalysisOptions = {},
): Promise<StageRunResult> {
  const definition = requireAiStageDefinition(REQUIREMENT_ANALYSIS_STAGE_KEY);
  const result = await runAiStage(definition, {
    stageKey: definition.key,
    stageName: definition.name,
    promptVersion: definition.promptVersion,
    demand: input.demand,
    upstream: [],
  }, provider, options);
  return { output: result.output as RequirementAnalysisOutput, ledger: result.ledger };
}
