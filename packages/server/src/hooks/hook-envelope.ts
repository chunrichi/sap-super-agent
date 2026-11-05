import { createHash } from 'node:crypto';
import {
  HOOK_ENVELOPE_VERSION,
  type EventEnvelope,
  type HookEnvelope,
  type HookSubject,
} from '@sap-superagent/protocol';
import type { ResolvedHook } from './hook-config.js';

// ---------------------------------------------------------------------------
// S4: build the uniform outbound envelope (docs/008 §2) from a persisted event.
//
// Pure and deterministic: the same source event always produces the same
// `idempotencyKey`/`traceId`, so replays never create a second external order.
// `subject` carries IDs/versions only; the event `data` is copied verbatim into
// `payload` (adapters do the field mapping, not the core).
// ---------------------------------------------------------------------------

function stringData(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

function positiveIntData(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** `<demandId or subject.id>:<hookId>:<sha256(eventId)>` (docs/008 §2). */
export function hookIdempotencyKey(
  hook: ResolvedHook,
  event: Pick<EventEnvelope, 'id' | 'subject' | 'data'>,
): string {
  const demandId = stringData(event.data, 'demandId');
  const scope = demandId ?? event.subject.id;
  const digest = createHash('sha256').update(event.id, 'utf8').digest('hex');
  return `${scope}:${hook.id}:${digest}`;
}

export function buildHookSubject(event: EventEnvelope): HookSubject {
  const data = event.data;
  const demandId = stringData(data, 'demandId');
  const subjectDemandId = event.subject.type === 'demand' ? event.subject.id : undefined;
  const demandNo = stringData(data, 'demandNo');
  const stageRunId =
    stringData(data, 'stageRunId') ?? (event.subject.type === 'stage_run' ? event.subject.id : undefined);
  const artifactId =
    stringData(data, 'artifactId') ?? (event.subject.type === 'artifact' ? event.subject.id : undefined);
  const version = positiveIntData(data, 'version');
  const resolvedDemandId = demandId ?? subjectDemandId;
  return {
    type: event.subject.type,
    id: event.subject.id,
    ...(resolvedDemandId === undefined ? {} : { demandId: resolvedDemandId }),
    ...(demandNo === undefined ? {} : { demandNo }),
    ...(stageRunId === undefined ? {} : { stageRunId }),
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(version === undefined ? {} : { version }),
  };
}

/** Build (but do not send) the envelope for one enabled hook + one event. */
export function buildHookEnvelope(hook: ResolvedHook, event: EventEnvelope): HookEnvelope {
  return {
    eventId: event.id,
    eventType: event.type,
    eventVersion: HOOK_ENVELOPE_VERSION,
    occurredAt: event.at,
    subject: buildHookSubject(event),
    payload: { ...event.data },
    idempotencyKey: hookIdempotencyKey(hook, event),
    retry: {
      maxAttempts: hook.retry.maxAttempts,
      backoff: hook.retry.backoff,
      deadLetter: hook.retry.deadLetter,
    },
    traceId: event.id,
  };
}
