// ---------------------------------------------------------------------------
// H2: SAP ICF integration configuration (docs/004 §3, handoffs/H2 §1.5).
//
// SAP integration is *optional*: when `SA_SAP_BASE_URL` + service credentials
// are absent the writeback worker and the inbound webhook are not registered,
// so H0/H1 keep working with no SAP system (and CI needs none).
// ---------------------------------------------------------------------------

export interface SapWritebackConfig {
  /** Poll interval for the outbox worker (default 1000ms). */
  pollMs: number;
  /** Maximum delivery attempts before a permanent dead letter (default 5). */
  maxAttempts: number;
  /** First retry delay; doubles per attempt (default 2000ms = docs/008 §5). */
  backoffBaseMs: number;
  /** Backoff cap (default 300000ms = 5min). */
  backoffMaxMs: number;
  /** Rows processed per tick (default 10). */
  batchSize: number;
}

export interface SapIntegrationConfig {
  /** ICF writeback + reconcile are enabled (base URL and credentials present). */
  enabled: boolean;
  /** Inbound `POST /hooks/sap` is registered (hook secret present). */
  hookEnabled: boolean;
  baseUrl: string;
  username?: string;
  password?: string;
  token?: string;
  hookSecret: string;
  /** Replay window for X-SA-Timestamp (default 5min). */
  hookToleranceMs: number;
  /** Per-request ICF timeout (default 10s). */
  timeoutMs: number;
  writeback: SapWritebackConfig;
}

export const DEFAULT_SAP_TIMEOUT_MS = 10_000;
export const DEFAULT_SAP_HOOK_TOLERANCE_MS = 5 * 60 * 1000;
export const DEFAULT_SAP_WRITEBACK: SapWritebackConfig = {
  pollMs: 1_000,
  maxAttempts: 5,
  backoffBaseMs: 2_000,
  backoffMaxMs: 5 * 60 * 1_000,
  batchSize: 10,
};

function envValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function envPositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = envValue(raw);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (received "${raw}")`);
  }
  return parsed;
}

/**
 * Resolve SAP integration config from the already-resolved environment
 * (`resolveEnv()` output: real env over `.env`, see config.ts).
 */
export function resolveSapConfig(env: NodeJS.ProcessEnv): SapIntegrationConfig {
  const baseUrl = envValue(env['SA_SAP_BASE_URL']);
  const username = envValue(env['SA_SAP_SERVICE_USER']);
  const password = envValue(env['SA_SAP_SERVICE_PASSWORD']);
  const token = envValue(env['SA_SAP_SERVICE_TOKEN']);
  const hookSecret = envValue(env['SA_SAP_HOOK_SECRET']) ?? '';
  const hasCredentials = token !== undefined || (username !== undefined && password !== undefined);

  const config: SapIntegrationConfig = {
    enabled: baseUrl !== undefined && hasCredentials,
    hookEnabled: hookSecret.length > 0,
    baseUrl: baseUrl ?? '',
    hookSecret,
    hookToleranceMs: envPositiveInt(
      env['SA_SAP_HOOK_TOLERANCE_MS'],
      DEFAULT_SAP_HOOK_TOLERANCE_MS,
      'SA_SAP_HOOK_TOLERANCE_MS',
    ),
    timeoutMs: envPositiveInt(env['SA_SAP_TIMEOUT_MS'], DEFAULT_SAP_TIMEOUT_MS, 'SA_SAP_TIMEOUT_MS'),
    writeback: {
      pollMs: envPositiveInt(
        env['SA_SAP_WRITEBACK_POLL_MS'],
        DEFAULT_SAP_WRITEBACK.pollMs,
        'SA_SAP_WRITEBACK_POLL_MS',
      ),
      maxAttempts: envPositiveInt(
        env['SA_SAP_WRITEBACK_MAX_ATTEMPTS'],
        DEFAULT_SAP_WRITEBACK.maxAttempts,
        'SA_SAP_WRITEBACK_MAX_ATTEMPTS',
      ),
      backoffBaseMs: envPositiveInt(
        env['SA_SAP_WRITEBACK_BACKOFF_BASE_MS'],
        DEFAULT_SAP_WRITEBACK.backoffBaseMs,
        'SA_SAP_WRITEBACK_BACKOFF_BASE_MS',
      ),
      backoffMaxMs: envPositiveInt(
        env['SA_SAP_WRITEBACK_BACKOFF_MAX_MS'],
        DEFAULT_SAP_WRITEBACK.backoffMaxMs,
        'SA_SAP_WRITEBACK_BACKOFF_MAX_MS',
      ),
      batchSize: envPositiveInt(
        env['SA_SAP_WRITEBACK_BATCH_SIZE'],
        DEFAULT_SAP_WRITEBACK.batchSize,
        'SA_SAP_WRITEBACK_BATCH_SIZE',
      ),
    },
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(token === undefined ? {} : { token }),
  };
  if (config.enabled && config.baseUrl.length === 0) {
    throw new Error('SA_SAP_BASE_URL must not be empty when SAP integration is enabled');
  }
  return config;
}
