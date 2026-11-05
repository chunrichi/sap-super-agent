import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ArtifactKind } from '@sap-superagent/protocol';
import type { ModelProvider } from './types.js';
import { StageOutputError, parseStageOutput } from './json-output.js';
import { DEFAULT_AI_MODEL } from './provider-from-env.js';
import {
  REQUIREMENT_ANALYSIS_OUTPUT_SCHEMA,
  REQUIREMENT_ANALYSIS_PROMPT_VERSION,
  REQUIREMENT_ANALYSIS_STAGE_KEY,
  type StageRunLedger,
} from './schema.js';

export { REQUIREMENT_ANALYSIS_STAGE_KEY };

// ---------------------------------------------------------------------------
// Server-AI stage registry (docs/003 §6 "AI 阶段" extension point, H1 §1.1).
//
// The stage runner no longer hard-codes `requirement_analysis`: a template
// stage with `executorKind: server-ai` is resolved by its stage key here. Every
// definition declares its prompt, output artifact kind and zod response schema;
// the shared runner renders the prompt, calls the model, validates JSON and
// returns the output + run ledger (docs/003 §2.2).
// ---------------------------------------------------------------------------

export const INTAKE_STAGE_KEY = 'intake';
export const DEV_SPEC_STAGE_KEY = 'dev_spec';
export const TEST_DOC_STAGE_KEY = 'test_doc';
export const KNOWLEDGE_ENTRY_STAGE_KEY = 'knowledge_entry';

export const INTAKE_OUTPUT_SCHEMA = z
  .object({
    summary: z.string().min(1),
    openQuestions: z.array(z.string().min(1)),
    inScope: z.array(z.string().min(1)),
  })
  .strict();
export type IntakeOutput = z.infer<typeof INTAKE_OUTPUT_SCHEMA>;

export const DEV_SPEC_OUTPUT_SCHEMA = z
  .object({
    summary: z.string().min(1),
    changes: z
      .array(
        z
          .object({
            file: z.string().min(1),
            description: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    testPlan: z.array(z.string().min(1)),
    risks: z.array(z.string().min(1)),
  })
  .strict();
export type DevSpecOutput = z.infer<typeof DEV_SPEC_OUTPUT_SCHEMA>;

export const TEST_DOC_OUTPUT_SCHEMA = z
  .object({
    summary: z.string().min(1),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1),
            steps: z.array(z.string().min(1)),
            expected: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    environment: z.string().min(1),
  })
  .strict();
export type TestDocOutput = z.infer<typeof TEST_DOC_OUTPUT_SCHEMA>;

export const KNOWLEDGE_ENTRY_OUTPUT_SCHEMA = z
  .object({
    summary: z.string().min(1),
    tags: z.array(z.string().min(1)),
    decisions: z.array(z.string().min(1)),
  })
  .strict();
export type KnowledgeEntryOutput = z.infer<typeof KNOWLEDGE_ENTRY_OUTPUT_SCHEMA>;

/** Serialized upstream artifact handed to an AI stage (never credentials/paths). */
export interface AiStageUpstreamArtifact {
  kind: ArtifactKind;
  artifactId: string;
  version: number;
  contentType: string;
  /** UTF-8 content; callers decide how much to include. */
  contentText: string;
}

export interface AiStageInput {
  stageKey: string;
  stageName: string;
  promptVersion: string;
  demand: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requester: { userId: string; orgUnit?: string };
    priority: string;
  };
  upstream: AiStageUpstreamArtifact[];
}

export interface AiStageDefinition<TOutput = unknown> {
  key: string;
  name: string;
  promptVersion: string;
  promptUrl: URL;
  outputArtifactKind: ArtifactKind;
  outputSchema: z.ZodType<TOutput>;
}

function promptUrl(file: string): URL {
  return new URL(`../prompts/${file}`, import.meta.url);
}

export const AI_STAGE_DEFINITIONS: Readonly<Record<string, AiStageDefinition>> = {
  [INTAKE_STAGE_KEY]: {
    key: INTAKE_STAGE_KEY,
    name: '受理与澄清',
    promptVersion: 'intake/v1',
    promptUrl: promptUrl('intake.md'),
    outputArtifactKind: 'free_note',
    outputSchema: INTAKE_OUTPUT_SCHEMA,
  },
  [REQUIREMENT_ANALYSIS_STAGE_KEY]: {
    key: REQUIREMENT_ANALYSIS_STAGE_KEY,
    name: '需求分析',
    promptVersion: REQUIREMENT_ANALYSIS_PROMPT_VERSION,
    promptUrl: promptUrl('requirement-analysis.md'),
    outputArtifactKind: 'requirement_analysis',
    outputSchema: REQUIREMENT_ANALYSIS_OUTPUT_SCHEMA,
  },
  [DEV_SPEC_STAGE_KEY]: {
    key: DEV_SPEC_STAGE_KEY,
    name: '开发说明',
    promptVersion: 'dev-spec/v1',
    promptUrl: promptUrl('dev-spec.md'),
    outputArtifactKind: 'dev_spec',
    outputSchema: DEV_SPEC_OUTPUT_SCHEMA,
  },
  [TEST_DOC_STAGE_KEY]: {
    key: TEST_DOC_STAGE_KEY,
    name: '测试文档',
    promptVersion: 'test-doc/v1',
    promptUrl: promptUrl('test-doc.md'),
    outputArtifactKind: 'test_doc',
    outputSchema: TEST_DOC_OUTPUT_SCHEMA,
  },
  [KNOWLEDGE_ENTRY_STAGE_KEY]: {
    key: KNOWLEDGE_ENTRY_STAGE_KEY,
    name: '知识归档',
    promptVersion: 'knowledge-entry/v1',
    promptUrl: promptUrl('knowledge-entry.md'),
    outputArtifactKind: 'knowledge_entry',
    outputSchema: KNOWLEDGE_ENTRY_OUTPUT_SCHEMA,
  },
};

export function aiStageDefinition(stageKey: string): AiStageDefinition | undefined {
  return AI_STAGE_DEFINITIONS[stageKey];
}

/** Fallback used when a template stage key is not a registry key. */
const BY_OUTPUT_ARTIFACT_KIND: Readonly<Record<string, string>> = {
  free_note: INTAKE_STAGE_KEY,
  requirement_analysis: REQUIREMENT_ANALYSIS_STAGE_KEY,
  dev_spec: DEV_SPEC_STAGE_KEY,
  test_doc: TEST_DOC_STAGE_KEY,
  knowledge_entry: KNOWLEDGE_ENTRY_STAGE_KEY,
};

/**
 * Resolve the AI definition for a template stage: stage key first, then the
 * declared output artifact kind (templates may name stages freely, e.g.
 * `acceptance_archive` producing `knowledge_entry`).
 */
export function resolveAiStageDefinition(
  stageKey: string,
  outputArtifactKind: ArtifactKind,
): AiStageDefinition | undefined {
  const byKey = AI_STAGE_DEFINITIONS[stageKey];
  if (byKey !== undefined) return byKey;
  const fallbackKey = BY_OUTPUT_ARTIFACT_KIND[outputArtifactKind];
  return fallbackKey === undefined ? undefined : AI_STAGE_DEFINITIONS[fallbackKey];
}

export function requireAiStageDefinition(stageKey: string): AiStageDefinition {
  const definition = aiStageDefinition(stageKey);
  if (definition === undefined) {
    throw new Error(`no server-AI stage registered for stage key "${stageKey}"`);
  }
  return definition;
}

// ---------------------------------------------------------------------------
// Generic server-AI stage runner (docs/003 §2.2): render the pinned prompt,
// request JSON-only output, validate against the stage response schema and
// return the output plus the run ledger. Checklist evaluation happens in the
// server (core/checklist) so failed assertions never persist an artifact.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  '你是 SAP 研发交付流程中的结构化文档助手。只输出符合要求的单个 JSON 对象，不要输出解释文字或 Markdown 代码围栏。';

/**
 * The fixed system instruction for every structured stage. Exported so the
 * S5 SAP-batch executor can put the *same* instruction into the job payload
 * instead of re-deriving prompt text in ABAP (docs/003 §4.8: prompt rendered by
 * the control plane only).
 */
export const AI_STAGE_SYSTEM_PROMPT = SYSTEM_PROMPT;

export interface RunAiStageOptions {
  model?: string;
  attempt?: number;
}

export interface AiStageRunResult<T> {
  output: T;
  ledger: StageRunLedger;
}

let cachedDefinitionPrompts = new Map<string, string>();

function loadPrompt(definition: AiStageDefinition): string {
  const cached = cachedDefinitionPrompts.get(definition.key);
  if (cached !== undefined) return cached;
  const text = readFileSync(definition.promptUrl, 'utf8');
  cachedDefinitionPrompts.set(definition.key, text);
  return text;
}

/** Only used by tests that want to prove prompt caching does not leak state. */
export function resetPromptCache(): void {
  cachedDefinitionPrompts = new Map();
}

export function renderAiStagePrompt(definition: AiStageDefinition, input: AiStageInput): string {
  const upstream = {
    artifacts: input.upstream.map((artifact) => ({
      kind: artifact.kind,
      artifactId: artifact.artifactId,
      version: artifact.version,
      contentType: artifact.contentType,
      content: artifact.contentText,
    })),
  };
  return loadPrompt(definition)
    .replaceAll('{{promptVersion}}', definition.promptVersion)
    .replaceAll('{{stageName}}', input.stageName)
    .replaceAll('{{demandJson}}', JSON.stringify(input.demand, null, 2))
    .replaceAll('{{upstreamJson}}', JSON.stringify(upstream, null, 2));
}

/** Chat messages for one structured stage run (single source for all executors). */
export interface AiStageMessages {
  /** Fixed system instruction (see {@link AI_STAGE_SYSTEM_PROMPT}). */
  systemPrompt: string;
  /** Rendered user prompt. */
  prompt: string;
}

/**
 * Build the messages of a stage run. The local `runAiStage` provider and the
 * S5 SAP-batch job payload both use this so the prompt never diverges between
 * executors (docs/003 §4.8).
 */
export function renderAiStageMessages(
  definition: AiStageDefinition,
  input: AiStageInput,
): AiStageMessages {
  return {
    systemPrompt: AI_STAGE_SYSTEM_PROMPT,
    prompt: renderAiStagePrompt(definition, input),
  };
}

function resolveModel(options: RunAiStageOptions): string {
  if (options.model !== undefined && options.model.length > 0) return options.model;
  const fromEnv = process.env['SA_AI_MODEL']?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_AI_MODEL;
}

export async function runAiStage<T>(
  definition: AiStageDefinition<T>,
  input: AiStageInput,
  provider: ModelProvider,
  options: RunAiStageOptions = {},
): Promise<AiStageRunResult<T>> {
  const model = resolveModel(options);
  const attempt = options.attempt ?? 1;
  const rendered = renderAiStageMessages(definition, input);
  const messages = [
    { role: 'system' as const, content: rendered.systemPrompt },
    { role: 'user' as const, content: rendered.prompt },
  ];
  const startedAtMs = Date.now();
  const result = await provider.complete({
    model,
    messages,
    temperature: 0,
    metadata: { stageKey: definition.key, attempt },
  });
  let output: T;
  try {
    output = parseStageOutput(definition.outputSchema, result.text, definition.name);
  } catch (error) {
    if (error instanceof StageOutputError) {
      // Keep usage accounting even when the model returned invalid JSON.
      error.model = result.model.length > 0 ? result.model : model;
      error.tokens = result.usage.totalTokens;
      error.costUsd = result.costUsd;
      error.promptVersion = definition.promptVersion;
    }
    throw error;
  }
  const ledger: StageRunLedger = {
    model: result.model.length > 0 ? result.model : model,
    promptVersion: definition.promptVersion,
    attempt,
    schemaOk: true,
    tokens: result.usage.totalTokens,
    costUsd: result.costUsd,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  };
  return { output, ledger };
}
