import { afterEach, describe, expect, it } from 'vitest';
import { FakeAiGateway, type FakeAiGatewayMessage } from '../src/fake-ai-gateway.js';

// ---------------------------------------------------------------------------
// S5: the fake enterprise AI gateway must mirror the OpenAI-compatible
// `/chat/completions` surface the SAP batch executor calls, including the
// failure modes the S5 failure matrix needs (5xx/429/timeout/bad JSON and an
// output that fails the control-plane schema).
// ---------------------------------------------------------------------------

const gateways: FakeAiGateway[] = [];

async function startGateway(options: ConstructorParameters<typeof FakeAiGateway>[0] = {}) {
  const gateway = new FakeAiGateway(options);
  await gateway.start();
  gateways.push(gateway);
  return gateway;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
});

interface ChatCompletionBody {
  model: string;
  choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const MESSAGES: FakeAiGatewayMessage[] = [
  { role: 'system', content: 'you are a helper' },
  { role: 'user', content: 'produce the stage JSON' },
];

async function postChat(
  gateway: FakeAiGateway,
  body: unknown = { model: 'e2e-model', messages: MESSAGES },
): Promise<{ status: number; text: string; json: ChatCompletionBody | null }> {
  const response = await fetch(gateway.chatCompletionsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: ChatCompletionBody | null = null;
  try {
    json = JSON.parse(text) as ChatCompletionBody;
  } catch {
    // Fault injection intentionally returns non-JSON bodies.
  }
  return { status: response.status, text, json };
}

describe('FakeAiGateway', () => {
  it('answers like an OpenAI-compatible gateway and records the request', async () => {
    const gateway = await startGateway({ model: 'e2e-model', outputText: '{"summary":"ok"}' });
    const result = await postChat(gateway);

    expect(result.status).toBe(200);
    expect(result.json?.model).toBe('e2e-model');
    expect(result.json?.choices[0]?.message).toMatchObject({
      role: 'assistant',
      content: '{"summary":"ok"}',
    });
    expect(result.json?.usage.total_tokens).toBeGreaterThan(0);
    expect(result.json?.usage.total_tokens).toBe(
      (result.json?.usage.prompt_tokens ?? 0) + (result.json?.usage.completion_tokens ?? 0),
    );

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.model).toBe('e2e-model');
    expect(gateway.requests[0]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
  });

  it('consumes queued outputs in order, then falls back to the fixed output', async () => {
    const gateway = await startGateway({ outputs: ['first', 'second'], outputText: 'fallback' });

    expect((await postChat(gateway)).json?.choices[0]?.message.content).toBe('first');
    expect((await postChat(gateway)).json?.choices[0]?.message.content).toBe('second');
    expect((await postChat(gateway)).json?.choices[0]?.message.content).toBe('fallback');
  });

  it('supports a dynamic responder for stage-specific JSON', async () => {
    const gateway = await startGateway({
      respond: (request) => (request.model === 'm-1' ? '{"stage":"one"}' : '{"stage":"other"}'),
    });
    expect((await postChat(gateway, { model: 'm-1', messages: MESSAGES })).json?.choices[0]?.message
      .content).toBe('{"stage":"one"}');
    expect((await postChat(gateway, { model: 'm-2', messages: MESSAGES })).json?.choices[0]?.message
      .content).toBe('{"stage":"other"}');
  });

  it('injects 5xx and 429 failures without recording partial requests', async () => {
    const gateway = await startGateway({ outputText: '{}' });
    gateway.injectFault({ kind: 'status', status: 429, headers: { 'retry-after': '1' } });
    const rateLimited = await postChat(gateway);
    expect(rateLimited.status).toBe(429);
    gateway.injectFault({ kind: 'status', status: 503 });
    expect((await postChat(gateway)).status).toBe(503);
  });

  it('injects malformed JSON, invalid output text and delayed (timeout) responses', async () => {
    const gateway = await startGateway({ outputText: '{"ok":true}' });

    gateway.injectFault({ kind: 'bad_json' });
    const malformed = await postChat(gateway);
    expect(malformed.status).toBe(200);
    expect(malformed.json).toBeNull();
    expect(malformed.text.length).toBeGreaterThan(0);

    gateway.injectFault({ kind: 'invalid_output', bodyText: 'this is not a valid stage output' });
    const invalid = await postChat(gateway);
    expect(invalid.status).toBe(200);
    expect(invalid.json?.choices[0]?.message.content).toBe('this is not a valid stage output');

    gateway.injectFault({ kind: 'timeout', delayMs: 10 });
    const delayed = await postChat(gateway);
    expect(delayed.status).toBe(200);

    // Faults are one-shot: the next request gets the configured output again.
    expect((await postChat(gateway)).json?.choices[0]?.message.content).toBe('{"ok":true}');
  });

  it('refuses unknown routes and non-POST requests', async () => {
    const gateway = await startGateway();
    const health = await fetch(`${gateway.url}/health`);
    expect(health.status).toBe(200);
    const unknown = await fetch(`${gateway.url}/embeddings`, { method: 'POST' });
    expect(unknown.status).toBe(404);
    const read = await fetch(gateway.chatCompletionsUrl);
    expect(read.status).toBe(404);
    expect(gateway.requests).toHaveLength(0);
  });
});
