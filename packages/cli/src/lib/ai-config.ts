// AI provider configuration check for `doctor` (docs/005 §3.3). BYOK only:
// no network calls, no key validation — just presence of the required variables.

export interface AiConfigSummary {
  provider: string;
  /** True when the selected provider can start: `fake` always can. */
  ok: boolean;
  /** Env vars still missing for a real provider. */
  missing: string[];
}

/** Provider that needs no key and makes the local loop deterministic. */
export const FAKE_PROVIDER = 'fake';

/** Variables the OpenAI-compatible BYOK adapters need (docs/005 §3.3). */
export const BYOK_REQUIRED_VARS = ['SA_AI_BASE_URL', 'SA_AI_API_KEY', 'SA_AI_MODEL'] as const;

export function describeAiConfig(env: NodeJS.ProcessEnv): AiConfigSummary {
  const raw = env['SA_AI_PROVIDER']?.trim();
  const provider = raw === undefined || raw === '' ? FAKE_PROVIDER : raw;
  if (provider === FAKE_PROVIDER) {
    return { provider, ok: true, missing: [] };
  }
  const missing = BYOK_REQUIRED_VARS.filter((name) => {
    const value = env[name]?.trim();
    return value === undefined || value === '';
  });
  return { provider, ok: missing.length === 0, missing: [...missing] };
}
