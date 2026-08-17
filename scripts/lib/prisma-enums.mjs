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
  // The closing brace is anchored to the start of a line, and the body is matched
  // lazily across newlines — NOT `[^}]*`, which stops at the first `}` ANYWHERE.
  //
  // That earlier form truncated the block at a brace inside a comment, so a doc comment
  // like `/// see the {finance} runbook` silently dropped every value below it. No throw
  // fired, because the truncated body still parsed cleanly — the same self-consistent
  // drift as the value-level-attribute bug, reached through a different door.
  //
  // This is the matcher `apps/api/src/db/schema-invariants.spec.ts:167` already used and
  // which is immune to it; the generator should have borrowed it from the start.
  // Leading whitespace is tolerated on BOTH anchors. Anchoring to a bare `^\}` traded
  // the comment-brace bug for a narrower one: an enum that is the final block in the
  // file with an indented closing brace matched nothing and was dropped whole, silently
  // — `gen:enums` reported one fewer enum and `check:enums` exited 0. Found by the review
  // of PR #91, which is the third pass over this expression; each earlier version fixed
  // a silent drop by introducing a smaller one, so the lesson is to be permissive about
  // layout and strict about content, which is what the per-line parsing below does.
  const blockPattern = /^[ \t]*enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^[ \t]*\}/gm;

  for (const match of schemaText.matchAll(blockPattern)) {
    const name = match[1];
    const body = match[2] ?? '';

    const lines = body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('@@'));

    // THROW on a line this parser does not understand — do not skip it.
    //
    // The first version filtered to bare identifiers and dropped the rest, with a
    // comment claiming that was safer. It was the opposite. A value carrying a
    // Prisma value-level attribute — `SUPPORT @map("support")` — vanished from the
    // output, and because `check-enums-generated.mjs` compares the committed file
    // against THIS parser's output, the drift was self-consistent: the generator and
    // the check agreed with each other while both disagreed with the schema, and
    // `check:enums` reported success. A check that cannot see a real divergence is
    // worse than no check, because it is trusted.
    //
    // Failing loudly means an unsupported attribute is a build error naming the line,
    // which is a five-minute fix here, rather than a value silently missing from a
    // contract until something rejects it at runtime.
    const values = lines.map((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
      if (!match) {
        throw new Error(
          `enum ${name}: cannot parse the line ${JSON.stringify(line)}.\n` +
            'This parser handles bare enum values and @@map only. If the schema now uses a\n' +
            'value-level attribute, teach scripts/lib/prisma-enums.mjs about it — do not let\n' +
            'the value be dropped, or the generated contract will silently disagree with the\n' +
            'database while check:enums reports success.',
        );
      }
      return match[1];
    });

    // An enum with no values is a schema the parser misread, not an empty enum —
    // Prisma rejects `enum X {}`. Dropping it silently would hide the same class of
    // bug one level up.
    if (values.length === 0) {
      throw new Error(`enum ${name}: no values found. This is almost certainly a parser bug.`);
    }

    enums.push({ name, values });
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
