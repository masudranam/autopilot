# ADR-0003 · Money is an integer in minor units

**Status:** Accepted · 2026-08-12

## Context

`0.1 + 0.2 === 0.30000000000000004`. In an ecommerce system that error compounds through line
subtotals, percentage discounts, tax and shipping, and surfaces as an order total that disagrees
with the cart by a cent. Customers notice, and reconciliation against the payment provider fails.

Prisma's `Decimal` avoids the float problem but arrives in JavaScript as a `Decimal.js` instance
that has to be serialised carefully at every boundary, and is easy to accidentally coerce to a
number.

## Decision

All monetary values are stored and transported as **integers in the currency's minor unit**, always
paired with an ISO-4217 currency code.

- `amountMinor: Int` + `currency: String` — never a single `price: Float`.
- Prisma column type `Int`.
- Formatting for display happens once, in a `formatMoney` helper in `@repo/contracts`, using
  `Intl.NumberFormat`.
- Rounding in the totals pipeline happens at exactly one defined stage (F27/AC2), not per operation.

## Consequences

**Good**

- Arithmetic is exact. Totals reconcile with Stripe, which uses the same representation.
- No `Decimal` serialisation concerns crossing the API boundary.

**Bad**

- Every read site must divide by the minor-unit factor to display, and forgetting shows a price 100×
  too large — loud and immediately visible, which is the good failure mode.
- Zero-decimal currencies (JPY) and three-decimal currencies (KWD) need the exponent from the
  currency, not a hardcoded 100.

**Enforcement**

Two lint rules in `packages/config/eslint.base.mjs` make the failure modes hard to reach:
`parseFloat` is banned outright, and `.toFixed()` is banned as a money formatter. Both carry error
messages pointing back at this decision.
