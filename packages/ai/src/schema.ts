import { z } from 'zod';

/** Stage key + prompt version pinned into the run ledger (docs/003 §2.2). */
export const REQUIREMENT_ANALYSIS_STAGE_KEY = 'requirement_analysis';
export const REQUIREMENT_ANALYSIS_PROMPT_VERSION = 'requirement-analysis/v1';

export const REQUIREMENT_ANALYSIS_OUTPUT_SCHEMA = z
  .object({
    summary: z.string().min(1),
    goals: z.array(z.string().min(1)),
    scope: z
      .object({
        inScope: z.array(z.string().min(1)),
        outOfScope: z.array(z.string().min(1)),
      })
      .strict(),
    assumptions: z.array(z.string().min(1)),
    openQuestions: z.array(z.string().min(1)),
    acceptanceCriteria: z
      .array(
        z
          .object({
            criterion: z.string().min(1),
            anchor: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    risks: z.array(z.string().min(1)),
  })
  .strict();
export type RequirementAnalysisOutput = z.infer<typeof REQUIREMENT_ANALYSIS_OUTPUT_SCHEMA>;

/** Demand snapshot handed to the stage (never includes credentials/local paths). */
export interface RequirementAnalysisInput {
  demand: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requester: { userId: string; orgUnit?: string };
    priority: string;
  };
}

export interface StageRunLedger {
  model: string;
  promptVersion: string;
  attempt: number;
  schemaOk: boolean;
  tokens: number;
  costUsd: number;
  durationMs: number;
}

export interface StageRunResult {
  output: RequirementAnalysisOutput;
  ledger: StageRunLedger;
}
