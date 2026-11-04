import { describe, expect, it } from 'vitest';
import {
  FakeModelProvider,
  OpenAiCompatibleProvider,
  createModelProviderFromEnv,
  type CompletionRequest,
} from '../src/index.js';

const request: CompletionRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'system' },
    { role: 'user', content: '<demand-json>{"title":"t"}</demand-json>' },
  ],
  metadata: { stageKey: 'requirement_analysis', attempt: 1 },
};

describe('createModelProviderFromEnv', () => {
  it('defaults to the fake provider when no key is configured', () => {
    const provider = createModelProviderFromEnv({});
    expect(provider).toBeInstanceOf(FakeModelProvider);
    expect(provider.name).toBe('fake');
  });

  it('honours SA_AI_PROVIDER=fake', () => {
    const provider = createModelProviderFromEnv({ SA_AI_PROVIDER: 'fake' });
    expect(provider.name).toBe('fake');
  });

  it('builds an openai-compatible provider when URL and key are present', () => {
    const provider = createModelProviderFromEnv({
      SA_AI_PROVIDER: 'openai-compatible',
      SA_AI_BASE_URL: 'https://example.invalid/v1',
      SA_AI_API_KEY: 'secret-key',
    });
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(provider.name).toBe('openai-compatible');
  });

  it('fails with an actionable error when the provider is requested without credentials', () => {
    expect(() => createModelProviderFromEnv({ SA_AI_PROVIDER: 'openai-compatible' })).toThrow(
      /SA_AI_BASE_URL/,
    );
  });

  it('rejects an unknown provider name', () => {
    expect(() => createModelProviderFromEnv({ SA_AI_PROVIDER: 'mystery' })).toThrow(/mystery/);
  });
});

describe('FakeModelProvider', () => {
  it('pops scripted responses in order before using the default output', async () => {
    const provider = new FakeModelProvider({ responses: ['first', 'second'] });
    await expect(provider.complete(request)).resolves.toMatchObject({ text: 'first' });
    await expect(provider.complete(request)).resolves.toMatchObject({ text: 'second' });
    const fallback = await provider.complete(request);
    expect(fallback.text).toContain('需求分析');
    expect(fallback.usage.totalTokens).toBe(
      fallback.usage.promptTokens + fallback.usage.completionTokens,
    );
    expect(fallback.costUsd).toBe(0);
  });

  it('uses stageOutputs for a configured stage key', async () => {
    const provider = new FakeModelProvider({ stageOutputs: { requirement_analysis: '{"ok":1}' } });
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '{"ok":1}' });
  });
});

describe('OpenAiCompatibleProvider', () => {
  it('posts to /chat/completions with a bearer token and maps usage', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"ok"}' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.example.invalid/v1/',
      apiKey: 'top-secret',
      fetchImpl,
    });

    const result = await provider.complete(request);

    expect(result.text).toBe('{"summary":"ok"}');
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.invalid/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer top-secret');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['model']).toBe('test-model');
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });

  it('throws a descriptive error on non-2xx without leaking the key', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.example.invalid/v1',
      apiKey: 'top-secret',
      fetchImpl: async () => new Response('upstream unavailable', { status: 503 }),
    });
    const failure = provider.complete(request);
    await expect(failure).rejects.toThrow(/HTTP 503/);
    await expect(
      new OpenAiCompatibleProvider({
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: 'top-secret',
        fetchImpl: async () => new Response('nope', { status: 401 }),
      }).complete(request),
    ).rejects.not.toThrow(/top-secret/);
  });
});
