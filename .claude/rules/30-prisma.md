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

## Database naming — snake_case in the DB, camelCase in code

The Prisma model layer is camelCase/PascalCase; the database itself is snake_case. Every mapping is
explicit — never rely on names happening to coincide:

- **Every model** carries `@@map("plural_snake")`: `model OrderLine` → `@@map("order_lines")`. Table
  names are plural.
- **Every camelCase column** carries `@map("snake_case")`:

  ```prisma
  discountMinor Int @default(0) @map("discount_minor")
  userId        String          @map("user_id")
  ```

  Single-word lowercase fields (`email`, `currency`, `role`) need no `@map` — they are already
  identical in both.

- **Every enum type** carries `@@map("snake_case")`: `enum ProductStatus` →
  `@@map("product_status")`.

Why: raw SQL, `psql` sessions, BI tools and DBAs all see the database directly, and `orderLine`
column names in Postgres read as a mistake. Adding the mapping later is a full-schema rename
migration — do it from the first migration.

Enforced by `schema-invariants.spec.ts`: a model without `@@map` or a camelCase scalar column
without `@map` fails the test suite, so this rule cannot silently regress.

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
