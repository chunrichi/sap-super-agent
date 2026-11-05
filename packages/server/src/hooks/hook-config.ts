import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  DEFAULT_HOOK_BACKOFF_BASE_MS,
  DEFAULT_HOOK_BACKOFF_MAX_MS,
  DEFAULT_HOOK_MAX_ATTEMPTS,
  DEFAULT_HOOK_POLL_MS,
  DEFAULT_HOOK_TIMEOUT_MS,
  hooksConfigFileSchema,
  type EventType,
  type HookDefinition,
} from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// S4: generic Hook configuration (docs/008 §6).
//
// Configuration is optional and *fail-closed but loud*: a missing default file
// disables hooks silently (H0–S3 behaviour is untouched), while an explicitly
// configured file that is missing, malformed or has an enabled hook without a
// secret fails server startup with an actionable message. Secrets are read from
// the environment through `env:NAME` and only kept in memory.
// ---------------------------------------------------------------------------

export const DEFAULT_HOOKS_CONFIG_PATH = 'examples/hooks.yaml';

export interface ResolvedHookRetryPolicy {
  maxAttempts: number;
  backoff: 'exponential';
  deadLetter: boolean;
}

export interface ResolvedHook {
  id: string;
  target: 'http';
  url: string;
  events: readonly EventType[];
  secretRef: string;
  enabled: boolean;
  retry: ResolvedHookRetryPolicy;
  /** Resolved secret; `null` when the env var is absent (only allowed if disabled). */
  secret: string | null;
  /** Optional external listing endpoint used by `hooks:reconcile`. */
  reconcileUrl?: string;
  advanceOnReceipt: boolean;
}

export interface HookWorkerSettings {
  /** At least one hook is enabled; the outbound worker only runs then. */
  enabled: boolean;
  pollMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  timeoutMs: number;
}

export interface HooksRuntimeConfig {
  /** Absolute path of the config file that was resolved. */
  configPath: string;
  /** `false` when the (default) config file does not exist: hooks are all off. */
  loaded: boolean;
  hooks: readonly ResolvedHook[];
  settings: HookWorkerSettings;
}

function envValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function envPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envValue(env[name]);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (received "${raw}")`);
  }
  return parsed;
}

function disabledConfig(configPath: string): HooksRuntimeConfig {
  return {
    configPath,
    loaded: false,
    hooks: [],
    settings: {
      enabled: false,
      pollMs: DEFAULT_HOOK_POLL_MS,
      retryBaseMs: DEFAULT_HOOK_BACKOFF_BASE_MS,
      retryMaxMs: DEFAULT_HOOK_BACKOFF_MAX_MS,
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    },
  };
}

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function resolveRetry(definition: HookDefinition): ResolvedHookRetryPolicy {
  return {
    maxAttempts: definition.retry?.maxAttempts ?? DEFAULT_HOOK_MAX_ATTEMPTS,
    backoff: definition.retry?.backoff ?? 'exponential',
    deadLetter: definition.retry?.deadLetter ?? true,
  };
}

export interface ResolveHooksConfigOptions {
  /**
   * Require the secret of every enabled hook (default `true`, used by the
   * server). Read-only consumers such as `hooks:reconcile` pass `false`: they
   * never sign or verify anything and must work without ops exporting secrets.
   */
  requireSecrets?: boolean;
}

/**
 * Resolve `SA_HOOKS_CONFIG` (default `examples/hooks.yaml` relative to `cwd`)
 * into runtime config. `env` is the already-resolved environment (real vars over
 * `.env`, see config.ts). Throws with actionable guidance on invalid input.
 */
export function resolveHooksConfig(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
  options: ResolveHooksConfigOptions = {},
): HooksRuntimeConfig {
  const requireSecrets = options.requireSecrets ?? true;
  const configuredPath = envValue(env['SA_HOOKS_CONFIG']);
  const explicit = configuredPath !== undefined;
  const configPath = resolve(cwd, configuredPath ?? DEFAULT_HOOKS_CONFIG_PATH);

  if (!existsSync(configPath)) {
    if (!explicit) return disabledConfig(configPath);
    throw new Error(
      `SA_HOOKS_CONFIG points to "${configPath}" but the file does not exist; ` +
        `create it (see ${DEFAULT_HOOKS_CONFIG_PATH} and docs/008 §6) or unset SA_HOOKS_CONFIG to disable generic hooks`,
    );
  }

  let yamlText: string;
  try {
    yamlText = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read hook config "${configPath}": ${error instanceof Error ? error.message : String(error)}; ` +
        'fix file permissions or unset SA_HOOKS_CONFIG to disable generic hooks',
    );
  }

  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (error) {
    throw new Error(
      `cannot parse hook config "${configPath}" as YAML: ${error instanceof Error ? error.message : String(error)}; ` +
        'fix the YAML syntax (see examples/hooks.yaml) or unset SA_HOOKS_CONFIG to disable generic hooks',
    );
  }

  const parsed = hooksConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid hook config "${configPath}": ${formatIssues(parsed.error.issues)}; ` +
        'fix the entries per docs/008 §6 (id/target/url/events/secretRef) or unset SA_HOOKS_CONFIG to disable generic hooks',
    );
  }

  const seen = new Set<string>();
  const hooks: ResolvedHook[] = [];
  for (const definition of parsed.data.hooks) {
    if (seen.has(definition.id)) {
      throw new Error(
        `invalid hook config "${configPath}": duplicate hook id "${definition.id}"; ` +
          'give every hook a unique lower-kebab-case id (docs/008 §6)',
      );
    }
    seen.add(definition.id);

    const duplicatedEvents = definition.events.filter(
      (event, index) => definition.events.indexOf(event) !== index,
    );
    if (duplicatedEvents.length > 0) {
      throw new Error(
        `invalid hook config "${configPath}": hook "${definition.id}" subscribes twice to ` +
          `${[...new Set(duplicatedEvents)].join(', ')}; remove the duplicate event(s)`,
      );
    }
    const nested = definition.events.filter((event) => event.startsWith('hook.'));
    if (nested.length > 0) {
      throw new Error(
        `invalid hook config "${configPath}": hook "${definition.id}" must not subscribe to ` +
          `${nested.join(', ')} (hook.* events would loop back into the same queue); ` +
          'subscribe to a domain event such as artifact.approved instead (docs/008 §6)',
      );
    }
    if (definition.advanceOnReceipt) {
      throw new Error(
        `hook "${definition.id}" sets advanceOnReceipt: true, which v1 does not implement ` +
          '(receipts are recorded only, docs/008 §4); set advanceOnReceipt: false or remove it',
      );
    }

    const secretEnvName = definition.secretRef.slice('env:'.length);
    const secret = envValue(env[secretEnvName]) ?? null;
    if (definition.enabled && secret === null && requireSecrets) {
      throw new Error(
        `hook "${definition.id}" is enabled but secret "${definition.secretRef}" is not set; ` +
          `export ${secretEnvName}=<secret> (never commit it) or set enabled: false (docs/008 §6)`,
      );
    }

    hooks.push({
      id: definition.id,
      target: definition.target,
      url: definition.url,
      events: definition.events,
      secretRef: definition.secretRef,
      enabled: definition.enabled,
      retry: resolveRetry(definition),
      secret,
      advanceOnReceipt: definition.advanceOnReceipt,
      ...(definition.reconcileUrl === undefined ? {} : { reconcileUrl: definition.reconcileUrl }),
    });
  }

  return {
    configPath,
    loaded: true,
    hooks,
    settings: {
      enabled: hooks.some((hook) => hook.enabled),
      pollMs: envPositiveInt(env, 'SA_HOOKS_POLL_MS', DEFAULT_HOOK_POLL_MS),
      retryBaseMs: envPositiveInt(env, 'SA_HOOKS_RETRY_BASE_MS', DEFAULT_HOOK_BACKOFF_BASE_MS),
      retryMaxMs: envPositiveInt(env, 'SA_HOOKS_RETRY_MAX_MS', DEFAULT_HOOK_BACKOFF_MAX_MS),
      timeoutMs: envPositiveInt(env, 'SA_HOOKS_TIMEOUT_MS', DEFAULT_HOOK_TIMEOUT_MS),
    },
  };
}

export function findHook(config: HooksRuntimeConfig, hookId: string): ResolvedHook | undefined {
  return config.hooks.find((hook) => hook.id === hookId);
}

export function enabledHooks(config: HooksRuntimeConfig): ResolvedHook[] {
  return config.hooks.filter((hook) => hook.enabled);
}
