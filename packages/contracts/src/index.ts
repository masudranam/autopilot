/**
 * @repo/contracts — the single declaration of every API shape.
 *
 * Apps import inferred types from here and never redeclare a payload. See
 * docs/adr/0002-contracts-first-with-zod.md and invariant I2 in SPEC.md.
 */
// Generated from schema.prisma by `pnpm gen:enums`; `pnpm check:repo` fails on drift.
// Exported first so a hand-written union mirroring a database enum has no excuse to
// exist (CLAUDE.md § Contracts).
export * from './enums.generated';
export * from './auth';
export * from './account';
export * from './money';
export * from './pagination';
export * from './problem-details';
