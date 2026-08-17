import { z } from 'zod';
import { ROLE_VALUES } from './enums.generated';

/**
 * Identity contracts (SPEC.md F7 — registration, F8 — login and tokens).
 *
 * The only declaration of these shapes; apps import the inferred types (I2, ADR-0002).
 * Session listing and logout are F9 and are deliberately absent here.
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
 * `schema.prisma` (rules/20-contracts.md §3). That generator arrived with F10
 * (`pnpm gen:enums`), so `roleSchema` above is derived from it — but registration
 * always produces a CUSTOMER, and a role on this response would invite a client to
 * treat it as settable.
 */
export const registeredUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  createdAt: z.iso.datetime(),
});

export type RegisteredUser = z.infer<typeof registeredUserSchema>;

// ------------------------------------------------------------------ F8 · login & tokens

/**
 * A password as offered at LOGIN — shape only, and deliberately NOT `passwordSchema`.
 *
 * Reusing the registration schema here would reject a submitted credential for being
 * short or over-long with a 422 that names the password field, which tells an attacker
 * "this cannot be anyone's password" before a single hash is computed, and gives the
 * two failure modes (bad shape → 422, bad credential → 401) different costs. Login has
 * exactly one client-visible failure — 401 — and everything that gets that far pays the
 * same Argon2id verify (F8/AC4).
 *
 * The upper bound is kept because an unbounded input still has to be hashed, and it is
 * the same bound registration applies, so no real credential can be excluded by it.
 */
export const loginPasswordSchema = z
  .string()
  .min(1, 'Must not be empty')
  .max(PASSWORD_MAX_LENGTH, `Must be at most ${PASSWORD_MAX_LENGTH} characters`);

/** `strictObject` for the same reason registration uses it — see above. */
export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: loginPasswordSchema,
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Access token lifetime in seconds — F8/AC5 says fifteen minutes, so it is written
 * once, here, and both the signer and the client read it from this constant.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh token lifetime — SPEC.md §6.4 ("refresh token (30 d, rotating…)"). */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The cookie the refresh token travels in (F8/AC1).
 *
 * The refresh token is NEVER in a response body: a body is readable by script, ends up
 * in logs and proxy caches, and gets stored in `localStorage` by well-meaning clients.
 * The cookie is httpOnly, secure and sameSite=strict, which is the whole point.
 */
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** 256 bits of CSPRNG output — the refresh token is opaque, not a JWT. */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * The wire form of a refresh token: base64url, unpadded, of `REFRESH_TOKEN_BYTES`.
 *
 * Declared as a schema rather than trusted because a cookie is caller-controlled input
 * like any other, and this is the only input `POST /auth/refresh` reads (I2).
 */
export const refreshTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be base64url')
  .length(Math.ceil((REFRESH_TOKEN_BYTES * 4) / 3), 'Wrong length');

/**
 * What login and refresh return.
 *
 * No refresh token — that is the cookie's job — and no user object: the storefront
 * reads the profile from `/me` (F12) rather than from a second, drift-prone copy
 * embedded in every token response.
 */
export const authTokensSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  /** Seconds, matching OAuth 2 §5.1 so a client does not have to decode the JWT. */
  expiresIn: z.int().positive(),
});

export type AuthTokens = z.infer<typeof authTokensSchema>;

export const ACCESS_TOKEN_ISSUER = 'agentic-shop';
export const ACCESS_TOKEN_AUDIENCE = 'agentic-shop-api';

/**
 * The caller's role, straight from the Prisma enum (rules/20-contracts.md §3).
 *
 * `z.enum(ROLE_VALUES)` rather than `z.enum(['CUSTOMER', ...])`: the values come from
 * the generated module, so adding a role to `schema.prisma` and forgetting to update
 * this file is impossible — there is nothing here to update. A hand-written union would
 * silently keep rejecting the new value long after the database started returning it.
 */
export const roleSchema = z.enum(ROLE_VALUES);

export type RoleName = z.infer<typeof roleSchema>;

/**
 * The verified claims of an access token.
 *
 * A JWT payload is a wire shape — the storefront decodes `exp` to refresh proactively —
 * so it is declared here and nowhere else. `sid` binds the access token to the session
 * that minted it, which is what lets F9 revoke an access token's lineage.
 *
 * `role` arrived with F10, typed from the generated Prisma enum rather than a
 * hand-written union.
 */
export const accessTokenClaimsSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  /**
   * The role at the moment the token was minted (F10).
   *
   * In the token rather than read per request: authorisation would otherwise cost a
   * database round trip on every authenticated call to reflect a change that happens
   * almost never. The cost is that a role change takes effect at the next refresh
   * rather than instantly — up to the 15-minute access TTL. See ADR-0010.
   */
  role: roleSchema,
  iss: z.literal(ACCESS_TOKEN_ISSUER),
  aud: z.literal(ACCESS_TOKEN_AUDIENCE),
  /** Seconds since the epoch, as RFC 7519 requires — not milliseconds. */
  iat: z.int().positive(),
  exp: z.int().positive(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

/**
 * One active session, as the account's device list shows it (F9/AC1).
 *
 * "Active" means still usable: not revoked, not already rotated into a successor, not
 * expired. A rotated row is kept in the database as reuse evidence (see `schema.prisma`)
 * but it is spent, and listing it would show a person one row per refresh — hundreds
 * of "devices" for one browser.
 *
 * `current` lets the UI mark "this device" without the client comparing anything it
 * would have to be told separately. The server knows which session minted the access
 * token — it is the `sid` claim — so it answers rather than exporting the question.
 *
 * No refresh token, and no hash of one. The whole point of storing only hashes is that
 * the value never leaves the database; putting the hash on the wire would make it a
 * bearer credential again for anyone who can replay it against a lookup.
 */
export const sessionSummarySchema = z.object({
  id: z.uuid(),
  /** Free text from the User-Agent, or null when the client sent none. */
  device: z.string().nullable(),
  ip: z.string().nullable(),
  lastUsedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** True for the session whose access token made this request. */
  current: z.boolean(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * The list response.
 *
 * A bare array rather than the paginated envelope from `pagination.ts`: sessions are
 * bounded by how many devices one person signs in from, the set is already filtered to
 * active rows, and a cursor over a handful of rows is machinery with nothing to do.
 * `paginatedSchema` stays the rule for open-ended collections (rules/20-contracts.md §5).
 */
export const sessionListSchema = z.array(sessionSummarySchema);

export type SessionList = z.infer<typeof sessionListSchema>;

/**
 * A session id in a path parameter (F9/AC2).
 *
 * Parsed rather than passed through: ids are `uuid(7)` and anything else cannot name a
 * row, so a malformed value is a 422 at the edge instead of reaching the database as a
 * query parameter. Prisma parameterises regardless — this is about answering the wrong
 * shape consistently, not about injection.
 */
export const sessionIdSchema = z.uuid();
