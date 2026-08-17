#!/usr/bin/env node
/**
 * Fails if `enums.generated.ts` and `schema.prisma` disagree.
 *
 * This is what makes rules/20-contracts.md §3 a rule rather than a suggestion. Without
 * it, adding a value to a Prisma enum and forgetting to regenerate leaves the contract
 * asserting a value is impossible while the database returns it — and every consumer
 * that narrowed on the union is wrong in a way TypeScript cannot see.
 *
 * Compares bytes, not semantics. A hand edit to the generated file is drift too: the
 * point is that exactly one thing decides what the enum contains.
 */
import { existsSync, readFileSync } from 'node:fs';
import { OUTPUT_PATH, renderFromSchema } from './generate-enums.mjs';

const expected = renderFromSchema();

if (!existsSync(OUTPUT_PATH)) {
  console.error(
    'check:enums: packages/contracts/src/enums.generated.ts is missing.\n' +
      'Run `pnpm gen:enums` and commit the result.',
  );
  process.exit(1);
}

const actual = readFileSync(OUTPUT_PATH, 'utf8');

if (actual !== expected) {
  // Name the first differing line rather than printing both files — the fix is always
  // the same command, and a wall of diff buries it.
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const at = expectedLines.findIndex((line, index) => actualLines[index] !== line);

  console.error(
    'check:enums: packages/contracts/src/enums.generated.ts does not match schema.prisma.\n\n' +
      `  first difference at line ${at + 1}\n` +
      `    committed: ${JSON.stringify(actualLines[at] ?? '<end of file>')}\n` +
      `    expected:  ${JSON.stringify(expectedLines[at] ?? '<end of file>')}\n\n` +
      'Run `pnpm gen:enums` and commit the result. Do not edit the generated file by hand —\n' +
      'the schema is the single source of truth for what an enum contains (rules/20-contracts.md §3).',
  );
  process.exit(1);
}

const count = (expected.match(/^export const [A-Z][A-Za-z0-9_]* = \{$/gm) ?? []).length;
console.log(`check:enums: ${count} generated enum(s) match schema.prisma`);
