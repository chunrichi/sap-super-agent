import { createModelProviderFromEnv } from '@sap-superagent/ai';
import { loadOrCreateStateSecret } from './auth.js';
import { resolveConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createApp } from './http/app.js';
import { loadTemplates } from './templates.js';
import type { RunningServer, ServerContext, ServerOptions } from './types.js';
import { EventSocketHub } from './ws/event-socket.js';
import { StageRunner } from './workers/stage-runner.js';
import { Sweepers } from './workers/sweepers.js';

const EVENT_SOCKET_PATH = '/api/v1/events';

function listeningPort(app: ReturnType<typeof createApp>, fallback: number): number {
  const address = app.server.address();
  if (address !== null && typeof address === 'object') return address.port;
  return fallback;
}

/**
 * Start the M1 control plane: HTTP + WS listeners, SQLite state, the server-AI
 * stage runner and the lease/presence sweeper. Resolves once listening.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const config = resolveConfig(options);
  const templates = loadTemplates(config.templatesDir);
  const secret = loadOrCreateStateSecret(config.stateDir);
  const db = openDatabase(config.dbPath);
  const aiProvider = options.aiProvider ?? createModelProviderFromEnv();
  const startedAtMs = Date.now();
  const clock = (): number => Date.now();
  const hub = new EventSocketHub({ db, secret, path: EVENT_SOCKET_PATH, clock });
  const ctx: ServerContext = {
    config,
    db,
    templates,
    secret,
    aiProvider,
    hub,
    startedAtMs,
    clock,
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
  stageRunner.start();
  sweepers.start();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await stageRunner.close();
    await sweepers.close();
    await hub.close();
    await app.close();
    db.close();
  };

  return {
    url: `http://${config.host}:${port}`,
    port,
    stateDir: config.stateDir,
    app,
    close,
  };
}
