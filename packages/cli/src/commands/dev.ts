// `sap-superagent dev` — boot the M1 local control plane and print everything a
// developer needs for the manual smoke test (H0 §1.6, §2).
import { DEFAULT_TOKEN_TTL_MS, issueToken, loadOrCreateStateSecret, startServer } from '@sap-superagent/server';
import type { RunningServer, ServerOptions } from '@sap-superagent/server';
import { CliError } from '../lib/errors.js';
import type { CliIo } from '../lib/io.js';
import { DEFAULT_HOST, findTemplatesDir, resolvePort, resolveStateDir } from '../lib/paths.js';

export interface DevOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  port?: string | number | undefined;
  stateDir?: string | undefined;
  host?: string | undefined;
  /** Override repo-template discovery (tests/e2e). */
  templatesDir?: string | undefined;
  /** Token subject for the printed `user` token; defaults to `dev`. */
  user?: string | undefined;
  tokenTtlMs?: number | undefined;
  /** Injectable for tests that must not open a real port. */
  startServerFn?: ((options: ServerOptions) => Promise<RunningServer>) | undefined;
  now?: (() => number) | undefined;
}

export interface DevHandle {
  server: RunningServer;
  stateDir: string;
  userToken: string;
  adminToken: string;
  userExpiresAt: string;
  adminExpiresAt: string;
  stop(): Promise<void>;
}

function resolveTemplatesDir(options: DevOptions): string {
  if (options.templatesDir !== undefined) {
    return options.templatesDir;
  }
  const found = findTemplatesDir(options.cwd);
  if (found === undefined) {
    throw new CliError(
      '找不到 templates/default.yaml。请在仓库根目录运行 sap-superagent dev，或用 --state-dir 之外的方式确认工作目录正确。',
    );
  }
  return found;
}

/**
 * Start the control plane and print URL + dev tokens + next commands. Does not
 * install signal handlers: `runDev` owns those, and e2e can call this directly.
 */
export async function startDevServer(options: DevOptions): Promise<DevHandle> {
  const stateDir = resolveStateDir(options.cwd, options.env, options.stateDir);
  const port = resolvePort(options.env, options.port);
  const host = options.host?.trim() === undefined || options.host.trim() === '' ? DEFAULT_HOST : options.host.trim();
  const templatesDir = resolveTemplatesDir(options);
  const startServerFn = options.startServerFn ?? startServer;

  let server: RunningServer;
  try {
    server = await startServerFn({ stateDir, host, port, templatesDir });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `无法在 ${host}:${port} 启动控制平面：${detail}\n提示：端口被占用时用 --port 换一个；状态目录用 --state-dir 指定。`,
    );
  }

  const secret = loadOrCreateStateSecret(stateDir);
  const ttlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const issuedAt = options.now?.() ?? Date.now();
  const user = (options.user ?? 'dev').trim() === '' ? 'dev' : (options.user ?? 'dev').trim();
  const userToken = issueToken({ kind: 'user', sub: user, secret, ttlMs });
  const adminToken = issueToken({ kind: 'admin', sub: 'admin', secret, ttlMs });
  const userExpiresAt = new Date(issuedAt + ttlMs).toISOString();
  const adminExpiresAt = userExpiresAt;

  const { io } = options;
  io.out(`control plane: ${server.url}`);
  io.out('tokens（本地开发用；签名 secret 未打印，不会离开本机）：');
  io.out(`  user  (${user})  ${userToken}`);
  io.out(`  admin (admin)  ${adminToken}`);
  io.out(`  到期时间：${userExpiresAt}`);
  io.out('下一步（先把上面的 user token 存进环境变量）：');
  io.out('  export SA_TOKEN=<上面的 user token>');
  io.out(`  curl -s ${server.url}/api/v1/healthz`);
  io.out(
    `  curl -s -X POST ${server.url}/api/v1/demands -H 'content-type: application/json' -H "authorization: Bearer $SA_TOKEN" -d '{"title":"示例需求","description":"…","requester":{"userId":"${user}"}}'`,
  );
  io.out('  VSCode 扩展：连接控制平面时填上面的 user token（register 会换成 executor token）');
  io.out('按 Ctrl+C 停止控制平面。');

  let stopped = false;
  return {
    server,
    stateDir,
    userToken,
    adminToken,
    userExpiresAt,
    adminExpiresAt,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await server.close();
      io.out('control plane stopped.');
    },
  };
}

/** Boot, then block until SIGINT/SIGTERM and close gracefully. */
export async function runDev(options: DevOptions): Promise<number> {
  const handle = await startDevServer(options);
  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    process.once('SIGINT', () => resolve('SIGINT'));
    process.once('SIGTERM', () => resolve('SIGTERM'));
  });
  options.io.out(`收到 ${signal}，正在关闭…`);
  await handle.stop();
  return 0;
}
