#!/usr/bin/env node
/**
 * Writes `packages/contracts/src/enums.generated.ts` from `apps/api/prisma/schema.prisma`.
 *
 *   pnpm gen:enums
 *
 * Run it after changing an enum in the schema. `pnpm check:repo` fails if the committed
 * file and the schema disagree, so forgetting is a red check rather than a runtime
 * surprise (CLAUDE.md §Contracts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnums, renderEnumsModule } from './lib/prisma-enums.mjs';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SCHEMA_PATH = join(projectDir, 'apps', 'api', 'prisma', 'schema.prisma');
export const OUTPUT_PATH = join(projectDir, 'packages', 'contracts', 'src', 'enums.generated.ts');

/** The exact bytes the committed file should contain, for the generator and the check. */
export function renderFromSchema() {
  return renderEnumsModule(parseEnums(readFileSync(SCHEMA_PATH, 'utf8')));
}

// Only write when run directly, so `check-enums-generated.mjs` can import the renderer
// without the import having a side effect on the working tree.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const output = renderFromSchema();
  writeFileSync(OUTPUT_PATH, output, 'utf8');
  const count = (output.match(/^export const [A-Z][A-Za-z0-9_]* = \{$/gm) ?? []).length;
  console.log(`gen:enums: wrote ${count} enum(s) to packages/contracts/src/enums.generated.ts`);
}
