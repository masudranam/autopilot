import { z } from 'zod';

/**
 * RFC 9457 Problem Details — the only error shape this API produces (invariant I3).
 *
 * `errors[]` appears only on validation failures. `traceId` is on every response and
 * correlates to the structured logs for that request.
 */
/**
 * One field-level validation error. Named `fieldError` rather than `problemDetail`
 * because a single character between `problemDetailSchema` and `problemDetailsSchema`
 * is not enough distance between "one bad field" and "the whole RFC 9457 envelope".
 */
export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;

export const problemDetailsSchema = z.object({
  type: z.url(),
  title: z.string(),
  status: z.int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  traceId: z.string(),
  errors: z.array(fieldErrorSchema).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const PROBLEM_TYPE_BASE = 'https://agentic-shop.dev/errors';

/**
 * Canonical problem types. Centralised so the `type` URI is stable — it is part of
 * the API contract, and clients are entitled to switch on it.
 */
export const ProblemType = {
  VALIDATION_FAILED: `${PROBLEM_TYPE_BASE}/validation-failed`,
  UNAUTHENTICATED: `${PROBLEM_TYPE_BASE}/unauthenticated`,
  FORBIDDEN: `${PROBLEM_TYPE_BASE}/forbidden`,
  NOT_FOUND: `${PROBLEM_TYPE_BASE}/not-found`,
  CONFLICT: `${PROBLEM_TYPE_BASE}/conflict`,
  INSUFFICIENT_STOCK: `${PROBLEM_TYPE_BASE}/insufficient-stock`,
  IDEMPOTENCY_KEY_REUSED: `${PROBLEM_TYPE_BASE}/idempotency-key-reused`,
  ILLEGAL_STATE_TRANSITION: `${PROBLEM_TYPE_BASE}/illegal-state-transition`,
  PAYMENT_DECLINED: `${PROBLEM_TYPE_BASE}/payment-declined`,
  RATE_LIMITED: `${PROBLEM_TYPE_BASE}/rate-limited`,
  INTERNAL: `${PROBLEM_TYPE_BASE}/internal`,
} as const;

export type ProblemTypeUri = (typeof ProblemType)[keyof typeof ProblemType];
