import { z } from 'zod';

/**
 * Identity contracts (SPEC.md F7 — registration).
 *
 * The only declaration of these shapes; apps import the inferred types (I2, ADR-0002).
 * Login, tokens and sessions are F8/F9 and are deliberately absent here.
 */

/** Minimum password length (F7/AC2). Exported so a client can state the rule up front. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Upper bound on a password. Argon2id has no practical length limit, so without a cap
 * a client can spend the server's memory-hard budget on a megabyte of input — the
 * hash cost is per-call, but the copy and the request buffer are not free.
 */
export const PASSWORD_MAX_LENGTH = 200;

/** RFC 5321 caps a forward path at 254 octets; longer is not a deliverable address. */
export const EMAIL_MAX_LENGTH = 254;

export const NAME_MAX_LENGTH = 100;

/**
 * A submitted email address.
 *
 * Trimmed before validation so a trailing space from an autofill is not a 422, and
 * length-capped before the format check. Canonicalisation to lower case happens
 * server-side in the auth service — the database stores the canonical form and its
 * unique index is what actually enforces AC4, so the rule cannot live only here where
 * a client controls whether it runs.
 */
export const emailSchema = z
  .string()
  .trim()
  .max(EMAIL_MAX_LENGTH, `Must be at most ${EMAIL_MAX_LENGTH} characters`)
  .pipe(z.email('Must be a valid email address'));

/**
 * Password shape only — length, not strength.
 *
 * The "not in a common-password list" half of AC2 is enforced in the API and not in
 * this schema on purpose: the blocklist is a server-side dataset, and shipping it
 * through a shared contracts package would put it in the browser bundle of every app
 * that imports anything from here. Both halves surface identically on the wire — 422
 * with a `password` entry in `errors[]` — because both go through the one Problem
 * Details filter.
 *
 * Not trimmed: leading and trailing spaces are legitimate password characters, and
 * silently removing them means the password a user set is not the password they typed.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const personNameSchema = z
  .string()
  .trim()
  .min(1, 'Must not be empty')
  .max(NAME_MAX_LENGTH, `Must be at most ${NAME_MAX_LENGTH} characters`);

/**
 * `strictObject`, not `object`: an unknown key is rejected rather than stripped.
 *
 * Zod strips by default, which would turn `{"role":"ADMIN"}` into a silent no-op. A
 * silent no-op is the right behaviour only until someone widens the insert to spread
 * the parsed body — at which point the endpoint quietly grants admin. Failing loudly
 * on an unexpected key keeps that from ever being one careless line away.
 */
export const registerRequestSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  firstName: personNameSchema,
  lastName: personNameSchema,
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * What registration returns.
 *
 * No `passwordHash`, obviously — but also no token: F7 creates the account and
 * nothing else, and F8 owns the login exchange.
 *
 * `role` is absent deliberately. Registration always produces a CUSTOMER, and the
 * only correct way to put a role on the wire is the enum generated from
 * `schema.prisma` (rules/20-contracts.md §3). That generator does not exist yet, and
 * hand-writing `z.enum(['CUSTOMER', ...])` here would be the exact duplication the
 * rule forbids. It arrives with RBAC (F10).
 */
export const registeredUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  createdAt: z.iso.datetime(),
});

export type RegisteredUser = z.infer<typeof registeredUserSchema>;
