import { describe, expect, it } from 'vitest';
import {
  eventEnvelopeSchema,
  eventsQuerySchema,
  eventsResponseSchema,
  wsClientMessageSchema,
} from '../src/index.js';
import { DEMAND_ID, NOW, ULID_A, ULID_B } from './fixtures.js';

const envelope = {
  seq: 42,
  id: ULID_A,
  type: 'task.offered',
  at: NOW,
  subject: { type: 'task', id: ULID_B },
  data: { taskId: ULID_B, demandId: DEMAND_ID },
};

describe('event envelope (docs/003 §4.4)', () => {
  it('round-trips a valid envelope', () => {
    const parsed = eventEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.subject.type).toBe('task');
  });

  it('rejects seq 0 because the global cursor starts at 1', () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope, seq: 0 }).success).toBe(false);
  });

  it('rejects unknown event types', () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope, type: 'demand.exploded' }).success).toBe(
      false,
    );
  });

  it('rejects unknown subject types', () => {
    expect(
      eventEnvelopeSchema.safeParse({ ...envelope, subject: { type: 'ticket', id: ULID_B } })
        .success,
    ).toBe(false);
  });

  it('requires ISO-8601 UTC timestamps', () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope, at: '2026-11-05 00:00:00' }).success).toBe(
      false,
    );
  });
});

describe('events query/response', () => {
  it('coerces and defaults cursor + limit', () => {
    const parsed = eventsQuerySchema.parse({});
    expect(parsed).toEqual({ after: 0, limit: 200 });
    expect(eventsQuerySchema.parse({ after: '17', limit: '5' })).toEqual({ after: 17, limit: 5 });
  });

  it('caps the page size', () => {
    expect(eventsQuerySchema.safeParse({ limit: 100_000 }).success).toBe(false);
  });

  it('accepts an empty replay window', () => {
    const response = eventsResponseSchema.parse({ events: [], lastSeq: 0, earliestSeq: 0 });
    expect(response.events).toHaveLength(0);
  });
});

describe('WS client messages', () => {
  it('accepts pong and ack', () => {
    expect(wsClientMessageSchema.safeParse({ type: 'client.pong' }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: 'client.ack', seq: 12 }).success).toBe(true);
  });

  it('rejects server-only types coming from a client', () => {
    expect(wsClientMessageSchema.safeParse({ type: 'server.ping' }).success).toBe(false);
  });
});
