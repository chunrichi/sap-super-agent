export {
  loadOrCreateStateSecret,
  issueToken,
  verifyToken,
  DEFAULT_TOKEN_TTL_MS,
  type IssueTokenInput,
  type TokenClaims,
} from './auth.js';
export { startServer } from './server.js';
export { resolveConfig, resolveEnv, readEnvFile, parseEnvFile } from './config.js';
export { InstanceLockedError, StateDirLock } from './instance-lock.js';
export { loadTemplates, type TemplateRegistry } from './templates.js';
export type { RunningServer, ServerConfig, ServerContext, ServerOptions } from './types.js';
export { createApp } from './http/app.js';
// --- S4: generic Hook config + reconcile (docs/008 §6/§7) ---
export { resolveHooksConfig, findHook, enabledHooks } from './hooks/hook-config.js';
export type { HooksRuntimeConfig, ResolvedHook, ResolvedHookRetryPolicy } from './hooks/hook-config.js';
export {
  reconcileHooks,
  DEFAULT_HOOK_RECONCILE_SLA_MS,
} from './hooks/reconcile.js';
export type {
  HookReconcileReport,
  HookReconcileDifference,
  HookReconcileDifferenceKind,
  HookReconcileExternalCheck,
  HookReconcileOptions,
} from './hooks/reconcile.js';
