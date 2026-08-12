#!/usr/bin/env node
/**
 * Tests for the compose port parser.
 *
 * This helper exists because the naive `split(':')[0]` version returned NaN for every
 * real mapping in this repo — the host side is `${VAR:-5442}`, which contains its own
 * colon. Both checks that used it silently saw zero ports and reported green, which is
 * the worst possible failure for a guard. These cases lock that behaviour down.
 *
 *   node scripts/lib/compose.spec.mjs
 */
import { hostPortOf, loadCompose, publishedPorts } from './compose.mjs';

let passed = 0;
const failures = [];

function expectEqual(name, actual, expected) {
  const ok = Object.is(actual, expected) || (Number.isNaN(actual) && Number.isNaN(expected));
  if (ok) passed += 1;
  else failures.push(`${name}\n    expected ${String(expected)}, got ${String(actual)}`);
}

// The form this repo actually uses — the one the broken version got wrong.
expectEqual('interpolated with default', hostPortOf('${POSTGRES_PORT:-5442}:5432'), 5442);
expectEqual('interpolated, quoted', hostPortOf('"${REDIS_PORT:-6389}:6379"'), 6389);
expectEqual('plain mapping', hostPortOf('5442:5432'), 5442);
expectEqual('ip-qualified mapping', hostPortOf('127.0.0.1:5442:5432'), 5442);
expectEqual('no default supplied', hostPortOf('${SOME_PORT}:5432'), Number.NaN);
expectEqual('container port only', hostPortOf('5432'), 5432);
expectEqual('nonsense', hostPortOf('not-a-port'), Number.NaN);

// Against the real file: every service must yield a usable host port.
const ports = publishedPorts(loadCompose());
expectEqual(
  'every published port parses',
  ports.every((p) => Number.isInteger(p.port)),
  true,
);

if (ports.length < 6) {
  failures.push(
    `expected at least 6 published ports across the stack, parsed ${ports.length}\n` +
      '    (a low count is the symptom of the parsing bug this file guards against)',
  );
} else {
  passed += 1;
}

console.log(`\ncompose parser: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL  ${f}`);
  process.exit(1);
}
console.log(`parsed ports: ${ports.map((p) => `${p.service}=${p.port}`).join(', ')}`);
