// Realtime event-stream client for the VSCode extension (docs/003 §4.4,
// docs/005 §2.5). Transport only: no `vscode` import, so reconnect/resync/cursor
// behaviour is unit-tested with a fake socket and injected timers.
//
// Contract:
// - subscribe `GET /api/v1/events` over WS with `after=<lastSeq>` and replay the
//   gap on every reconnect (the server sends the retained backlog);
// - `resync_required` control frame => caller does a full REST pull, the cursor
//   jumps to the server's `lastSeq`;
// - `server.ping` => answer `client.pong` (keep-alive + clock calibration);
// - `task.offered` is a transport hint with no `seq` (it never moves the cursor).
import { WebSocket } from 'ws';
import {
  CLIENT_PONG,
  RESYNC_REQUIRED,
  SERVER_PING,
  type EventEnvelope,
  type WsTaskOfferedFrame,
} from '@sap-superagent/protocol';
import { nextHeartbeatDelayMs } from './presence.js';

/** Minimal socket surface the client needs (real `ws` or a test double). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'message' | 'close' | 'error', listener: (payload?: unknown) => void): void;
}

/** Ready-state value of an open `ws` socket. */
export const SOCKET_OPEN = 1;

/** Default socket factory: the extension host runs on Node (VSCode ≥1.90). */
export function createWebSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    on: (event, listener) => {
      socket.on(event, ((payload?: unknown) => listener(payload)) as (...args: unknown[]) => void);
    },
  };
}

export type EventStreamStatus = 'connecting' | 'online' | 'offline';

export interface ResyncFrame {
  lastSeq: number;
  earliestSeq: number;
}

export interface EventStreamOptions {
  /** `ws(s)://…/api/v1/events?token=…` **without** `after`; the client appends it. */
  url: string;
  /** Persisted cursor from a previous session (`globalState`), `0` when none. */
  afterSeq: number;
  createSocket?: (url: string) => SocketLike;
  onEvent: (event: EventEnvelope) => void;
  onTaskOffered?: (frame: WsTaskOfferedFrame) => void;
  onResync?: (frame: ResyncFrame) => void;
  onStatus?: (status: EventStreamStatus) => void;
  /** Persist the cursor after every persisted event (extension: globalState). */
  onSeq?: (seq: number) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Backoff policy reused from presence: 1s × 2^n, capped (docs/005 §2.5). */
  baseRetryMs?: number;
}

export const EVENT_STREAM_BASE_RETRY_MS = 1_000;

/** Append/replace the replay cursor on the WS URL. */
export function appendAfter(url: string, after: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('after', String(after));
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One WS subscription with exponential-backoff reconnects and a gap-free
 * cursor. `start()` is idempotent; `stop()` closes the socket and cancels timers.
 */
export class EventStreamClient {
  private readonly options: EventStreamOptions;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly setTimer: NonNullable<EventStreamOptions['setTimer']>;
  private readonly clearTimer: NonNullable<EventStreamOptions['clearTimer']>;
  private readonly baseRetryMs: number;
  private afterSeq: number;
  private socket: SocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failureCount = 0;
  private running = false;
  private state: EventStreamStatus = 'offline';

  constructor(options: EventStreamOptions) {
    this.options = options;
    this.createSocket = options.createSocket ?? createWebSocket;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.baseRetryMs = options.baseRetryMs ?? EVENT_STREAM_BASE_RETRY_MS;
    this.afterSeq = options.afterSeq;
  }

  get lastSeq(): number {
    return this.afterSeq;
  }

  get status(): EventStreamStatus {
    return this.state;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Subscribe now; subsequent reconnects are automatic until `stop()`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.failureCount = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearReconnect();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.close(1000, 'client_shutdown');
      } catch {
        // Best effort: a broken socket must not block window close.
      }
    }
    this.setStatus('offline');
  }

  /** Record a cursor learned from a REST full pull after `resync_required`. */
  seek(seq: number): void {
    if (seq > this.afterSeq) this.afterSeq = seq;
  }

  /** Feed one raw frame as if it arrived from the socket (used by tests). */
  handleFrame(raw: string): void {
    this.handleMessage(raw);
  }

  private connect(): void {
    if (!this.running) return;
    this.setStatus('connecting');
    const socket = this.createSocket(appendAfter(this.options.url, this.afterSeq));
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.failureCount = 0;
      this.setStatus('online');
    });
    socket.on('message', (payload) => {
      if (this.socket !== socket) return;
      this.handleMessage(typeof payload === 'string' ? payload : String(payload));
    });
    const onGone = (): void => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus('offline');
      this.scheduleReconnect();
    };
    socket.on('close', onGone);
    socket.on('error', onGone);
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Malformed frames never break the stream.
    }
    if (!isRecord(parsed)) return;
    const type = parsed['type'];
    if (type === RESYNC_REQUIRED) {
      const lastSeq = typeof parsed['lastSeq'] === 'number' ? parsed['lastSeq'] : this.afterSeq;
      const earliestSeq = typeof parsed['earliestSeq'] === 'number' ? parsed['earliestSeq'] : 0;
      this.seek(lastSeq);
      this.options.onSeq?.(this.afterSeq);
      this.options.onResync?.({ lastSeq, earliestSeq });
      return;
    }
    if (type === SERVER_PING) {
      const socket = this.socket;
      if (socket !== null && socket.readyState === SOCKET_OPEN) {
        try {
          socket.send(JSON.stringify({ type: CLIENT_PONG }));
        } catch {
          // Keep-alive is best effort.
        }
      }
      return;
    }
    if (type === 'task.offered') {
      this.options.onTaskOffered?.(parsed as unknown as WsTaskOfferedFrame);
      return;
    }
    const seq = parsed['seq'];
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) return;
    if (seq > this.afterSeq) {
      this.afterSeq = seq;
      this.options.onSeq?.(seq);
    }
    this.options.onEvent(parsed as unknown as EventEnvelope);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.clearReconnect();
    this.failureCount += 1;
    // Reuse the presence backoff: 1s, 2s, 4s, 8s … capped at 60s.
    const delayMs = nextHeartbeatDelayMs({
      intervalMs: this.baseRetryMs,
      failureCount: this.failureCount,
      minMs: this.baseRetryMs,
    });
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: EventStreamStatus): void {
    if (this.state === status) return;
    this.state = status;
    this.options.onStatus?.(status);
  }
}
