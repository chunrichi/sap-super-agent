import { FakeModelProvider } from './fake-provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { ModelProvider } from './types.js';

export const DEFAULT_AI_MODEL = 'gpt-4o-mini';

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Select the BYOK provider from the environment. Without a key (or with
 * `SA_AI_PROVIDER=fake`) the deterministic fake provider is used, so local
 * development and e2e never depend on the network. Keys are never logged.
 */
export function createModelProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const kind = readEnv(env, 'SA_AI_PROVIDER');
  const baseUrl = readEnv(env, 'SA_AI_BASE_URL');
  const apiKey = readEnv(env, 'SA_AI_API_KEY');
  const model = readEnv(env, 'SA_AI_MODEL');

  if (kind === 'fake') return new FakeModelProvider();

  if (kind === 'openai-compatible') {
    if (baseUrl === undefined || apiKey === undefined) {
      throw new Error(
        'SA_AI_PROVIDER=openai-compatible requires both SA_AI_BASE_URL and SA_AI_API_KEY',
      );
    }
    return new OpenAiCompatibleProvider({
      baseUrl,
      apiKey,
      ...(model !== undefined ? { defaultModel: model } : {}),
    });
  }

  if (kind !== undefined) {
    throw new Error(`unknown SA_AI_PROVIDER "${kind}" (expected "fake" or "openai-compatible")`);
  }

  if (baseUrl !== undefined && apiKey !== undefined) {
    return new OpenAiCompatibleProvider({
      baseUrl,
      apiKey,
      ...(model !== undefined ? { defaultModel: model } : {}),
    });
  }
  return new FakeModelProvider();
}
