/**
 * Tests for the enum parser and renderer.
 *
 * These are the reason the parsing lives in a pure function: every case below is a
 * shape `schema.prisma` can legally take, and none of them needs a database or a file.
 */
import assert from 'node:assert/strict';
import { parseEnums, renderEnumsModule } from './prisma-enums.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${error.message}`);
  }
}

test('reads a simple enum', () => {
  const enums = parseEnums('enum Role {\n  CUSTOMER\n  ADMIN\n}');
  assert.deepEqual(enums, [{ name: 'Role', values: ['CUSTOMER', 'ADMIN'] }]);
});

test('keeps declaration order, not alphabetical order, for values', () => {
  const [role] = parseEnums('enum Role {\n  SUPPORT\n  ADMIN\n  CUSTOMER\n}');
  assert.deepEqual(role.values, ['SUPPORT', 'ADMIN', 'CUSTOMER']);
});

test('sorts enums by name so the output is stable across schema reordering', () => {
  const enums = parseEnums('enum Zebra {\n  A\n}\nenum Alpha {\n  B\n}');
  assert.deepEqual(
    enums.map((e) => e.name),
    ['Alpha', 'Zebra'],
  );
});

test('drops @@map — it names the Postgres type, not a value', () => {
  const [role] = parseEnums('enum Role {\n  CUSTOMER\n\n  @@map("role")\n}');
  assert.deepEqual(role.values, ['CUSTOMER']);
});

test('drops comments, including a trailing one on a value line', () => {
  const [role] = parseEnums('enum Role {\n  // a comment\n  CUSTOMER // trailing\n  ADMIN\n}');
  assert.deepEqual(role.values, ['CUSTOMER', 'ADMIN']);
});

test('ignores models, so a field named like an enum value is not captured', () => {
  const enums = parseEnums('model User {\n  id String\n  role Role\n}\nenum Role {\n  ADMIN\n}');
  assert.deepEqual(enums, [{ name: 'Role', values: ['ADMIN'] }]);
});

test('ignores a word ending in "enum" — the keyword must stand alone', () => {
  assert.deepEqual(parseEnums('model Denum {\n  a B\n}'), []);
});

test('THROWS on a value-level attribute rather than dropping the value', () => {
  // The bug the first version shipped with: `SUPPORT @map("support")` vanished, the
  // generator and the drift check agreed with each other, and check:enums reported
  // success while the contract was missing a role the database can return.
  assert.throws(
    () =>
      parseEnums(
        ['enum Role {', '  CUSTOMER', '  SUPPORT @map("support")', '  ADMIN', '}'].join('\n'),
      ),
    /cannot parse the line/,
  );
});

test('the thrown message names the enum and the offending line', () => {
  try {
    parseEnums(['enum Role {', '  SUPPORT @map("support")', '}'].join('\n'));
    assert.fail('expected a throw');
  } catch (error) {
    assert.match(error.message, /enum Role/);
    assert.match(error.message, /SUPPORT @map/);
  }
});

test('throws rather than silently emitting an enum with no values', () => {
  assert.throws(
    () => parseEnums(['enum Role {', '  @@map("role")', '}'].join('\n')),
    /no values found/,
  );
});

test('a brace inside a comment does not truncate the block', () => {
  // The second blind spot, found in round 2 of #90's review. With `[^}]*` the body
  // stopped at the `}` in `{finance}`, FINANCE vanished, and nothing threw because the
  // truncated body still parsed — so gen:enums and check:enums agreed with each other
  // while both disagreed with the schema.
  const [role] = parseEnums(
    [
      'enum Role {',
      '  CUSTOMER',
      '  /// billing ops seat; see the {finance} runbook',
      '  FINANCE',
      '',
      '  @@map("role")',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(role.values, ['CUSTOMER', 'FINANCE']);
});

test('reads an enum whose closing brace is indented, even as the last block', () => {
  // The narrower hole that anchoring to a bare `^\}` opened: as the FINAL block in the
  // file, an indented brace matched nothing and the whole enum was dropped with no
  // throw — gen:enums simply reported one fewer, and check:enums exited 0.
  const enums = parseEnums(['enum Tier {', '  BRONZE', '  GOLD', '  }'].join('\n'));
  assert.deepEqual(enums, [{ name: 'Tier', values: ['BRONZE', 'GOLD'] }]);
});

test('reads an indented enum declaration', () => {
  const enums = parseEnums(['  enum Tier {', '    BRONZE', '  }'].join('\n'));
  assert.deepEqual(enums, [{ name: 'Tier', values: ['BRONZE'] }]);
});

test('stops at the enum’s own closing brace, not a later one', () => {
  const enums = parseEnums(
    ['enum A {', '  X', '}', '', 'model M {', '  id String', '}', '', 'enum B {', '  Y', '}'].join(
      '\n',
    ),
  );
  assert.deepEqual(enums, [
    { name: 'A', values: ['X'] },
    { name: 'B', values: ['Y'] },
  ]);
});

test('returns nothing for a schema with no enums', () => {
  assert.deepEqual(parseEnums('model User {\n  id String\n}'), []);
});

test('renders a const object, a union type and a values array', () => {
  const output = renderEnumsModule([{ name: 'Role', values: ['CUSTOMER', 'ADMIN'] }]);
  assert.match(output, /export const Role = \{/);
  assert.match(output, /CUSTOMER: 'CUSTOMER',/);
  assert.match(output, /export type Role = \(typeof Role\)\[keyof typeof Role\];/);
  assert.match(output, /export const ROLE_VALUES = \[/);
  assert.match(output, /satisfies readonly Role\[\]/);
});

test('screaming-snakes a PascalCase name — PRODUCT_STATUS, not PRODUCTSTATUS', () => {
  const output = renderEnumsModule([{ name: 'ProductStatus', values: ['DRAFT'] }]);
  assert.match(output, /export const PRODUCT_STATUS_VALUES = \[/);
  assert.equal(/PRODUCTSTATUS/.test(output), false);
});

test('separates blocks with a blank line so the file is readable', () => {
  const output = renderEnumsModule([
    { name: 'Alpha', values: ['A'] },
    { name: 'Beta', values: ['B'] },
  ]);
  assert.match(output, /satisfies readonly Alpha\[\];\n\nexport const Beta/);
});

test('renders the DO NOT EDIT header', () => {
  assert.match(
    renderEnumsModule([{ name: 'Role', values: ['A'] }]),
    /GENERATED FILE — DO NOT EDIT/,
  );
});

test('render is deterministic — same input, byte-identical output', () => {
  const input = [{ name: 'Role', values: ['CUSTOMER', 'ADMIN'] }];
  assert.equal(renderEnumsModule(input), renderEnumsModule(input));
});

test('output ends with exactly one newline, so the drift check is not whitespace noise', () => {
  const output = renderEnumsModule([{ name: 'Role', values: ['A'] }]);
  assert.equal(output.endsWith('\n'), true);
  assert.equal(output.endsWith('\n\n'), false);
});

console.log(`prisma enum parser: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
