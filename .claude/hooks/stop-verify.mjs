#!/usr/bin/env node
/**
 * Stop
 *
 * Stops the agent from ending its turn on an unverified working tree.
 *
 * The failure this prevents is specific and common: files were edited, the change
 * looks right, and the turn ends without ever running the gate. The next thing that
 * happens is a PR opened on code that does not compile.
 *
 * Only fires when there are real source edits. A docs-only change, or a tree that was
 * already verified since the last edit, ends the turn normally.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { block, projectDir, readPayload, statePath } from './_lib.mjs';

const payload = await readPayload();

// A Stop hook that blocks on its own continuation would loop forever.
if (payload?.stop_hook_active) process.exit(0);

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
    }).trim();
  } catch {
    return '';
  }
}

const status = git(['status', '--porcelain']);
if (!status) process.exit(0);

const changed = status
  .split('\n')
  .map((line) => line.slice(3).trim())
  .filter(Boolean);

// Only source changes need the gate. Docs, specs and the harness itself do not.
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|prisma)$/i;
const sourceChanges = changed.filter((f) => SOURCE.test(f) && !f.startsWith('.claude/'));

if (sourceChanges.length === 0) process.exit(0);

// Did a verify run finish after the most recent edit?
const dirtyMarker = statePath('dirty.json');
const verifiedMarker = statePath('verified.json');

let lastEdit = 0;
let lastVerified = 0;

if (existsSync(dirtyMarker)) {
  try {
    lastEdit = Date.parse(JSON.parse(readFileSync(dirtyMarker, 'utf8')).at) || 0;
  } catch {
    /* ignore */
  }
}

if (existsSync(verifiedMarker)) {
  try {
    const v = JSON.parse(readFileSync(verifiedMarker, 'utf8'));
    if (v.result === 'pass') lastVerified = Date.parse(v.at) || 0;
  } catch {
    /* ignore */
  }
}

if (lastVerified > lastEdit) process.exit(0);

const preview = sourceChanges.slice(0, 8).map((f) => `  ${f}`).join('\n');
const more = sourceChanges.length > 8 ? `\n  …and ${sourceChanges.length - 8} more` : '';

block(
  `${sourceChanges.length} source file(s) changed but the verify gate has not passed since:\n\n` +
    `${preview}${more}\n\n` +
    `Run it before ending the turn:\n\n` +
    `  pnpm verify\n\n` +
    `Then record the result so this check knows it ran:\n\n` +
    `  node .claude/bin/mark-verified.mjs pass    # or: fail\n\n` +
    `If the gate fails, fix it or report the failure honestly with the real output —\n` +
    `do not mark it verified and do not describe a red gate as done.`,
);
