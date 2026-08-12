# Contracts

`packages/contracts` is the only place an API shape is declared. See
[ADR-0002](../../docs/adr/0002-contracts-first-with-zod.md).

## The flow

```ts
// packages/contracts/src/catalog.ts
import { nonNegativeMoneySchema } from './money';

export const productSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  // Reuse the shared primitive — do NOT redeclare the amount/currency pair inline.
  // Declaring it again is how field names drift (`priceMinor` here, `amountMinor`
  // there) and how the ISO-4217 validation gets silently dropped.
  price: nonNegativeMoneySchema,
});

export type ProductSummary = z.infer<typeof productSummarySchema>;
```

- The API validates with `productSummarySchema` and types its handler with `ProductSummary`.
- The storefront imports `ProductSummary` from `@repo/contracts`.
- Nobody redeclares it. A `guard-write` hook blocks an `*Response` / `*Dto` / `*Request` type
  declared inside `apps/*`.

## Rules

1. **Schema first, implementation second.** Write the contract, then the endpoint, then the UI.
2. **Infer, never duplicate.** `z.infer` is the only way a contract type comes into existence.
3. **Enums come from Prisma.** `enums.generated.ts` is generated from `schema.prisma`. Never
   hand-write a union of string literals that mirrors a database enum.
4. **Money is `{ amountMinor: number; currency: string }`.** There is a shared `moneySchema` — use
   it rather than declaring the pair again.
5. **Pagination uses the shared envelope.** `paginatedSchema(itemSchema)` produces
   `{ items, pageInfo: { nextCursor, hasNextPage } }`. Do not invent a per-module shape.
6. **Errors use `problemDetailsSchema`.** One error shape across the whole API (I3).

## Versioning

The API is served under `/api/v1`. A breaking change to an existing contract means a new field with
a deprecation of the old one, not a silent change of meaning. Removing a field is a breaking change
even if nothing in this repo reads it.

## When it drifts

`contract-auditor` runs on every PR touching `schema.prisma`, `packages/contracts` or an app's data
layer. It looks for: types redeclared in apps, enums hand-copied from Prisma, response shapes the
schema does not describe, and optional/required mismatches between schema and usage.
