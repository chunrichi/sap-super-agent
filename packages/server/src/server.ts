import { mkdirSync } from 'node:fs';
import { createModelProviderFromEnv } from '@sap-superagent/ai';
import { loadOrCreateStateSecret } from './auth.js';
import { resolveConfig, resolveEnv } from './config.js';
import { openDatabase } from './db/database.js';
import { createApp } from './http/app.js';
import { StateDirLock } from './instance-lock.js';
import { loadTemplates } from './templates.js';
import type { RunningServer, ServerContext, ServerOptions } from './types.js';
import { EventSocketHub } from './ws/event-socket.js';
import { StageRunner } from './workers/stage-runner.js';
import { Sweepers } from './workers/sweepers.js';
// --- H2: SAP ICF integration wiring (docs/004 §3, handoffs/H2 §1.5) ---
import { resolveSapConfig } from './hooks/sap-config.js';
import { SapWritebackWorker } from './workers/sap-writeback.js';

const EVENT_SOCKET_PATH = '/api/v1/events';

function listeningPort(app: ReturnType<typeof createApp>, fallback: number): number {
  const address = app.server.address();
  if (address !== null && typeof address === 'object') return address.port;
  return fallback;
}

/**
 * Start the M1 control plane: HTTP + WS listeners, SQLite state, the server-AI
 * stage runner and the lease/presence sweeper. Resolves once listening.
 *
 * Holds an exclusive lock on `stateDir` so two local control planes can never
 * write the same database (H0 §1.4); `.env` values are resolved here so the AI
 * provider and local paths honour the documented M1 configuration.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const env = options.env ?? resolveEnv();
  const config = resolveConfig({ ...options, env });
  mkdirSync(config.stateDir, { recursive: true });
  const lock = new StateDirLock(config.stateDir);
  lock.acquire();

  try {
    const templates = loadTemplates(config.templatesDir);
    const secret = loadOrCreateStateSecret(config.stateDir);
    const db = openDatabase(config.dbPath);
    const aiProvider = options.aiProvider ?? createModelProviderFromEnv(env);
    const startedAtMs = Date.now();
    const clock = (): number => Date.now();
    // --- H2: SAP integration is optional; missing config disables it silently ---
    const sap = resolveSapConfig(env);
    const hub = new EventSocketHub({
      db,
      secret,
      path: EVENT_SOCKET_PATH,
      clock,
      pingIntervalMs: config.wsPingMs,
    });
    const ctx: ServerContext = {
      config,
      db,
      templates,
      secret,
      aiProvider,
      hub,
      startedAtMs,
      clock,
      // --- H2: SAP ICF integration config (docs/004 §3) ---
      ...(sap.enabled || sap.hookEnabled ? { sap } : {}),
    };
    const app = createApp(ctx);
    hub.attach(app.server);

    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (error) {
      await hub.close();
      db.close();
      throw error;
    }

    const port = listeningPort(app, config.port);
    const stageRunner = new StageRunner(ctx);
    const sweepers = new Sweepers(ctx);
    // --- H2: SAP writeback worker (no-op when SAP integration is disabled) ---
    const sapWriteback = new SapWritebackWorker(ctx, sap);
    stageRunner.start();
    sweepers.start();
    sapWriteback.start();

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await stageRunner.close();
      await sweepers.close();
      // --- H2: stop the SAP writeback worker ---
      await sapWriteback.close();
      await hub.close();
      await app.close();
      db.close();
      lock.release();
    };

    return {
      url: `http://${config.host}:${port}`,
      port,
      stateDir: config.stateDir,
      app,
      close,
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}
