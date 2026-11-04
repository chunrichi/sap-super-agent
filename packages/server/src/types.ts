import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { ModelProvider } from '@sap-superagent/ai';
import type { TemplateRegistry } from './templates.js';
import type { EventSocketHub } from './ws/event-socket.js';

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
}
