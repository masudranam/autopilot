#!/usr/bin/env node
/**
 * Records the outcome of a verify run so the Stop hook knows the gate actually ran.
 *
 *   node .claude/bin/mark-verified.mjs pass
 *   node .claude/bin/mark-verified.mjs fail
 *
 * Only 'pass' satisfies the Stop hook. Marking a failing gate as passed is lying to
 * the harness, and the harness is the only thing standing between a broken change and
 * an auto-merge.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const result = (process.argv[2] ?? '').toLowerCase();

if (result !== 'pass' && result !== 'fail') {
  console.error('usage: node .claude/bin/mark-verified.mjs <pass|fail>');
  process.exit(1);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const file = join(projectDir, '.claude', 'state', 'verified.json');
mkdirSync(dirname(file), { recursive: true });

writeFileSync(
  file,
  `${JSON.stringify({ result, at: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

console.log(`verify recorded: ${result}`);
