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
// --- S5: SAP batch AI executor config + job queue (docs/003 §4.8) ---
export {
  resolveSapAiBatchConfig,
  DEFAULT_SAP_AI_HOOK_TOLERANCE_MS,
} from './sap-ai/config.js';
export type { SapAiBatchConfig, SapAiBatchOverrides } from './sap-ai/config.js';
export { SAP_AI_JOB_TERMINAL_STATES, isSapAiJobTerminal } from './db/sap-ai-jobs.js';
export { openDatabase, migrateDatabase } from './db/database.js';
