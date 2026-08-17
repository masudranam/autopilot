# ADR-0010 · The role travels in the access token

**Status:** Accepted · 2026-08-17

## Context

F10 adds `@Roles()`. Every authenticated request now has to answer "what may this caller do", and
there are two places the answer can come from:

1. **A claim in the access token**, signed at login and at each refresh.
2. **A database read** on every authenticated request, from the `users` row.

The second is obviously correct and obviously expensive. Authorisation would add a query to every
request in the system — a permanent per-request cost, paid to reflect a value that changes perhaps
once in an account's lifetime.

## Decision

The role is a claim in the access token, alongside `sub` and `sid`.

`AccessTokenService.issue` takes a role and signs it in. The login path reads it from the
credentials row it already fetches — one more column on a `select` that happens anyway, so genuinely
free.

The refresh path reads it from the session's owner via a nested `select` on the relation. **That is
not free.** Prisma loads a relation with a separate query unless the `relationJoins` preview feature
is enabled, which it is not here, so the rotation's `session.create` now issues an extra `SELECT`
against `users`. An earlier draft of this ADR claimed "neither path adds a query" — the review of PR
#90 measured it and that claim was wrong.

The cost is one indexed primary-key lookup per refresh, and a refresh happens at most once per 15
minutes per session. The alternative costs a database read on _every_ authenticated request. The
trade still favours the claim; it is recorded accurately here so nobody plans against a number that
was never true.

Note that the statement-count test in `auth-refresh.e2e-spec.ts` counts Prisma **client
operations**, not SQL statements, so `session.create` stays one entry and that test cannot see this.
SQL-level counting would need a different instrument.

`RolesGuard` reads `request.auth.role`, which `JwtAuthGuard` attached. It never touches the
database.

## Consequences

**Good**

- Authorisation costs nothing per request. No query, no cache, no invalidation.
- The role is covered by the token's signature, so it cannot be tampered with — the algorithm
  pinning in `access-token.service.ts` is what makes that true.
- Revoking a session already revokes its tokens (F9), so the emergency path for "this account must
  lose access now" exists and is independent of this decision.

**Bad**

- **A role change takes effect at the next refresh, not immediately.** The access token TTL is 15
  minutes, so a demoted admin keeps admin for up to that long. This is the real cost of the decision
  and it is accepted rather than mitigated.
- The token is larger by one short claim. Irrelevant in practice.
- Anyone holding a token can read the role from it — a JWT payload is base64, not encryption. The
  role is not a secret: a caller learns it by making a request.

**There is NO mitigation. The window is unconditional.**

An earlier draft of this ADR said that when 15 minutes is too long — a compromised admin account, a
dismissal — revoking the session closes the window. **That is false, and the security review of PR
#90 disproved it by execution:**

```
DELETE /auth/sessions/:id                       = 204
refresh after revoking                          = 401   ← as designed
ACCESS token AFTER revoking, on an ADMIN route  = 200   ← still admin
```

`JwtAuthGuard` is pure `jwt.verify`. Nothing reads `sid` back against the session store, so
revocation kills the _refresh_ token and leaves the _access_ token valid until it expires. Session
revocation stops a session continuing; it does not stop the token already issued.

So the honest statement is: **a dismissed admin retains admin for up to 15 minutes, and no action
available in this system shortens that.** That is the accepted cost of a stateless access token —
the same property F8 chose deliberately — and it is bounded by the TTL. But it must not be written
down as though an escape hatch exists, because a reader planning an incident response would build on
a step that does nothing.

The exposure is not new in F10 and is not made worse by carrying the role in the token: an access
token has always outlived revocation. F10 only makes it matter for authorisation as well as
identity.

**When to revisit**

If a role change ever needs to be instant _without_ signing the user out — a support engineer's
permissions being narrowed mid-session, say — the options are a short-lived deny-list of user ids
checked per request, or dropping to a database read for the routes that care. Neither is worth
building before there is a feature that needs it.
