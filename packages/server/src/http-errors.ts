import { ErrorCodes, isTestLeaseError, type ErrorBody, type TestLeaseError } from '@testlease/protocol';
import type { Logger } from '@testlease/core';

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
}

/** Maps any thrown value to a structured error response without leaking internals. */
export function toErrorResponse(err: unknown, log: Logger, requestId: string): ErrorResponse {
  if (isTestLeaseError(err)) {
    const e = err as TestLeaseError;
    // 499 is not a real HTTP status we can send meaningfully; the client is gone anyway.
    const status = e.code === ErrorCodes.ACQUIRE_ABORTED ? 400 : e.status;
    return { status, body: e.toBody() };
  }
  if (err instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: `Request body is not valid JSON: ${err.message}`,
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error(
    {
      event: 'http.internal_error',
      requestId,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    },
    'unhandled error',
  );
  return {
    status: 500,
    body: {
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: `Internal error (request ${requestId}). See server logs.`,
        details: { requestId },
      },
    },
  };
}
