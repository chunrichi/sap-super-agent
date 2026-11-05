import type { FastifyReply } from 'fastify';
import { badRequest, internalError } from '../errors.js';

interface SchemaIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

interface SchemaError {
  readonly issues: ReadonlyArray<SchemaIssue>;
}

/** Minimal structural shape of a zod schema (avoids a direct zod dependency). */
export interface SchemaLike<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: SchemaError };
}

export function formatIssues(error: SchemaError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Validate request input; a schema mismatch is a client error (400). */
export function parseInput<T>(
  schema: SchemaLike<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(`${label} is invalid: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Validate a response we built; a mismatch is a server bug (500). */
export function sendValidated<T>(
  reply: FastifyReply,
  schema: SchemaLike<T>,
  value: unknown,
): FastifyReply {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw internalError(`response validation failed: ${formatIssues(parsed.error)}`);
  }
  return reply.send(parsed.data);
}
