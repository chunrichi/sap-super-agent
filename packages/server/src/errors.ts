import { httpStatusForError, errorBody, type ApiErrorBody, type ErrorCode } from '@sap-superagent/protocol';

export interface ApiErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/** An error that maps directly onto the docs/003 §4.1 error envelope. */
export class ApiHttpError extends Error {
  readonly code: ErrorCode;
  readonly options: ApiErrorOptions;

  constructor(code: ErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiHttpError';
    this.code = code;
    this.options = options;
  }

  get httpStatus(): number {
    return httpStatusForError(this.code);
  }

  toBody(): ApiErrorBody {
    return errorBody(this.code, this.message, this.options);
  }
}

export function badRequest(message: string, details?: Record<string, unknown>): ApiHttpError {
  return new ApiHttpError('bad_request', message, details === undefined ? {} : { details });
}

export function unauthorized(message = 'authentication required'): ApiHttpError {
  return new ApiHttpError('unauthorized', message);
}

export function forbidden(message = 'operation not allowed'): ApiHttpError {
  return new ApiHttpError('forbidden', message);
}

export function notFound(message: string): ApiHttpError {
  return new ApiHttpError('not_found', message);
}

export function conflict(message: string, details?: Record<string, unknown>): ApiHttpError {
  return new ApiHttpError('conflict', message, details === undefined ? {} : { details });
}

export function invalidState(message: string, details?: Record<string, unknown>): ApiHttpError {
  return new ApiHttpError('invalid_state', message, details === undefined ? {} : { details });
}

export function leaseExpired(message: string): ApiHttpError {
  return new ApiHttpError('lease_expired', message, { retryable: true });
}

export function resyncRequired(
  message: string,
  details: Record<string, unknown>,
): ApiHttpError {
  return new ApiHttpError('resync_required', message, { retryable: true, details });
}

export function internalError(message: string): ApiHttpError {
  return new ApiHttpError('internal_error', message);
}
