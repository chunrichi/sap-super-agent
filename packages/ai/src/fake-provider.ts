import type {
  CompletionRequest,
  CompletionResult,
  ChatMessage,
  ModelProvider,
} from './types.js';
import { REQUIREMENT_ANALYSIS_STAGE_KEY } from './schema.js';

export interface FakeModelProviderOptions {
  /** Scripted responses consumed in order; an Error makes `complete` reject. */
  responses?: Array<string | Error>;
  /** Deterministic per-stage text used when no scripted response is pending. */
  stageOutputs?: Record<string, string>;
}

const DEMAND_JSON_BLOCK = /<demand-json>\s*([\s\S]*?)\s*<\/demand-json>/;

interface DemandSnapshotLike {
  title?: unknown;
  description?: unknown;
  acceptanceCriteria?: unknown;
}

function extractDemandSnapshot(messages: readonly ChatMessage[]): DemandSnapshotLike {
  for (const message of messages) {
    const match = DEMAND_JSON_BLOCK.exec(message.content);
    if (match?.[1] === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (typeof parsed === 'object' && parsed !== null) return parsed as DemandSnapshotLike;
    } catch {
      // Not the demand block (e.g. an example payload); keep looking.
    }
  }
  return {};
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Deterministic, schema-valid requirement_analysis output for offline runs. */
export function fakeRequirementAnalysisOutput(messages: readonly ChatMessage[]): string {
  const demand = extractDemandSnapshot(messages);
  const title = typeof demand.title === 'string' && demand.title.length > 0 ? demand.title : null;
  const acceptanceCriteria = stringList(demand.acceptanceCriteria);
  const output = {
    summary: title === null ? '需求分析结果' : `${title} 的需求分析`,
    goals: title === null ? ['明确需求范围与验收标准'] : [`交付：${title}`],
    scope: { inScope: ['需求描述中列出的交付内容'], outOfScope: ['需求未提及的扩展功能'] },
    assumptions: ['需求描述完整，无需额外业务背景'],
    openQuestions: [],
    acceptanceCriteria:
      acceptanceCriteria.length > 0
        ? acceptanceCriteria.map((criterion) => ({ criterion, anchor: 'acceptanceCriteria' }))
        : [{ criterion: '交付内容满足需求描述', anchor: 'description' }],
    risks: ['上游需求后续变更可能导致返工'],
  };
  return JSON.stringify(output, null, 2);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function totalPromptTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

export class FakeModelProvider implements ModelProvider {
  readonly name = 'fake';
  private readonly responses: Array<string | Error>;
  private readonly stageOutputs: Record<string, string>;

  constructor(options: FakeModelProviderOptions = {}) {
    this.responses = options.responses === undefined ? [] : [...options.responses];
    this.stageOutputs = options.stageOutputs === undefined ? {} : { ...options.stageOutputs };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const scripted = this.responses.shift();
    if (scripted instanceof Error) throw scripted;
    const stageKey = request.metadata?.stageKey ?? REQUIREMENT_ANALYSIS_STAGE_KEY;
    const text =
      scripted ?? this.stageOutputs[stageKey] ?? fakeRequirementAnalysisOutput(request.messages);
    const promptTokens = totalPromptTokens(request.messages);
    const completionTokens = estimateTokens(text);
    return {
      text,
      model: request.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      costUsd: 0,
    };
  }
}
