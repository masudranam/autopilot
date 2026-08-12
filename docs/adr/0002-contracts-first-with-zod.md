# ADR-0002 · Contracts-first with Zod in a shared package

**Status:** Accepted · 2026-08-12

## Context

Three applications share one API. The usual failure is drift: the frontend's `Product` interface
says `price: number`, the API starts returning `amountMinor` plus a currency, nothing fails to
compile because the two declarations are unrelated, and the bug ships.

This risk is worse under an automated build loop. A human writing the frontend notices the API
changed shape; an agent implementing issue #34 three weeks after issue #15 does not, unless the
codebase makes it impossible to miss.

## Decision

Every API request and response shape is a **Zod schema in `packages/contracts`**, and that schema is
the only declaration of it anywhere.

- The API validates incoming payloads with it and derives its DTOs via `z.infer`.
- The frontends import the inferred types. They never redeclare a shape.
- Prisma enums are code-generated into `contracts/enums.generated.ts` so there is no hand-copied
  union of string literals.
- The OpenAPI document is produced from the same schemas.

## Consequences

**Good**

- A shape change is a compile error in every consumer at once. Drift becomes impossible rather than
  merely discouraged.
- Runtime validation and static types cannot disagree, because one produces the other.

**Bad**

- `packages/contracts` must build before anything that depends on it, so the Turbo graph has a
  serial edge at the root.
- Contributors have to learn where shapes live before writing a feature.

**Enforcement**

`guard-write.mjs` blocks writing an API-payload interface inside `apps/*` (invariant I2), and
`contract-auditor` checks `schema.prisma`, the Zod schemas and frontend usage for drift on every PR
that touches any of them.
