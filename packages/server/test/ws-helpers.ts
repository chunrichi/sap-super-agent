// Shared WS probe helpers for control-plane integration tests (H0 §1.8, S3).
// Kept out of *.test.ts so both the event-stream and multi-user suites use the
// same socket handling without a real client.
import { WebSocket } from 'ws';

interface Waiter {
  predicate: (message: any) => boolean;
  resolve: (message: any) => void;
  timer: NodeJS.Timeout;
}

export interface Probe {
  socket: WebSocket;
  messages: any[];
  waitFor(predicate: (message: any) => boolean, timeoutMs?: number): Promise<any>;
  closed: Promise<{ code: number; reason: string }>;
}

export function openProbe(url: string): Promise<Probe> {
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

/** `ws(s)://<control plane>/api/v1/events?token=<token>&after=<seq>`. */
export function socketUrl(baseUrl: string, token: string, after: number): string {
  const wsBase = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');
  return `${wsBase}/api/v1/events?token=${encodeURIComponent(token)}&after=${after}`;
}

/** Resolve after a short quiet period so "did NOT receive" assertions are meaningful. */
export function settle(ms = 120): Promise<void> {
  return new Promise((resolveSettle) => setTimeout(resolveSettle, ms));
}
