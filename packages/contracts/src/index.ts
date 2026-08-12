/**
 * @repo/contracts — the single declaration of every API shape.
 *
 * Apps import inferred types from here and never redeclare a payload. See
 * docs/adr/0002-contracts-first-with-zod.md and invariant I2 in SPEC.md.
 */
export * from './money';
export * from './pagination';
export * from './problem-details';
