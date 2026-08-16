# Testing

The verify gate is the only signal standing between a change and an automatic merge. A test that
cannot fail actively removes that signal, so it is worse than no test at all.

## Layers

| Layer       | Tool                             | Covers                                                        |
| ----------- | -------------------------------- | ------------------------------------------------------------- |
| Unit        | Jest (api) / Vitest (packages)   | business rules, state machines, totals, pure logic            |
| Integration | Jest + Supertest + real Postgres | routes end to end: auth, validation, persistence, error shape |
| E2E         | Playwright                       | user journeys across storefront and admin                     |

## What every feature must have

1. **One test per acceptance criterion**, and the test must fail if the behaviour regresses. This
   one is not negotiable — it is the whole reason the gate means anything.
2. **Cross-account probes** — only when the feature actually adds an owned resource, and then on the
   verbs it adds, asserting `404` and not `403` (I4). A feature that adds no owned resource says so
   in the test file rather than inventing a probe.
3. **A query-count test** on new **list** endpoints, locking in the absence of N+1. Detail and write
   endpoints do not need one unless the criterion is about statement count.
4. **A genuinely parallel test** where a race would corrupt state or money — stock reservation,
   coupon redemption limits, idempotent placement, token rotation. Fire the requests with
   `Promise.all`. A sequential loop passes even when the race is present, which makes it worse than
   useless. Not required elsewhere.
5. **The failure paths named by an acceptance criterion.** Blanket coverage of every error branch is
   not required; a criterion that says "expired token returns 401" needs its test, an unmentioned
   branch does not.

Anything beyond this list is welcome but is **never** a reason to block a merge. If a reviewer wants
more coverage, it files an issue.

## Tests that do not count

The reviewer is instructed to flag these, and they fail the gate:

- Asserting only that a call did not throw.
- Mocking the exact thing the criterion is about — a refresh-token-reuse test with a mocked session
  store proves nothing.
- Snapshot tests standing in for behavioural assertions.
- A concurrency test that is a `for` loop.
- `expect(true).toBe(true)`, or a test with no assertion at all.

## Never on `main`

`.skip`, `.only`, `xit`, `xdescribe`, or a commented-out test (I9). CI greps for these and fails. If
a test must be disabled, delete it and open an issue — a permanently skipped test is a lie in the
report.

## Data

Integration tests use the real seed plus per-test factories. Truncate between tests rather than
sharing state. Never write a test that only passes when run after another test.

## Determinism

No dependence on wall-clock time, timezone, or random values. Freeze time where behaviour depends on
it. A flaky test in an unattended loop causes either a false merge or a false stop, and both are
expensive.
