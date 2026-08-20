---
name: prisma-change
description:
  Makes a database schema change safely — schema edit, migration, seed update, contract
  regeneration, replay check. Use for any change to schema.prisma or when a feature needs new tables
  or columns.
---

# Prisma change

The order matters. Doing it out of order produces drift that the next migration cannot reconcile.

## 1 · Edit the schema

`apps/api/prisma/schema.prisma`. Follow [CLAUDE.md §Prisma & data](../../../CLAUDE.md):

- `id String @id @default(uuid(7))`
- `createdAt` / `updatedAt` on every model
- Money as `Int` minor units + `currency String` — never `Float` or `Decimal` (I1)
- An index on every foreign key and every field used in a list `where`
- An explicit `onDelete` on every relation
- A `version Int` column on anything updated concurrently

## 2 · Generate the migration

```
pnpm --filter @repo/api exec prisma migrate dev --name <descriptive_name>
```

Read the generated SQL before moving on. If it contains a `DROP` you did not intend, stop — Prisma
inferred a destructive change from an ambiguous edit, and applying it loses data.

**Never** edit a migration that has already been applied. **Never** use `db push`.

Destructive changes are two migrations, not one: stop writing the column and ship, then drop it
later. A drop in the same PR as the code change makes rollback impossible.

## 3 · Regenerate the client and contracts

```
pnpm --filter @repo/api exec prisma generate
```

Enums flow into `packages/contracts/src/enums.generated.ts`. Never hand-edit that file — a hook
blocks it. If an enum member is missing, it is missing from `schema.prisma`.

## 4 · Update the seed

`apps/api/prisma/seed.ts` must stay idempotent (I8) — `upsert` on stable natural keys, never bare
`create`. A new model with no seed data makes every downstream feature harder to build and
impossible to demonstrate.

## 5 · Prove it replays

```
pnpm db:reset
pnpm db:seed
pnpm db:seed
```

Twice, deliberately. The second run must succeed and change nothing. CI asserts this (I7, I8), so
finding out here is cheaper.

## 6 · Update the contracts

Zod schemas in `packages/contracts` for anything the API now exposes. Nullability must match the
column exactly — a nullable column typed as required is a crash waiting for the first null.

## 7 · Verify

```
pnpm verify
```

## Common mistakes

- Adding a required column to a table with existing rows and no default — the migration fails on any
  non-empty database.
- Forgetting the index on a new foreign key, then wondering why a list endpoint is slow.
- Updating `schema.prisma` but not the seed, so `db:reset` produces an unusable catalogue.
- Changing an enum member's name, which is a breaking change for every stored row.
