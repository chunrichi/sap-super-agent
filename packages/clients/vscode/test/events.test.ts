// Realtime WS client unit tests (docs/003 §4.4, docs/005 §2.5, docs/009 #3/#10):
// cursor persistence, reconnect with exponential backoff, resync handling and
// task.offered transport frames — all without a real extension host or socket.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EventStreamClient,
  appendAfter,
  type EventStreamStatus,
  type SocketLike,
} from '../src/events.js';

const NOW = '2026-11-05T00:00:00.000Z';

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private readonly handlers = new Map<string, Array<(payload?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  on(event: 'open' | 'message' | 'close' | 'error', listener: (payload?: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }

  emit(event: 'open' | 'message' | 'close' | 'error', payload?: unknown): void {
    if (event === 'open') this.readyState = 1;
    if (event === 'close' || event === 'error') this.readyState = 3;
    for (const listener of [...(this.handlers.get(event) ?? [])]) listener(payload);
  }

  message(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }
}

interface Harness {
  client: EventStreamClient;
  events: any[];
  offered: any[];
  resyncs: any[];
  seqs: number[];
  statuses: EventStreamStatus[];
  timers: Array<{ callback: () => void; delayMs: number }>;
  fireTimer(): void;
  socket(): FakeSocket;
}

function makeHarness(afterSeq = 0): Harness {
  const events: any[] = [];
  const offered: any[] = [];
  const resyncs: any[] = [];
  const seqs: number[] = [];
  const statuses: EventStreamStatus[] = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const client = new EventStreamClient({
    url: 'ws://127.0.0.1:3080/api/v1/events?token=abc',
    afterSeq,
    createSocket: (url) => new FakeSocket(url),
    onEvent: (event) => events.push(event),
    onTaskOffered: (frame) => offered.push(frame),
    onResync: (frame) => resyncs.push(frame),
    onSeq: (seq) => seqs.push(seq),
    onStatus: (status) => statuses.push(status),
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      const index = (handle as unknown as number) - 1;
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    client,
    events,
    offered,
    resyncs,
    seqs,
    statuses,
    timers,
    fireTimer: () => {
      const next = timers.shift();
      next?.callback();
    },
    socket: () => FakeSocket.instances[FakeSocket.instances.length - 1]!,
  };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

describe('appendAfter', () => {
  it('sets the replay cursor without dropping the token', () => {
    const url = appendAfter('ws://127.0.0.1:3080/api/v1/events?token=abc', 42);
    expect(url).toContain('token=abc');
    expect(url).toContain('after=42');
  });
});

describe('EventStreamClient', () => {
  it('connects with the persisted cursor and forwards persisted events', () => {
    const harness = makeHarness(7);
    harness.client.start();
    expect(harness.socket().url).toContain('after=7');

    harness.socket().emit('open');
    expect(harness.client.status).toBe('online');
    expect(harness.statuses).toEqual(['connecting', 'online']);

    harness.socket().message({
      seq: 8,
      id: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
      type: 'task.updated',
      at: NOW,
      subject: { type: 'task', id: '01J8ZQ9W3K5M2V7X4C6B8N0P1R' },
      data: { state: 'pending' },
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.client.lastSeq).toBe(8);
    expect(harness.seqs).toEqual([8]);

    // A duplicated/stale frame never moves the cursor backwards.
    harness.socket().message({
      seq: 3,
      id: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
      type: 'task.updated',
      at: NOW,
      subject: { type: 'task', id: '01J8ZQ9W3K5M2V7X4C6B8N0P1R' },
      data: {},
    });
    expect(harness.client.lastSeq).toBe(8);
    expect(harness.seqs).toEqual([8]);
  });

  it('forwards task.offered frames without moving the cursor', () => {
    const harness = makeHarness(3);
    harness.client.start();
    harness.socket().emit('open');
    harness.socket().message({
      type: 'task.offered',
      at: NOW,
      subject: { type: 'task', id: '01J8ZQ9W3K5M2V7X4C6B8N0P1R' },
      task: {
        id: '01J8ZQ9W3K5M2V7X4C6B8N0P1R',
        demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
        title: '取数实现',
        executorKind: 'vscode',
        requiredRoles: [],
        workspaceBinding: null,
        priority: 'normal',
        dueAt: null,
      },
    });
    expect(harness.offered).toHaveLength(1);
    expect(harness.client.lastSeq).toBe(3);
    expect(harness.events).toHaveLength(0);
  });

  it('answers server.ping and asks for a full pull on resync_required', () => {
    const harness = makeHarness(5);
    harness.client.start();
    const socket = harness.socket();
    socket.emit('open');

    socket.message({ type: 'server.ping', seq: 9, at: NOW });
    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: 'client.pong' });

    socket.message({ type: 'resync_required', lastSeq: 120, earliestSeq: 100 });
    expect(harness.resyncs).toEqual([{ lastSeq: 120, earliestSeq: 100 }]);
    expect(harness.client.lastSeq).toBe(120);
    expect(harness.seqs).toContain(120);
  });

  it('ignores malformed frames and keeps the stream alive', () => {
    const harness = makeHarness(0);
    harness.client.start();
    const socket = harness.socket();
    socket.emit('open');
    socket.emit('message', 'not-json');
    socket.emit('message', JSON.stringify([1, 2, 3]));
    socket.emit('message', JSON.stringify({ type: 'mystery' }));
    expect(harness.events).toHaveLength(0);
    expect(harness.client.status).toBe('online');
  });

  it('reconnects with exponential backoff and resets after a successful open', () => {
    const harness = makeHarness(10);
    harness.client.start();
    harness.socket().emit('open');

    // First disconnect: 1s interval → presence policy doubles it (2s).
    harness.socket().emit('close');
    expect(harness.timers.map((timer) => timer.delayMs)).toEqual([2_000]);
    harness.fireTimer();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toContain('after=10');
    expect(FakeSocket.instances[1]!.url).toContain('after=10');

    harness.socket().emit('close');
    expect(harness.timers.map((timer) => timer.delayMs)).toEqual([4_000]);
    harness.fireTimer();
    harness.socket().emit('close');
    expect(harness.timers.map((timer) => timer.delayMs)).toEqual([8_000]);

    // A successful open resets the backoff.
    harness.fireTimer();
    harness.socket().emit('open');
    harness.socket().emit('close');
    expect(harness.timers.map((timer) => timer.delayMs)).toEqual([2_000]);
  });

  it('stop() closes the socket and cancels pending reconnects', () => {
    const harness = makeHarness(0);
    harness.client.start();
    const socket = harness.socket();
    socket.emit('open');
    socket.emit('close');
    expect(harness.timers).toHaveLength(1);

    harness.client.stop();
    expect(harness.client.status).toBe('offline');
    expect(harness.timers).toHaveLength(0);
    harness.client.stop(); // idempotent
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('seek() only moves the cursor forward (REST full pull result)', () => {
    const harness = makeHarness(5);
    harness.client.start();
    harness.client.seek(12);
    expect(harness.client.lastSeq).toBe(12);
    harness.client.seek(4);
    expect(harness.client.lastSeq).toBe(12);
  });
});
