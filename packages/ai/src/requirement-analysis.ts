import { readFileSync } from 'node:fs';
import {
  REQUIREMENT_ANALYSIS_OUTPUT_SCHEMA,
  REQUIREMENT_ANALYSIS_PROMPT_VERSION,
  REQUIREMENT_ANALYSIS_STAGE_KEY,
  type RequirementAnalysisInput,
  type StageRunLedger,
  type StageRunResult,
} from './schema.js';
import type { ChatMessage, ModelProvider } from './types.js';
import { DEFAULT_AI_MODEL } from './provider-from-env.js';

const PROMPT_URL = new URL('../prompts/requirement-analysis.md', import.meta.url);
const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/i;
const SYSTEM_PROMPT =
  '你是 SAP 研发交付流程的需求分析助手。只输出符合要求的单个 JSON 对象，不要输出解释文字或 Markdown 代码围栏。';

export class StageOutputError extends Error {
  readonly rawText: string;

  constructor(message: string, rawText: string) {
    super(message);
    this.name = 'StageOutputError';
    this.rawText = rawText;
  }
}

export interface RunRequirementAnalysisOptions {
  model?: string;
  attempt?: number;
}

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_URL, 'utf8');
}

function renderPrompt(input: RequirementAnalysisInput): string {
  return loadPromptTemplate()
    .replaceAll('{{promptVersion}}', REQUIREMENT_ANALYSIS_PROMPT_VERSION)
    .replaceAll('{{demandJson}}', JSON.stringify(input.demand, null, 2));
}

function extractJsonText(rawText: string): string {
  const fenced = FENCED_JSON.exec(rawText);
  const candidate = (fenced?.[1] ?? rawText).trim();
  if (candidate.length === 0) {
    throw new StageOutputError('requirement analysis output is empty', rawText);
  }
  return candidate;
}

function parseOutput(rawText: string): StageRunResult['output'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch (error) {
    if (error instanceof StageOutputError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new StageOutputError(`requirement analysis output is not valid JSON: ${detail}`, rawText);
  }
  const validated = REQUIREMENT_ANALYSIS_OUTPUT_SCHEMA.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => {
        const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new StageOutputError(
      `requirement analysis output does not match schema: ${issues}`,
      rawText,
    );
  }
  return validated.data;
}

function resolveModel(options: RunRequirementAnalysisOptions): string {
  if (options.model !== undefined && options.model.length > 0) return options.model;
  const fromEnv = process.env['SA_AI_MODEL']?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_AI_MODEL;
}

/**
 * Run the `requirement_analysis` server-AI stage: render the pinned prompt,
 * request JSON-only output, validate it and return the output + run ledger.
 */
export async function runRequirementAnalysisStage(
  input: RequirementAnalysisInput,
  provider: ModelProvider,
  options: RunRequirementAnalysisOptions = {},
): Promise<StageRunResult> {
  const model = resolveModel(options);
  const attempt = options.attempt ?? 1;
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: renderPrompt(input) },
  ];
  const startedAtMs = Date.now();
  const result = await provider.complete({
    model,
    messages,
    temperature: 0,
    metadata: { stageKey: REQUIREMENT_ANALYSIS_STAGE_KEY, attempt },
  });
  const output = parseOutput(result.text);
  const ledger: StageRunLedger = {
    model: result.model.length > 0 ? result.model : model,
    promptVersion: REQUIREMENT_ANALYSIS_PROMPT_VERSION,
    attempt,
    schemaOk: true,
    tokens: result.usage.totalTokens,
    costUsd: result.costUsd,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  };
  return { output, ledger };
}
