import type { CompletionRequest, CompletionResult, ModelProvider } from './types.js';

export interface OpenAiCompatibleOptions {
  /** Base URL such as `https://api.deepseek.com/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAiChatCompletionPayload {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** BYOK provider for any OpenAI-compatible `/chat/completions` endpoint. */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model.length > 0 ? request.model : (this.defaultModel ?? '');
    if (model.length === 0) {
      throw new Error('model provider requires a model name (set SA_AI_MODEL)');
    }
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      response_format: { type: 'json_object' },
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`model provider request failed: ${detail}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail.length > 0 ? `: ${detail.slice(0, 300)}` : '';
      throw new Error(`model provider returned HTTP ${response.status}${suffix}`);
    }

    const payload = (await response.json()) as OpenAiChatCompletionPayload;
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('model provider returned an empty completion');
    }
    const promptTokens = tokenCount(payload.usage?.prompt_tokens);
    const completionTokens = tokenCount(payload.usage?.completion_tokens);
    const reportedTotal = tokenCount(payload.usage?.total_tokens);
    return {
      text,
      model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens:
          reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens,
      },
      costUsd: 0,
    };
  }
}
