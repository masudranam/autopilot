-- F12/AC2: at most one default address per (user, kind).
--
-- A partial unique index rather than a service-level check. Read-then-write in the
-- service means two concurrent "make this my default" requests both pass the read and
-- both end up default — the same race the project guards against elsewhere with a
-- conditional update, and the same reasoning as F7 letting the unique email index
-- arbitrate instead of a prior SELECT.
--
-- Prisma cannot express a WHERE clause on an index declaratively, so this lives here as
-- raw SQL with a matching comment in schema.prisma. `prisma migrate diff` does not see
-- partial indexes either, which is why removing this file would not surface as drift —
-- the covering test is what protects it.
CREATE UNIQUE INDEX "addresses_one_default_per_kind"
  ON "addresses" ("user_id", "kind")
  WHERE "is_default";
