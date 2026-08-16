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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Refuse to record a verdict on a dirty working tree.
 *
 * Reviewers mutate files to prove a test can fail and restore them afterwards. One
 * killed mid-run by an API error leaves the mutation behind — during F5 a reviewer died
 * having replaced the production 500's `title` with the raw exception message, and
 * committing that would have shipped the exact information-disclosure bug it was
 * testing for. By the time a verdict is recorded the tree SHOULD be clean: verify has
 * run, the branch is pushed, and dist/generated/.turbo are all gitignored. So this is
 * the one point where "dirty" is unambiguously wrong, which makes it enforceable rather
 * than advice a busy agent skips.
 */
let dirty = '';
try {
  dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
} catch {
  /* handled by the rev-parse failure above */
}

if (dirty) {
  console.error(
    `record-verdict: refusing to record a verdict on a dirty working tree.\n\n${dirty
      .split('\n')
      .slice(0, 10)
      .map((line) => `  ${line}`)
      .join('\n')}\n\n` +
      `A review agent that died mid-run leaves its mutation behind. Read the diff before\n` +
      `doing anything else — do not stage it, and do not assume it is yours. If these\n` +
      `changes are genuinely intended, commit and push them, then re-run the reviewer:\n` +
      `the verdict must describe the code that will actually merge.`,
  );
  process.exit(1);
}

const file = join(projectDir, '.claude', 'state', `review-${pr}.json`);
mkdirSync(dirname(file), { recursive: true });

/**
 * The two-round rule, enforced rather than requested.
 *
 * `00-workflow.md` has said "two rounds maximum, then stop and report" since the start,
 * and PR #75 still ran four — each round closing the previous round's findings and
 * surfacing new ones, while nothing shipped. Prose does not stop that; a refusal does.
 *
 * Counts FAIL rounds only. A PASS is always recordable: the point is to stop grinding on
 * a rejected change, not to block the merge that ends the grind. `--override-rounds` is
 * the escape hatch, so a human can extend deliberately and leave a trace in the record.
 */
let priorFails = 0;
if (existsSync(file)) {
  try {
    const previous = JSON.parse(readFileSync(file, 'utf8'));
    priorFails = Number(previous.failRounds ?? 0);
  } catch {
    priorFails = 0;
  }
}

const override = process.argv.includes('--override-rounds');
if (verdict === 'FAIL' && priorFails >= 2 && !override) {
  console.error(
    `record-verdict: refusing a third FAIL round on PR #${pr}.\n\n` +
      `Two rounds have already failed. 00-workflow.md says stop and report to the\n` +
      `human at this point rather than grinding — the loop is not converging, and\n` +
      `another round usually finds new problems instead of finishing the old ones.\n\n` +
      `Report what is blocking and let a human decide. If they choose to continue,\n` +
      `re-run with --override-rounds, which records the extension in the verdict file.`,
  );
  process.exit(1);
}

const record = {
  pr: Number(pr),
  verdict,
  summary,
  headSha,
  branch,
  failRounds: verdict === 'FAIL' ? priorFails + 1 : priorFails,
  ...(override ? { roundLimitOverridden: true } : {}),
  recordedAt: new Date().toISOString(),
};

writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

console.log(`Recorded ${verdict} for PR #${pr} at ${headSha.slice(0, 8)} (${branch})`);
if (verdict !== 'PASS') {
  console.log('This verdict does NOT unlock the merge gate.');
}
