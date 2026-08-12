#!/usr/bin/env node
/**
 * Records a pr-reviewer verdict so the merge gate can consult it.
 *
 *   node .claude/bin/record-verdict.mjs --pr 42 --verdict PASS --summary "..."
 *
 * The head SHA is read from git rather than accepted as an argument, so a verdict is
 * always stamped with the commit that actually exists — a stale or invented SHA cannot
 * be recorded by mistake. See docs/adr/0008-hook-enforced-merge-gate.md.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VALID = new Set(['PASS', 'FAIL', 'BLOCKED']);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const pr = arg('pr');
const verdict = (arg('verdict') ?? '').toUpperCase();
const summary = arg('summary') ?? '';

if (!pr || !/^\d+$/.test(pr)) {
  console.error('record-verdict: --pr <number> is required');
  process.exit(1);
}

if (!VALID.has(verdict)) {
  console.error(`record-verdict: --verdict must be one of ${[...VALID].join(', ')}`);
  process.exit(1);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let headSha = '';
let branch = '';
try {
  headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  console.error('record-verdict: not a git repository, or git is unavailable');
  process.exit(1);
}

if (branch === 'main' || branch === 'master') {
  console.error(
    `record-verdict: refusing to record a verdict while on '${branch}'.\n` +
      `Check out the PR branch first — the gate compares the recorded SHA against local HEAD,\n` +
      `so a verdict stamped on main would never match the branch being merged.`,
  );
  process.exit(1);
}

const file = join(projectDir, '.claude', 'state', `review-${pr}.json`);
mkdirSync(dirname(file), { recursive: true });

const record = {
  pr: Number(pr),
  verdict,
  summary,
  headSha,
  branch,
  recordedAt: new Date().toISOString(),
};

writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

console.log(`Recorded ${verdict} for PR #${pr} at ${headSha.slice(0, 8)} (${branch})`);
if (verdict !== 'PASS') {
  console.log('This verdict does NOT unlock the merge gate.');
}
