import { ProblemType, type FieldError } from '@repo/contracts';

/**
 * Base class for every error a domain service is allowed to throw.
 *
 * Services describe WHAT went wrong; the global filter decides how it appears on the
 * wire (I3, CLAUDE.md § Backend). Nothing outside `common/filters` constructs an HTTP
 * response shape — that is what keeps one filter in charge of the wire format.
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  abstract readonly type: string;
  abstract readonly title: string;

  /** Field-level detail, present only on validation failures. */
  readonly errors?: FieldError[];

  constructor(message: string, errors?: FieldError[]) {
    super(message);
    this.name = new.target.name;
    if (errors) this.errors = errors;
    // Hides the constructor frames so the stack starts where the error was thrown.
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends DomainError {
  readonly status = 422;
  readonly type = ProblemType.VALIDATION_FAILED;
  readonly title = 'Validation failed';
}

export class UnauthenticatedError extends DomainError {
  readonly status = 401;
  readonly type = ProblemType.UNAUTHENTICATED;
  readonly title = 'Unauthenticated';
}

export class ForbiddenError extends DomainError {
  readonly status = 403;
  readonly type = ProblemType.FORBIDDEN;
  readonly title = 'Forbidden';
}

/**
 * Use this — not ForbiddenError — when a caller asks for a resource they do not own.
 * Returning 403 confirms the resource exists (I4).
 */
export class NotFoundError extends DomainError {
  readonly status = 404;
  readonly type = ProblemType.NOT_FOUND;
  readonly title = 'Not found';
}

export class ConflictError extends DomainError {
  readonly status = 409;
  readonly type = ProblemType.CONFLICT;
  readonly title = 'Conflict';
}

export class InsufficientStockError extends DomainError {
  readonly status = 409;
  readonly type = ProblemType.INSUFFICIENT_STOCK;
  readonly title = 'Insufficient stock';

  constructor(input: { sku: string; available: number }) {
    super(`Only ${input.available} unit(s) of ${input.sku} remain.`);
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  readonly status = 422;
  readonly type = ProblemType.IDEMPOTENCY_KEY_REUSED;
  readonly title = 'Idempotency key reused with a different request';
}

export class IllegalStateTransitionError extends DomainError {
  readonly status = 409;
  readonly type = ProblemType.ILLEGAL_STATE_TRANSITION;
  readonly title = 'Illegal state transition';

  constructor(input: { entity: string; from: string; to: string }) {
    super(`${input.entity} cannot move from ${input.from} to ${input.to}.`);
  }
}

export class PaymentDeclinedError extends DomainError {
  readonly status = 402;
  readonly type = ProblemType.PAYMENT_DECLINED;
  readonly title = 'Payment declined';
}

export class RateLimitedError extends DomainError {
  readonly status = 429;
  readonly type = ProblemType.RATE_LIMITED;
  readonly title = 'Too many requests';
}

/**
 * A dependency the request needs is unreachable — readiness uses this.
 *
 * Exists so the health controller can throw rather than hand-build a Problem Details
 * body: pr-reviewer showed the hand-built version shipping a hardcoded
 * `instance: '/health/ready'` that did not match the actual request path, which is
 * exactly the drift one filter owning the format is meant to prevent (I3).
 */
export class NotReadyError extends DomainError {
  readonly status = 503;
  readonly type = ProblemType.INTERNAL;
  readonly title = 'Not ready';

  constructor(unreachable: string[]) {
    super(`Unreachable: ${unreachable.join(', ')}`);
  }
}
