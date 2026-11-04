import { z } from 'zod';
import {
  CLIENT_ACK,
  CLIENT_PONG,
  eventSubjectTypeSchema,
  eventTypeSchema,
} from './enums.js';
import { isoDateTimeSchema } from './entities.js';
import { ulidSchema } from './ids.js';

// ---------------------------------------------------------------------------
// Event log + WS envelope (docs/003 §4.4)
// ---------------------------------------------------------------------------

export const eventSubjectSchema = z
  .object({
    type: eventSubjectTypeSchema,
    id: z.string().min(1),
  })
  .strict();
export type EventSubject = z.infer<typeof eventSubjectSchema>;

export const eventEnvelopeSchema = z
  .object({
    /** Global, gap-free append-only sequence number (>= 1). */
    seq: z.number().int().positive(),
    id: ulidSchema,
    type: eventTypeSchema,
    at: isoDateTimeSchema,
    subject: eventSubjectSchema,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const eventsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().positive().max(500).default(200),
  })
  .strict();
export type EventsQuery = z.infer<typeof eventsQuerySchema>;

export const eventsResponseSchema = z
  .object({
    events: z.array(eventEnvelopeSchema),
    /** Highest sequence number the server knows about (0 when the log is empty). */
    lastSeq: z.number().int().nonnegative(),
    /** Oldest retained sequence number, `0` when the log is empty. */
    earliestSeq: z.number().int().nonnegative(),
  })
  .strict();
export type EventsResponse = z.infer<typeof eventsResponseSchema>;

/** Transport-only WS messages sent by clients (docs/003 §4.4). */
export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(CLIENT_PONG), seq: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal(CLIENT_ACK), seq: z.number().int().positive() }).strict(),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

/** WS handshake query: token + optional replay cursor (`after`). */
export const wsConnectQuerySchema = z
  .object({
    token: z.string().min(1),
    after: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();
export type WsConnectQuery = z.infer<typeof wsConnectQuerySchema>;

export function isPersistedEventType(type: string): boolean {
  return eventTypeSchema.safeParse(type).success;
}
