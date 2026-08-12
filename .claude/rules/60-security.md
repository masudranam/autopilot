# Security

This is an ecommerce system: it holds identities, addresses and payment references. The rules below
are the ones that get skipped under delivery pressure, which is why they are enforced rather than
suggested.

## Authorisation

- **Every route has an explicit authorisation decorator** (I5). A route with none is denied by
  default, and a test asserts that the default is closed.
- **Ownership is part of the query, never an afterthought.** Scope by owner in the `where` clause
  and return 404 on a miss (I4). Fetching then comparing leaks existence through timing, and
  returning 403 leaks it outright.
- Admin routes check role on the server. Hiding a button is not authorisation.

## Authentication

- Passwords hashed with Argon2id. Never MD5, SHA-family, or bcrypt with a low cost factor.
- Access tokens are short-lived (15 min) and stateless; refresh tokens are long-lived, rotating,
  stored **hashed**, and revocable.
- Refresh-token reuse revokes the whole session family — presenting an already-rotated token is
  evidence of theft, not a retry.
- Login failures are generic and constant-time. Do not reveal whether the email exists, in the
  message or in the timing.
- Password reset and email verification tokens are single-use, short-lived, and stored hashed.

## Input

- Everything is parsed by a Zod schema at the edge (I2). No route reads an unvalidated body.
- Prisma parameterises queries. If raw SQL is unavoidable, use `$queryRaw` with tagged-template
  parameters — never string concatenation.
- File uploads: validate the actual content type, cap the size, never trust the client-supplied
  filename, and store outside the web root.

## Secrets

- Never read a `.env` file to answer a question — ask instead. A hook blocks writing one.
- Never put a real key, token or connection string in code, a commit, a log line, a test fixture, or
  a PR comment.
- Secrets come from the validated config service. Rotating a secret must not require a code change.
- Errors must not leak stack traces, SQL or internal paths in production mode (F5/AC2).

## Payments

- The API never stores a raw card number. Only provider tokens and references.
- Webhooks verify the signature against the **raw** request body — parsing before verifying makes
  verification meaningless.
- Webhook handling is idempotent by provider event id; providers retry, and a retry must not refund
  twice (I6).
- Amounts are re-derived server-side at capture. A client-supplied total is a suggestion, never a
  fact.

## Transport & headers

- CSP, HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy` on both frontends.
- CORS is an explicit allowlist. Never `*` together with credentials.
- Cookies: `httpOnly`, `secure`, `sameSite=strict` for the refresh token.

## Rate limiting

Per-IP and per-account limits on auth, checkout, search and password reset. A 429 carries
`Retry-After`. Without this, credential stuffing against `/auth/login` is free.

## Review

`security-auditor` runs automatically on any PR touching auth, checkout, payments, admin or a route
definition. Its findings are blocking, not advisory.
