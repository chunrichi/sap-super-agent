import type {
  CompletionRequest,
  CompletionResult,
  ChatMessage,
  ModelProvider,
} from './types.js';
import {
  INTAKE_STAGE_KEY,
  DEV_SPEC_STAGE_KEY,
  TEST_DOC_STAGE_KEY,
  KNOWLEDGE_ENTRY_STAGE_KEY,
  REQUIREMENT_ANALYSIS_STAGE_KEY,
} from './stages.js';

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

function fakeIntakeOutput(messages: readonly ChatMessage[]): string {
  const demand = extractDemandSnapshot(messages);
  const title = typeof demand.title === 'string' && demand.title.length > 0 ? demand.title : '需求';
  const description = typeof demand.description === 'string' ? demand.description : '';
  return JSON.stringify(
    {
      summary: `已受理：${title}`,
      openQuestions: description.length === 0 ? ['需求描述为空，需要补充业务背景'] : [],
      inScope: [description.length === 0 ? '待澄清' : description.slice(0, 200)],
    },
    null,
    2,
  );
}

function fakeDevSpecOutput(messages: readonly ChatMessage[]): string {
  const demand = extractDemandSnapshot(messages);
  const title = typeof demand.title === 'string' && demand.title.length > 0 ? demand.title : '需求';
  return JSON.stringify(
    {
      summary: `${title} 的开发说明`,
      changes: [
        {
          file: 'zsales_aggregate.prog.abap',
          description: '新增按销售组织汇总开票金额的取数逻辑',
        },
      ],
      testPlan: ['空结果返回 0', '金额与 MARA 一致'],
      risks: ['数据量大时需要分页'],
    },
    null,
    2,
  );
}

function fakeTestDocOutput(messages: readonly ChatMessage[]): string {
  const demand = extractDemandSnapshot(messages);
  const title = typeof demand.title === 'string' && demand.title.length > 0 ? demand.title : '需求';
  const criteria = stringList(demand.acceptanceCriteria);
  const cases = (criteria.length > 0 ? criteria : ['交付内容满足需求描述']).map(
    (criterion, index) => ({
      id: `TC-${String(index + 1).padStart(3, '0')}`,
      title: criterion,
      steps: ['准备测试数据', '执行取数程序', '核对输出'],
      expected: criterion,
    }),
  );
  return JSON.stringify(
    {
      summary: `${title} 的测试文档`,
      cases,
      environment: 'SAP 测试系统（虚构数据）',
    },
    null,
    2,
  );
}

function fakeKnowledgeEntryOutput(messages: readonly ChatMessage[]): string {
  const demand = extractDemandSnapshot(messages);
  const title = typeof demand.title === 'string' && demand.title.length > 0 ? demand.title : '需求';
  return JSON.stringify(
    {
      summary: `${title} 的验收归档`,
      tags: ['PDO', '取数'],
      decisions: ['按需求分析确认的范围交付', '遗留问题进入后续迭代'],
    },
    null,
    2,
  );
}

/** Deterministic per-stage output used by the fake provider (no network). */
export function fakeStageOutput(
  stageKey: string,
  messages: readonly ChatMessage[],
): string {
  switch (stageKey) {
    case INTAKE_STAGE_KEY:
      return fakeIntakeOutput(messages);
    case DEV_SPEC_STAGE_KEY:
      return fakeDevSpecOutput(messages);
    case TEST_DOC_STAGE_KEY:
      return fakeTestDocOutput(messages);
    case KNOWLEDGE_ENTRY_STAGE_KEY:
      return fakeKnowledgeEntryOutput(messages);
    case REQUIREMENT_ANALYSIS_STAGE_KEY:
    default:
      return fakeRequirementAnalysisOutput(messages);
  }
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
      scripted ?? this.stageOutputs[stageKey] ?? fakeStageOutput(stageKey, request.messages);
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
