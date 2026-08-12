#!/usr/bin/env node
/**
 * PostToolUse · Write | Edit
 *
 * Formats the file that was just written, and records that the tree is dirty so the
 * Stop hook knows the verify gate needs re-running.
 *
 * Never blocks: a formatting failure must not interrupt work, it just gets reported.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { filePathOf, projectDir, readPayload, relativePath, statePath } from './_lib.mjs';

const payload = await readPayload();
const absolute = filePathOf(payload);
if (!absolute || !existsSync(absolute)) process.exit(0);

const path = relativePath(absolute);
const FORMATTABLE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|ya?ml|css|scss|html|prisma)$/i;

if (!FORMATTABLE.test(path)) process.exit(0);

// Mark the tree dirty for stop-verify.mjs.
try {
  const marker = statePath('dirty.json');
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ lastEdit: path, at: new Date().toISOString() }, null, 2));
} catch {
  /* the marker is an optimisation, not a requirement */
}

const prettier = join(
  projectDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
);
if (!existsSync(prettier)) process.exit(0);

try {
  execFileSync(prettier, ['--write', absolute], {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  console.log(`formatted ${path}`);
} catch (error) {
  // A syntax error means prettier cannot parse it — worth surfacing, since the file
  // is almost certainly broken.
  const detail = String(error.stderr || error.message || '')
    .trim()
    .split('\n')
    .slice(0, 4)
    .join('\n');
  console.log(`prettier could not format ${path}:\n${detail}`);
}
