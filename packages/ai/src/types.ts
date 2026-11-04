// Provider-agnostic model contract used by server-side AI stages.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionMetadata {
  stageKey?: string;
  attempt?: number;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  metadata?: CompletionMetadata;
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: CompletionUsage;
  costUsd: number;
}

export interface ModelProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
