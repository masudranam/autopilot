# ADR-0001 · Modular monolith for the API

**Status:** Accepted · 2026-08-12

## Context

The platform spans catalogue, inventory, pricing, cart, checkout, payments, orders, shipping,
reviews and search. Microservices are the reflexive choice at this feature count, and this repo's
sibling project `d:\projects\microservice` takes exactly that approach.

But the highest-risk flow here — order placement — must commit stock reservation, payment record and
order creation **atomically**. Across services that needs sagas, compensating transactions and an
outbox. That is a large amount of machinery to get right, and every bit of it is a place where an
unattended agent loop can produce something subtly broken that still passes its tests.

## Decision

One deployable NestJS application with enforced internal module boundaries.

A module is reachable only through its exported service. Importing another module's repository, or
touching its Prisma models directly, is a review failure. Each module owns its tables.

## Consequences

**Good**

- Order placement is one database transaction. Correctness is cheap instead of expensive.
- One deploy, one log stream, one place where authorisation lives.
- Local development is `pnpm dev`, not an orchestration problem.
- Boundaries stay explicit, so extracting a service later is mechanical rather than archaeological.

**Bad**

- Everything scales together; a hot search path cannot scale independently of checkout.
- Boundary discipline is a convention that has to be actively policed — nothing at runtime stops a
  cross-module import.

**Mitigation**

The `pr-reviewer` subagent checks boundary violations on every PR, and modules are laid out so the
seam is visible in the directory structure.
