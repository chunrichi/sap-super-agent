import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { EventEnvelope } from '@sap-superagent/protocol';
import {
  api,
  createAdminTask,
  createDemandWithArtifact,
  readEvents,
  startTestServer,
  type TestServer,
} from './helpers.js';

interface Waiter {
  predicate: (message: any) => boolean;
  resolve: (message: any) => void;
  timer: NodeJS.Timeout;
}

interface Probe {
  socket: WebSocket;
  messages: any[];
  waitFor(predicate: (message: any) => boolean, timeoutMs?: number): Promise<any>;
  closed: Promise<{ code: number; reason: string }>;
}

function openProbe(url: string): Promise<Probe> {
  return new Promise((resolveProbe, rejectTimer) => {
    const socket = new WebSocket(url);
    const messages: any[] = [];
    const waiters: Waiter[] = [];
    socket.on('message', (data) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      messages.push(parsed);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(parsed)) continue;
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(parsed);
      }
    });
    const closed = new Promise<{ code: number; reason: string }>((resolveClose) => {
      socket.once('close', (code, reason) => resolveClose({ code, reason: String(reason) }));
    });
    const probe: Probe = {
      socket,
      messages,
      closed,
      waitFor: (predicate, timeoutMs = 3_000) =>
        new Promise((resolveMessage, rejectMessage) => {
          const existing = messages.find(predicate);
          if (existing !== undefined) {
            resolveMessage(existing);
            return;
          }
          const timer = setTimeout(() => {
            const index = waiters.findIndex((candidate) => candidate.timer === timer);
            if (index >= 0) waiters.splice(index, 1);
            rejectMessage(new Error('timed out waiting for a WS message'));
          }, timeoutMs);
          waiters.push({ predicate, resolve: resolveMessage, timer });
        }),
    };
    socket.once('open', () => resolveProbe(probe));
    socket.once('error', (error) => rejectTimer(error));
  });
}

function socketUrl(server: TestServer, token: string, after: number): string {
  const wsBase = server.running.url.replace('http://', 'ws://');
  return `${wsBase}/api/v1/events?token=${encodeURIComponent(token)}&after=${after}`;
}

describe('control-plane WebSocket event stream', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.dispose();
  });

  it('replays the retained backlog after the cursor', async () => {
    await createDemandWithArtifact(server);
    const { lastSeq } = await readEvents(server);

    const full = await openProbe(socketUrl(server, server.userToken, 0));
    try {
      const firstEvent = await full.waitFor((message) => message.seq === 1);
      expect(firstEvent.type).toBe('demand.created');
      await full.waitFor((message) => message.seq === lastSeq);
      expect(full.messages.map((message: EventEnvelope) => message.seq)).toEqual(
        Array.from({ length: lastSeq }, (_, index) => index + 1),
      );
    } finally {
      full.socket.close();
    }

    const tail = await openProbe(socketUrl(server, server.userToken, lastSeq - 2));
    try {
      await tail.waitFor((message) => message.seq === lastSeq - 1);
      await tail.waitFor((message) => message.seq === lastSeq);
      expect(tail.messages.map((message: EventEnvelope) => message.seq)).toEqual([
        lastSeq - 1,
        lastSeq,
      ]);
    } finally {
      tail.socket.close();
    }
  });

  it('broadcasts newly appended events to connected clients', async () => {
    const { lastSeq } = await readEvents(server);
    const probe = await openProbe(socketUrl(server, server.userToken, lastSeq));
    try {
      const created = await api<{ demand: { id: string } }>(server, '/api/v1/demands', {
        method: 'POST',
        token: server.userToken,
        body: {
          title: 'R-9002 live event',
          description: 'live broadcast',
          acceptanceCriteria: [],
          priority: 'normal',
          requester: { userId: 'DEV001' },
        },
      });
      expect(created.status).toBe(200);
      const live = await probe.waitFor(
        (message) => message.type === 'demand.created' && message.subject.id === created.body.demand.id,
      );
      expect(live.subject).toEqual({ type: 'demand', id: created.body.demand.id });
    } finally {
      probe.socket.close();
    }
  });

  it('ignores invalid client frames and keeps the stream alive', async () => {
    const { lastSeq } = await readEvents(server);
    const probe = await openProbe(socketUrl(server, server.userToken, lastSeq));
    try {
      probe.socket.send('not-json');
      probe.socket.send(JSON.stringify({ type: 'client.pong' }));
      probe.socket.send(JSON.stringify({ type: 'client.ack', seq: lastSeq }));
      probe.socket.send(JSON.stringify({ type: 'client.unknown' }));

      const created = await api<{ demand: { id: string } }>(server, '/api/v1/demands', {
        method: 'POST',
        token: server.userToken,
        body: {
          title: 'R-9003 after control frames',
          description: 'still connected',
          acceptanceCriteria: [],
          priority: 'low',
          requester: { userId: 'DEV002' },
        },
      });
      await probe.waitFor(
        (message) =>
          message.type === 'demand.created' && message.subject.id === created.body.demand.id,
      );
    } finally {
      probe.socket.close();
    }
  });

  it('closes the socket with 4401 when the token is invalid', async () => {
    const socket = new WebSocket(socketUrl(server, 'not-a-real-token', 0));
    const closed = await new Promise<{ code: number }>((resolveClose) => {
      socket.once('close', (code) => resolveClose({ code }));
      socket.once('error', () => undefined);
    });
    expect(closed.code).toBe(4401);
  });

  it('offers newly created tasks as a transport frame, not as a persisted event', async () => {
    const { demandId } = await createDemandWithArtifact(server);
    const { lastSeq } = await readEvents(server);
    const probe = await openProbe(socketUrl(server, server.userToken, lastSeq));
    try {
      const created = await createAdminTask(server, {
        demandId,
        title: 'R-9004 offered task',
        executorKind: 'vscode',
        requiredRoles: [],
      });
      expect(created.status).toBe(200);

      const frame = await probe.waitFor((message) => message.type === 'task.offered');
      expect(frame.subject).toEqual({ type: 'task', id: created.body.task.id });
      expect(frame.task).toMatchObject({
        id: created.body.task.id,
        executorKind: 'vscode',
        priority: 'normal',
        workspaceBinding: null,
      });
      // Transport-only hint: no cursor, and never persisted in the event log.
      expect(frame.seq).toBeUndefined();
      const events = await readEvents(server, 0);
      expect(events.events.map((event) => event.type)).not.toContain('task.offered');
    } finally {
      probe.socket.close();
    }
  });

  it('sends periodic server.ping keep-alives', async () => {
    const pingServer = await startTestServer({ overrides: { wsPingMs: 30 } });
    try {
      const { lastSeq } = await readEvents(pingServer);
      const probe = await openProbe(socketUrl(pingServer, pingServer.userToken, lastSeq));
      try {
        const ping = await probe.waitFor((message) => message.type === 'server.ping');
        expect(ping.seq).toBe(lastSeq);
        expect(typeof ping.at).toBe('string');
      } finally {
        probe.socket.close();
      }
    } finally {
      await pingServer.dispose();
    }
  });

  it('sends a resync frame when the cursor fell outside the retention window', async () => {
    const resyncServer = await startTestServer({
      overrides: { eventRetentionMs: 40, heartbeatSweepMs: 15 },
    });
    try {
      await createDemandWithArtifact(resyncServer);
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      const probe = await openProbe(socketUrl(resyncServer, resyncServer.userToken, 0));
      try {
        const frame = await probe.waitFor((message) => message.type === 'resync_required');
        expect(frame.lastSeq).toBeGreaterThan(1);
        expect(frame.earliestSeq).toBeGreaterThan(1);
      } finally {
        probe.socket.close();
      }
    } finally {
      await resyncServer.dispose();
    }
  });
});
