---
name: nest-module
description:
  Scaffolds a NestJS domain module the way this project does it — controller, service, repository,
  contracts, tests. Use when adding a new domain area to apps/api.
---

# Nest module

## Shape

```
apps/api/src/modules/<domain>/
  <domain>.module.ts
  <domain>.controller.ts        HTTP only — parse, delegate, serialise
  <domain>.service.ts           business rules
  <domain>.repository.ts        the only file that touches Prisma
  dto/index.ts                  thin re-export of @repo/contracts schemas
  <domain>.service.spec.ts      unit
  <domain>.e2e-spec.ts          integration, real Postgres
```

## Order

1. **Contracts first** — Zod schemas in `packages/contracts/src/<domain>.ts`, reusing `moneySchema`,
   `paginatedSchema()` and `problemDetailsSchema`. Export inferred types.
2. **Repository** — Prisma queries only. `select` what is needed, `include` to avoid N+1, cursor
   pagination on lists.
3. **Service** — rules, orchestration, domain errors. No Prisma here; it takes the repository.
4. **Controller** — route decorators, an explicit authorisation decorator on every route, validation
   via the global Zod pipe. No logic.
5. **Module** — wire it up, export only the service.
6. **Tests** — see below.
7. Register in `AppModule`.

## Non-negotiables

- **Authorisation on every route** (I5). No exceptions for "internal" routes.
- **Ownership in the `where` clause**, 404 on a miss (I4). Never fetch-then-compare, never 403.
- **Domain errors, not HTTP exceptions.** Throw `InsufficientStockError`; the global filter renders
  Problem Details (I3).
- **Money as integer minor units** (I1).
- **Only the service is exported.** Another module importing this repository is a boundary violation
  (ADR-0001).

## Tests it must ship with

- One per acceptance criterion.
- Cross-account probes on **every verb** — `GET`, `PATCH`, `PUT`, `DELETE` — asserting 404.
- A query-count test for every list and detail endpoint.
- Parallel tests (`Promise.all`) for anything concurrency-sensitive.
- Failure paths: validation, not-found, forbidden, conflict.

## Then

```
pnpm verify
```

And regenerate OpenAPI if routes changed.
