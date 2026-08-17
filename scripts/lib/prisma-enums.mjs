/**
 * Reads the enums out of `schema.prisma` and renders them as TypeScript.
 *
 * Why generate rather than hand-write (rules/20-contracts.md §3): a union of string
 * literals mirroring a database enum is a second declaration of the same fact, and the
 * two drift silently — a value added to the schema is a migration plus a runtime that
 * happily returns something the contract says is impossible. Generating means the drift
 * is a failed check rather than a bug found in production.
 *
 * Deliberately a small regex parser rather than a Prisma dependency. This runs in
 * `check:repo`, which must stay fast and must not need `@prisma/internals` resolvable
 * from the repo root. The grammar it has to handle is four lines long.
 *
 * Pure functions, no filesystem: the callers do the I/O, so the parsing and rendering
 * are testable without writing anything.
 */

/**
 * `enum Name { ... }` blocks, with their values in declaration order.
 *
 * Skips `@@map(...)` and `///` doc comments inside the block — `@@map` names the
 * PostgreSQL type, which is a database concern and not a value.
 */
export function parseEnums(schemaText) {
  const enums = [];
  const blockPattern = /(^|\n)\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;

  for (const match of schemaText.matchAll(blockPattern)) {
    const name = match[2];
    const body = match[3] ?? '';

    const values = body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('@@'))
      // A value is a bare identifier. Anything else in an enum block is an attribute
      // this parser does not need to understand, and silently dropping it would be
      // worse than not matching it — so require the whole line to be an identifier.
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(line));

    if (values.length > 0) enums.push({ name, values });
  }

  return enums.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Renders the generated module.
 *
 * Each enum becomes a `const` object plus a union type derived from it, rather than a
 * TypeScript `enum`: a const object survives `isolatedModules`, needs no runtime import
 * to read a value, and `as const` gives the same literal narrowing without the
 * declaration-merging surprises TS enums bring.
 *
 * `zod` is not imported here. Schemas belong to the hand-written contract files, which
 * build on these values — keeping the generated file dependency-free means regenerating
 * it can never break a schema that imports it.
 */
export function renderEnumsModule(enums) {
  const header = [
    '/**',
    ' * GENERATED FILE — DO NOT EDIT.',
    ' *',
    ' * Produced from `apps/api/prisma/schema.prisma` by `pnpm gen:enums`.',
    ' * `pnpm check:repo` fails if this file and the schema disagree, so editing it by',
    ' * hand is a check failure rather than a silent second source of truth.',
    ' */',
    '',
  ];

  const blocks = enums.map(({ name, values }) => {
    const members = values.map((value) => `  ${value}: '${value}',`).join('\n');
    return [
      `export const ${name} = {`,
      members,
      '} as const;',
      '',
      `export type ${name} = (typeof ${name})[keyof typeof ${name}];`,
      '',
      `/** Every ${name} value, in schema declaration order. */`,
      `export const ${screamingSnake(name)}_VALUES = [`,
      values.map((value) => `  ${name}.${value},`).join('\n'),
      `] as const satisfies readonly ${name}[];`,
    ].join('\n');
  });

  // Blank line between blocks; the header already ends with one.
  return `${[...header, blocks.join('\n\n')].join('\n')}\n`;
}

/**
 * `ProductStatus` → `PRODUCT_STATUS`.
 *
 * A plain `toUpperCase()` gives `PRODUCTSTATUS`, which reads as one word and is the
 * kind of small ugliness that gets hand-edited — in a generated file, where a hand edit
 * is the exact failure this generator exists to prevent.
 */
function screamingSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
