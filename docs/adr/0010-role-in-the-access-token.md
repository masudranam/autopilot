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
credentials row it already fetches; the refresh path reads it from the session's owner via a nested
select, which is a join inside a statement the rotation already makes. So neither path adds a query.

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

**The mitigation that already exists**

When 15 minutes is too long — a compromised admin account, a dismissal — the answer is to revoke the
session family, not to shorten the window. `DELETE /auth/sessions/:id` and refresh-token revocation
both kill the session immediately, and the next refresh fails rather than minting a token with the
old role. That is the correct tool for the urgent case, and it means the 15-minute window only ever
applies to routine changes.

**When to revisit**

If a role change ever needs to be instant _without_ signing the user out — a support engineer's
permissions being narrowed mid-session, say — the options are a short-lived deny-list of user ids
checked per request, or dropping to a database read for the routes that care. Neither is worth
building before there is a feature that needs it.
