import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { DatabaseSync } from 'node:sqlite';
import {
  CLIENT_ACK,
  CLIENT_PONG,
  RESYNC_REQUIRED,
  SERVER_PING,
  wsClientMessageSchema,
  wsConnectQuerySchema,
  type EventEnvelope,
  type Task,
  type TokenKind,
  type WsTaskOfferedFrame,
} from '@sap-superagent/protocol';
import { verifyToken, type TokenClaims } from '../auth.js';
import { eventSeqWindow, listEventsAfter } from '../db/events.js';

export interface EventSocketHubOptions {
  db: DatabaseSync;
  secret: string;
  path: string;
  clock: () => number;
  pingIntervalMs?: number;
  /**
   * S3 (docs/003 §3/§4.4): per-connection offer filtering. Called for every
   * `task.offered` frame before it is sent to an executor-bound socket; the
   * server wires it to the same claim eligibility used by REST/claim. Absent
   * filter = send to every executor-bound socket (transport-only default).
   */
  offerFilter?: (executorId: string, task: Task, atIso: string) => boolean;
}

/** Identity bound to one WS connection for its whole lifetime. */
interface ConnectionIdentity {
  kind: TokenKind;
  /** Set only for `executor` tokens (S3): offers are filtered per executor. */
  executorId: string | null;
}

const DEFAULT_PING_INTERVAL_MS = 20_000;
const BACKLOG_LIMIT = 500;

/** WS transport for the event log (`GET /api/v1/events?token=&after=`). */
export class EventSocketHub {
  private readonly db: DatabaseSync;
  private readonly secret: string;
  private readonly path: string;
  private readonly clock: () => number;
  private readonly pingIntervalMs: number;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Map<WebSocket, ConnectionIdentity>();
  private readonly offerFilter: EventSocketHubOptions['offerFilter'];
  private server: Server | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: EventSocketHubOptions) {
    this.db = options.db;
    this.secret = options.secret;
    this.path = options.path;
    this.clock = options.clock;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.offerFilter = options.offerFilter;
  }

  attach(server: Server): void {
    this.server = server;
    server.on('upgrade', this.handleUpgrade);
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
    this.pingTimer.unref();
  }

  /** Broadcast committed events; sockets never see uncommitted state. */
  broadcast(events: readonly EventEnvelope[]): void {
    if (this.closed || this.clients.size === 0) return;
    const frames = events.map((event) => JSON.stringify(event));
    for (const client of this.clients.keys()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      for (const frame of frames) client.send(frame);
    }
  }

  /**
   * Offer a claimable task to connected clients (`task.offered`). This is a
   * transport-only hint: it is NOT written to the event log (docs/003 §2.3), so
   * it carries no `seq`; clients pull authoritative state over REST.
   *
   * S3: only executor-bound connections whose eligibility is confirmed by the
   * injected `offerFilter` receive the frame; `user`/`admin` sockets only get
   * the event stream.
   */
  broadcastTaskOffered(task: Task, at: string): void {
    if (this.closed || this.clients.size === 0) return;
    const frame: WsTaskOfferedFrame = {
      type: 'task.offered',
      at,
      subject: { type: 'task', id: task.id },
      task: {
        id: task.id,
        demandId: task.demandId,
        title: task.title,
        executorKind: task.executorKind,
        requiredRoles: task.requiredRoles,
        workspaceBinding: task.workspaceBinding,
        priority: task.priority,
        dueAt: task.dueAt,
      },
    };
    const payload = JSON.stringify(frame);
    for (const [client, identity] of this.clients) {
      if (identity.executorId === null) continue;
      if (this.offerFilter !== undefined && !this.offerFilter(identity.executorId, task, at)) {
        continue;
      }
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.server !== null) {
      this.server.off('upgrade', this.handleUpgrade);
      this.server = null;
    }
    for (const client of this.clients.keys()) client.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  private ping(): void {
    if (this.closed) return;
    const { lastSeq } = eventSeqWindow(this.db);
    const frame = JSON.stringify({
      type: SERVER_PING,
      seq: lastSeq,
      at: new Date(this.clock()).toISOString(),
    });
    for (const client of this.clients.keys()) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== this.path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const afterParam = url.searchParams.get('after');
    const parsed = wsConnectQuerySchema.safeParse({
      token: url.searchParams.get('token') ?? '',
      ...(afterParam === null ? {} : { after: afterParam }),
    });
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      if (!parsed.success) {
        ws.close(4401, 'unauthorized');
        return;
      }
      let claims: TokenClaims;
      try {
        claims = verifyToken(parsed.data.token, this.secret);
      } catch {
        ws.close(4401, 'unauthorized');
        return;
      }
      this.handleConnection(ws, parsed.data.after, claims);
    });
  };

  private handleConnection(ws: WebSocket, after: number, claims: TokenClaims): void {
    const window = eventSeqWindow(this.db);
    const needsResync =
      (after > 0 && after < window.earliestSeq - 1) ||
      (after === 0 && window.earliestSeq > 1);
    if (needsResync) {
      ws.send(
        JSON.stringify({
          type: RESYNC_REQUIRED,
          lastSeq: window.lastSeq,
          earliestSeq: window.earliestSeq,
        }),
      );
    } else {
      for (const event of listEventsAfter(this.db, after, BACKLOG_LIMIT)) {
        ws.send(JSON.stringify(event));
      }
    }
    // S3: bind the token identity for the socket lifetime. Only executor tokens
    // carry an executorId; user/admin sockets receive the event stream only.
    this.clients.set(ws, {
      kind: claims.kind,
      executorId: claims.kind === 'executor' ? (claims.executorId ?? null) : null,
    });
    ws.on('message', (raw) => this.handleClientMessage(raw));
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  private handleClientMessage(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const message = wsClientMessageSchema.safeParse(parsed);
    if (!message.success) return;
    if (message.data.type === CLIENT_PONG || message.data.type === CLIENT_ACK) {
      // Keep-alive and cursor acknowledgements are transport-only.
    }
  }
}
