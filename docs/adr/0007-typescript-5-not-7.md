# ADR-0007 · Pin TypeScript 5.9.3, not 7.x

**Status:** Accepted · 2026-08-12

## Context

TypeScript 7.0.2 (the native Go port) is the current `latest` on npm. Choosing the newest major on a
greenfield project is usually right, so this was tested rather than assumed.

**What was verified empirically:**

TS 7.0.2 compiles the NestJS dependency-injection pattern correctly. A test class with
`experimentalDecorators` + `emitDecoratorMetadata` emitted `design:paramtypes` and resolved
constructor types at runtime — so decorators themselves are not the blocker. It did introduce new
strictness: `rootDir` must now be set explicitly when `outDir` is used (`TS5011`).

**What rules it out** — the peer ranges of two tools that are part of the verify gate:

| Package             | Version | TypeScript peer range | TS 7 supported? |
| ------------------- | ------- | --------------------- | --------------- |
| `typescript-eslint` | 8.67.0  | `>=4.8.4 <6.1.0`      | No              |
| `ts-jest`           | 29.4.12 | `>=4.3 <7`            | No              |

Adopting TS 7 would break `pnpm lint` and `pnpm test` — two of the five gate steps. Since the whole
project runs through an automated loop whose only quality signal is that gate, losing two thirds of
it is not a trade worth making for a compiler speed improvement.

## Decision

Pin `typescript@5.9.3`, the final release of the 5.x line.

## Consequences

**Good**

- The full toolchain — linting, type-aware rules, Jest transforms, Nest, Next, Prisma — is on
  supported, tested combinations.
- The verify gate stays meaningful.

**Bad**

- Slower compilation than the native port.
- A migration to 7.x is deferred, not avoided.

**Revisit when**

`typescript-eslint` publishes a major supporting `>=7`, and `ts-jest` (or a replacement transform
such as SWC) does the same. At that point re-run this comparison; the decorator behaviour is already
known good, so the upgrade should be limited to adding explicit `rootDir` and bumping the toolchain.
