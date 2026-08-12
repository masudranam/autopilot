# Prisma & data

Prisma 7. Requires Node ^20.19 — satisfied by the pinned 20.20.0.

## Migrations

```
pnpm --filter @repo/api exec prisma migrate dev --name <descriptive_name>
```

- **Never edit an applied migration.** Write a new one.
- **Never use `db push`** outside a throwaway experiment. It creates drift that the next migration
  cannot reconcile.
- **Additive first.** To remove a column: stop writing it, ship, then drop it in a later migration.
  A destructive migration in the same PR as the code change makes rollback impossible.
- `pnpm db:reset` must replay every migration from empty and then seed successfully. CI asserts this
  on every PR (I7).

## Schema conventions

- `id` is `String @id @default(uuid(7))` — time-ordered, so it indexes well.
- `createdAt` / `updatedAt` on every table.
- Money is `Int` minor units + a `currency String` (I1). Never `Float`, never `Decimal`.
- Every foreign key gets an index. Every field used in a `where` on a list endpoint gets an index.
- `onDelete` is explicit on every relation. Decide between `Cascade`, `Restrict` and `SetNull`
  deliberately — the default silently becomes a data-integrity decision nobody made.
- Enums live in the schema and are generated into `@repo/contracts`.

## Query discipline

- **N+1 is a bug, not a performance nicety.** Use `include` / `select`, and add a query-count test
  for every list and detail endpoint. Several acceptance criteria in SPEC.md require one.
- `select` only the columns needed. A list endpoint that returns full product descriptions to render
  a grid is wasting bandwidth on every request.
- Cursor pagination on list endpoints, keyed on an indexed, unique, ordered column.
- Concurrency-sensitive updates use the `version` column and a conditional update — read, then write
  with `where: { id, version }`, and retry on zero rows affected. This is what prevents overselling.

## Seed

`apps/api/prisma/seed.ts` must be **idempotent** (I8): running it twice leaves the database in the
same state. Use `upsert` with stable natural keys, never bare `create`.

The seed must produce a catalogue you can actually browse — SPEC.md F3/AC4 sets the minimum. A seed
that produces three lorem-ipsum products makes every downstream feature harder to build and
impossible to demonstrate.

## Testing against the database

Integration tests run against real Postgres, not a mock. Each test file gets a clean database state
via truncation in `beforeEach`. Mocking Prisma to test a repository proves nothing about whether the
query is correct.
