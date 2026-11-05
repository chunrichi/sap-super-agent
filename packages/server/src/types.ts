import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { ModelProvider } from '@sap-superagent/ai';
import type { TemplateRegistry } from './templates.js';
import type { EventSocketHub } from './ws/event-socket.js';
// --- H2: SAP ICF integration (docs/004 §3) ---
import type { SapIntegrationConfig } from './hooks/sap-config.js';
// --- S4: generic Hook runtime config (docs/008 §6) ---
import type { HooksRuntimeConfig } from './hooks/hook-config.js';
// --- S5: SAP batch AI executor config (docs/003 §4.8) ---
import type { SapAiBatchConfig } from './sap-ai/config.js';

/** Options accepted by `startServer` (all optional except `stateDir`). */
export interface ServerOptions {
  stateDir: string;
  host?: string;
  port?: number;
  dbPath?: string;
  templatesDir?: string;
  aiProvider?: ModelProvider;
  leaseTtlMs?: number;
  presenceTtlMs?: number;
  eventRetentionMs?: number;
  idempotencyTtlMs?: number;
  heartbeatSweepMs?: number;
  stagePollMs?: number;
  logger?: boolean;
  version?: string;
  /** Environment to resolve from; defaults to process.env merged over `<cwd>/.env`. */
  env?: NodeJS.ProcessEnv;
  /** WS keep-alive ping interval (default 20s). */
  wsPingMs?: number;
  // --- H1: gate timeout override in ms (tests / M1 ops; default per template) ---
  gateTimeoutMs?: number;
  // --- S3: per-user concurrency cap for human (vscode) tasks (docs/003 §3 rule 6) ---
  maxConcurrentPerUser?: number;
  /**
   * S5: SAP batch AI executor overrides (test/ops injection). Always win over
   * the environment; passing an object implies `enabled: true` unless set.
   */
  sapAiBatch?: Partial<SapAiBatchConfig>;
}

export interface RunningServer {
  url: string;
  port: number;
  stateDir: string;
  app: FastifyInstance;
  close(): Promise<void>;
}

/** Fully resolved runtime configuration (env + defaults applied). */
export interface ServerConfig {
  host: string;
  port: number;
  stateDir: string;
  dbPath: string;
  templatesDir: string;
  leaseTtlMs: number;
  presenceTtlMs: number;
  eventRetentionMs: number;
  idempotencyTtlMs: number;
  heartbeatSweepMs: number;
  stagePollMs: number;
  logger: boolean;
  version: string;
  wsPingMs: number;
  // --- H1: null = use the template's timeoutDays ---
  gateTimeoutMs: number | null;
  // --- S3: default 2; only constrains human (vscode) tasks ---
  maxConcurrentPerUser: number;
  // --- S5: SAP batch AI executor; always present (enabled:false when off) ---
  sapAi: SapAiBatchConfig;
}

/** Shared, immutable-per-server services passed to routes and workers. */
export interface ServerContext {
  readonly config: ServerConfig;
  readonly db: DatabaseSync;
  readonly templates: TemplateRegistry;
  readonly secret: string;
  readonly aiProvider: ModelProvider;
  readonly hub: EventSocketHub;
  readonly startedAtMs: number;
  readonly clock: () => number;
  /**
   * H2: resolved SAP ICF integration config (docs/004 §3). Absent when
   * `startServer` was not given any SA_SAP_* configuration; every H2 surface
   * treats a missing value as "SAP integration disabled".
   */
  readonly sap?: SapIntegrationConfig;
  /**
   * S4: resolved generic Hook config (docs/008 §6). Always present; a missing
   * config file yields `loaded:false` with every hook disabled, so H0–S3
   * surfaces behave exactly as before.
   */
  readonly hooks: HooksRuntimeConfig;
  /**
   * S5: resolved SAP batch AI executor config (docs/003 §4.8). Always present;
   * disabled mode keeps `enabled:false` / `hookSecret:null` so H0–S4 surfaces
   * are byte-for-byte unchanged.
   */
  readonly sapAi: SapAiBatchConfig;
}
