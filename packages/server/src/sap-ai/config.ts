import { DEFAULT_AI_MODEL } from '@sap-superagent/ai';
import {
  DEFAULT_SAP_AI_JOB_BATCH_SIZE,
  DEFAULT_SAP_AI_JOB_LEASE_MS,
  DEFAULT_SAP_AI_JOB_MAX_AGE_MS,
  DEFAULT_SAP_AI_JOB_MAX_LEASE_EXPIRIES,
  DEFAULT_SAP_AI_JOB_TIMEOUT_MS,
  MAX_SAP_AI_JOB_BATCH_SIZE,
} from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// S5: SAP batch AI executor configuration (docs/003 §4.8.1).
//
// The feature is **off by default**: with `SA_SAP_AI_BATCH` unset/`0` the
// control plane keeps calling the local `ctx.aiProvider` for every server-AI
// stage and the SAP job API is not registered, so H0–S4 behaviour is unchanged.
// Enabling it requires the shared SAP webhook secret because the job API is
// authenticated with the same `X-SA-*` HMAC scheme (docs/003 §4.8.4).
// ---------------------------------------------------------------------------

/** Replay window for `X-SA-Timestamp` on the SAP → control-plane job API. */
export const DEFAULT_SAP_AI_HOOK_TOLERANCE_MS = 5 * 60 * 1_000;

/**
 * Resolved SAP host-mode configuration. Always present on `ServerConfig` /
 * `ServerContext`; when `enabled` is false every S5 surface stays dormant.
 */
export interface SapAiBatchConfig {
  /** Delegate qualifying `server-ai` stages to the SAP batch executor. */
  enabled: boolean;
  /** Stage-key allow-list; `null` means every `server-ai` stage in the template. */
  stageKeys: readonly string[] | null;
  /** Claim lease in ms; SAP renews through `POST …/heartbeat`. */
  leaseTtlMs: number;
  /** Non-terminal jobs older than this are expired and their attempt failed. */
  maxAgeMs: number;
  /** Default and maximum `next` batch size (docs/003 caps the wire limit at 50). */
  batchSize: number;
  /** Gateway-call timeout hint written into the job payload. */
  timeoutMs: number;
  /** Failed-lease-expiry count that fails the stage attempt (docs/003 §4.8.2). */
  maxLeaseExpiries: number;
  /** Model pinned into the job payload (`SA_AI_MODEL` or the provider default). */
  model: string;
  /** Shared SAP HMAC secret; `null` whenever the feature is disabled. */
  hookSecret: string | null;
  /** `X-SA-Timestamp` replay window in ms (default 5min). */
  toleranceMs: number;
}

/** Test/ops overrides merged on top of the environment (`ServerOptions.sapAiBatch`). */
export type SapAiBatchOverrides = Partial<SapAiBatchConfig>;

function envValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function envPositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = envValue(raw);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (received "${raw}")`);
  }
  return parsed;
}

/**
 * Parse `SA_SAP_AI_BATCH`: only `1`/`true` enable, only `0`/`false`/unset
 * disable. Anything else is a startup error with the fix spelled out, so a
 * typo can never silently leave the local provider running (docs/003 §4.8.1).
 */
function parseSapAiBatchFlag(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value.length === 0 || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new Error(
    `SA_SAP_AI_BATCH must be one of 1/true (enable) or 0/false (disable); received "${raw}". ` +
      'Fix: set SA_SAP_AI_BATCH=1 to delegate server-ai stages to the SAP batch executor, ' +
      'or SA_SAP_AI_BATCH=0 / unset it to keep the local AI provider.',
  );
}

/** `SA_SAP_AI_STAGE_KEYS`: comma-separated stage-key allow-list. */
function parseStageKeys(raw: string | undefined): readonly string[] | null {
  const value = envValue(raw);
  if (value === undefined) return null;
  const keys = value
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  return keys.length === 0 ? null : keys;
}

function pick<T>(override: T | undefined, fallback: T): T {
  return override === undefined ? fallback : override;
}

/**
 * Resolve the SAP host-mode config from an already-resolved environment (real
 * env over `.env`, see `resolveEnv()`), then apply explicit overrides — which
 * always win and exist so tests can inject a short lease/age without touching
 * process env. Passing an override object without `enabled` implies
 * `enabled: true` (a test that only tunes the lease still wants the feature).
 */
export function resolveSapAiBatchConfig(
  env: NodeJS.ProcessEnv,
  overrides: SapAiBatchOverrides = {},
): SapAiBatchConfig {
  const envEnabled = parseSapAiBatchFlag(env['SA_SAP_AI_BATCH']);
  const hasOverrides = Object.keys(overrides).length > 0;
  const envStageKeys = parseStageKeys(env['SA_SAP_AI_STAGE_KEYS']);
  const envModel = envValue(env['SA_AI_MODEL']) ?? DEFAULT_AI_MODEL;
  const envHookSecret = envValue(env['SA_SAP_HOOK_SECRET']) ?? null;

  const config: SapAiBatchConfig = {
    enabled: pick(overrides.enabled, hasOverrides ? true : envEnabled),
    stageKeys: pick(overrides.stageKeys, envStageKeys),
    leaseTtlMs: pick(
      overrides.leaseTtlMs,
      envPositiveInt(env['SA_SAP_AI_JOB_LEASE_MS'], DEFAULT_SAP_AI_JOB_LEASE_MS, 'SA_SAP_AI_JOB_LEASE_MS'),
    ),
    maxAgeMs: pick(
      overrides.maxAgeMs,
      envPositiveInt(env['SA_SAP_AI_JOB_MAX_AGE_MS'], DEFAULT_SAP_AI_JOB_MAX_AGE_MS, 'SA_SAP_AI_JOB_MAX_AGE_MS'),
    ),
    batchSize: pick(
      overrides.batchSize,
      Math.min(
        MAX_SAP_AI_JOB_BATCH_SIZE,
        envPositiveInt(
          env['SA_SAP_AI_JOB_BATCH_SIZE'],
          DEFAULT_SAP_AI_JOB_BATCH_SIZE,
          'SA_SAP_AI_JOB_BATCH_SIZE',
        ),
      ),
    ),
    timeoutMs: pick(
      overrides.timeoutMs,
      envPositiveInt(env['SA_SAP_AI_JOB_TIMEOUT_MS'], DEFAULT_SAP_AI_JOB_TIMEOUT_MS, 'SA_SAP_AI_JOB_TIMEOUT_MS'),
    ),
    maxLeaseExpiries: pick(
      overrides.maxLeaseExpiries,
      envPositiveInt(
        env['SA_SAP_AI_JOB_MAX_LEASE_EXPIRIES'],
        DEFAULT_SAP_AI_JOB_MAX_LEASE_EXPIRIES,
        'SA_SAP_AI_JOB_MAX_LEASE_EXPIRIES',
      ),
    ),
    model: pick(overrides.model, envModel),
    hookSecret: pick(overrides.hookSecret, envHookSecret),
    toleranceMs: pick(
      overrides.toleranceMs,
      envPositiveInt(
        env['SA_SAP_HOOK_TOLERANCE_MS'],
        DEFAULT_SAP_AI_HOOK_TOLERANCE_MS,
        'SA_SAP_HOOK_TOLERANCE_MS',
      ),
    ),
  };

  // Sanity-check overrides that bypass env parsing (test injection still has to
  // be a usable config; otherwise the feature would silently misbehave).
  if (!Number.isInteger(config.batchSize) || config.batchSize <= 0) {
    throw new Error(`sapAiBatch.batchSize must be a positive integer (received ${config.batchSize})`);
  }
  config.batchSize = Math.min(MAX_SAP_AI_JOB_BATCH_SIZE, config.batchSize);

  if (config.enabled && (config.hookSecret === null || config.hookSecret.length === 0)) {
    throw new Error(
      'SAP batch AI mode is enabled (SA_SAP_AI_BATCH=1) but SA_SAP_HOOK_SECRET is not set. ' +
        'Fix: set SA_SAP_HOOK_SECRET to the shared SAP webhook HMAC secret (the same value ' +
        'configured on the SAP side) so the SAP → control-plane job API can be authenticated, ' +
        'or disable SAP batch AI with SA_SAP_AI_BATCH=0.',
    );
  }
  if (!config.enabled) {
    // Disabled = dormant: never leak a secret into surfaces that must not exist.
    config.hookSecret = null;
  }
  return config;
}
