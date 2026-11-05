import { z } from 'zod';

/** Stable error codes for the control-plane error envelope (docs/003 §4.1). */
export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'lease_expired',
  'invalid_state',
  'resync_required',
  'rate_limited',
  'internal_error',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

export const apiErrorBodySchema = z.object({ error: apiErrorSchema }).strict();
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  lease_expired: 409,
  invalid_state: 409,
  resync_required: 409,
  rate_limited: 429,
  internal_error: 500,
};

export interface ApiErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function errorBody(code: ErrorCode, message: string, options: ApiErrorOptions = {}): ApiErrorBody {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
    },
  };
  if (options.details !== undefined) {
    body.error.details = options.details;
  }
  return body;
}

export function httpStatusForError(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}
