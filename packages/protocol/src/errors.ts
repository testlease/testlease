/**
 * Stable, machine-readable error codes. Clients switch on `code`, never on the message text.
 * HTTP status codes are a transport detail; the code is the contract.
 */
export const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  POOL_NOT_FOUND: 'POOL_NOT_FOUND',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  LEASE_NOT_FOUND: 'LEASE_NOT_FOUND',
  /** No resource in the pool can ever satisfy the requested tags (regardless of state). */
  NO_MATCHING_RESOURCE: 'NO_MATCHING_RESOURCE',
  /** Compatible resources exist but none is available right now and the caller asked not to wait. */
  POOL_EXHAUSTED: 'POOL_EXHAUSTED',
  /** The caller waited for `waitTimeoutMs` and no compatible resource became available. */
  ACQUIRE_TIMEOUT: 'ACQUIRE_TIMEOUT',
  /** The caller cancelled the acquisition (client disconnected / AbortSignal). */
  ACQUIRE_ABORTED: 'ACQUIRE_ABORTED',
  /** The lease existed but its TTL elapsed; the resource may already belong to someone else. */
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  /** The lease has already been released (or quarantined) and cannot be renewed. */
  LEASE_NOT_ACTIVE: 'LEASE_NOT_ACTIVE',
  /** The caller presented an owner that does not match the lease owner. */
  LEASE_OWNERSHIP_MISMATCH: 'LEASE_OWNERSHIP_MISMATCH',
  /** A clientRequestId is bound to an active lease with a different pool/tags/owner. */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RESOURCE_QUARANTINED: 'RESOURCE_QUARANTINED',
  RESOURCE_NOT_QUARANTINED: 'RESOURCE_NOT_QUARANTINED',
  RESOURCE_LEASED: 'RESOURCE_LEASED',
  RESOURCE_DISABLED: 'RESOURCE_DISABLED',
  SECRET_RESOLUTION_FAILED: 'SECRET_RESOLUTION_FAILED',
  SERVER_SHUTTING_DOWN: 'SERVER_SHUTTING_DOWN',
  /** Unknown route. */
  NOT_FOUND: 'NOT_FOUND',
  /** Client-side: the server could not be reached (connection refused, DNS, reset). */
  UNAVAILABLE: 'UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const errorHttpStatus: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  POOL_NOT_FOUND: 404,
  RESOURCE_NOT_FOUND: 404,
  LEASE_NOT_FOUND: 404,
  NO_MATCHING_RESOURCE: 409,
  POOL_EXHAUSTED: 409,
  ACQUIRE_TIMEOUT: 409,
  ACQUIRE_ABORTED: 499,
  LEASE_EXPIRED: 409,
  LEASE_NOT_ACTIVE: 409,
  LEASE_OWNERSHIP_MISMATCH: 403,
  IDEMPOTENCY_CONFLICT: 409,
  RESOURCE_QUARANTINED: 409,
  RESOURCE_NOT_QUARANTINED: 409,
  RESOURCE_LEASED: 409,
  RESOURCE_DISABLED: 409,
  SECRET_RESOLUTION_FAILED: 500,
  SERVER_SHUTTING_DOWN: 503,
  NOT_FOUND: 404,
  UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class TestLeaseError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TestLeaseError';
    this.code = code;
    this.details = details;
    this.status = errorHttpStatus[code];
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }

  static fromBody(body: unknown, fallbackStatus?: number): TestLeaseError {
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as ErrorBody).error === 'object'
    ) {
      const e = (body as ErrorBody).error;
      const code = isErrorCode(e.code) ? e.code : ErrorCodes.INTERNAL_ERROR;
      return new TestLeaseError(code, e.message ?? code, e.details);
    }
    return new TestLeaseError(
      ErrorCodes.INTERNAL_ERROR,
      `Unexpected response${fallbackStatus ? ` (HTTP ${fallbackStatus})` : ''}`,
    );
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in errorHttpStatus;
}

export function isTestLeaseError(err: unknown): err is TestLeaseError {
  return err instanceof TestLeaseError || (err instanceof Error && err.name === 'TestLeaseError');
}
