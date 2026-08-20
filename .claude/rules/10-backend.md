# Backend — NestJS

## Module anatomy

```
apps/api/src/modules/<domain>/
  <domain>.module.ts
  <domain>.controller.ts      HTTP only: parse, delegate, serialise
  <domain>.service.ts         business rules — the part worth testing
  <domain>.repository.ts      Prisma access, confined to this file
  dto/                        thin wrappers over @repo/contracts schemas
  <domain>.service.spec.ts
  <domain>.controller.e2e-spec.ts
```

Controllers contain no business logic. Services contain no raw SQL or Prisma queries — those live in
the repository. This split is what makes the service testable without a database.

## Module boundaries (ADR-0001)

A module may import **only another module's exported service**. It may not:

- import another module's repository
- query another module's tables through its own Prisma client
- import another module's internal types

Boundary violations are the thing that turns a modular monolith into a ball of mud, and
`pr-reviewer` checks for them explicitly.

## Validation

A single `ZodValidationPipe` applied globally. Every controller input is parsed by a schema from
`@repo/contracts`. Never trust a `@Body()` that has not been through a schema — and never write a
`class-validator` DTO, since that would be a second declaration of a shape (I2).

## Errors

Throw domain errors; let the global filter render them.

```ts
throw new InsufficientStockError({ sku, available }); // → 409 Problem Details
```

Never construct an HTTP response shape inside a service, and never `throw new HttpException` with an
ad-hoc body. One filter owns the wire format (I3).

## Authorisation

Every route carries an explicit decorator. There is no "internal" route that is safe because nothing
links to it (I5).

```ts
@Roles(Role.ADMIN)
@Get('orders')
```

For owned resources, scope the query by owner and return 404 when it misses — never fetch then
compare, and never return 403, which confirms the resource exists (I4).

```ts
// right: ownership is part of the query
const order = await this.repo.findOneForUser(orderId, userId);
if (!order) throw new NotFoundError();
```

## Money

`amountMinor: number` (integer) + `currency: string`. No floats, no `toFixed`, no `Decimal` crossing
a module boundary. Lint blocks the two common mistakes; see
[ADR-0003](../../docs/adr/0003-money-as-integer-minor-units.md).

## Transactions

Anything that must succeed or fail together goes in one `prisma.$transaction`. Order placement is
the canonical case: reservations, order, lines and payment commit together or not at all.

Do not perform network calls (payment provider, email) _inside_ a transaction — capture first, then
open the transaction, so a slow provider cannot hold database locks.

## Async work

Anything slow or retryable is a BullMQ job: email, image processing, reservation expiry, webhooks.
Jobs must be idempotent — they will be retried, and a retry must not send a second email or refund
twice.

## Configuration

All env access goes through a validated config service backed by a Zod schema. `process.env` is not
read anywhere else. A missing required variable fails at boot with a message naming it — not at 3am
on the first request that needed it.
