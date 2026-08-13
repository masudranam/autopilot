#!/usr/bin/env node
/**
 * Structural assertions over .github/workflows/ci.yml.
 *
 * Nothing in this repo checked the pipeline itself. A future PR could flip the replay
 * job back to `db:migrate`, drop the populate assertion, raise a timeout to 30, or
 * delete the `.only`/`.skip` grep — and every check would stay green, because the thing
 * being weakened is the thing doing the checking. pr-reviewer named this on #74: F6's
 * own acceptance criteria had no regression test, on the PR whose subject is pipeline
 * non-vacuity.
 *
 * The repo already has this pattern four times over (check-workspace-scripts,
 * check-env-example, check-infra-config, compose.spec) — this is the same idea applied
 * to CI. Runs inside `check:repo`, so it runs in CI too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { repoRoot } from './lib/compose.mjs';

const WORKFLOW = '.github/workflows/ci.yml';
const raw = readFileSync(join(repoRoot, WORKFLOW), 'utf8');
const workflow = parseYaml(raw);

/** F6/AC5: jobs run in parallel, so the pipeline budget is the max of all of them. */
const BUDGET_MINUTES = 10;

const problems = [];
const jobs = workflow.jobs ?? {};

/**
 * The `run:` bodies of a job's steps — deliberately NOT including `step.name`.
 *
 * Concatenating the label meant a step *named* "pnpm test" whose run was
 * `echo skipping` satisfied every command assertion below: the check validated labels,
 * not commands (pr-reviewer).
 */
function stepsOf(jobName) {
  return (jobs[jobName]?.steps ?? []).map((step) => step.run ?? '').join('\n');
}

/**
 * Ways to neutralise a job or step without removing anything the string assertions see.
 *
 * The important one is a job-level `if:` — a SKIPPED job still *satisfies* a required
 * status check, so `if: false` on migrations-replay would delete AC3 from the pipeline
 * while branch protection stayed perfectly content.
 */
function assertNotNeutralised(jobName) {
  const job = jobs[jobName];
  if (!job) {
    problems.push(`job "${jobName}" is missing entirely`);
    return;
  }

  if (job.if !== undefined) {
    problems.push(
      `job "${jobName}" has a job-level "if:" — a skipped job still satisfies a required status check, ` +
        `so this silently removes a criterion from the pipeline`,
    );
  }
  if (job['continue-on-error']) {
    problems.push(`job "${jobName}" sets continue-on-error — it can fail and still report green`);
  }

  for (const step of job.steps ?? []) {
    const label = step.name ?? step.uses ?? '(unnamed)';
    if (step['continue-on-error']) {
      problems.push(
        `step "${label}" in "${jobName}" sets continue-on-error — it can fail silently`,
      );
    }
    if (step.if !== undefined) {
      problems.push(`step "${label}" in "${jobName}" has an "if:" — a skipped step checks nothing`);
    }
  }
}

// ---- no job or step is neutralised while still looking present ----
for (const name of ['gate', 'migrations-replay', 'harness']) {
  assertNotNeutralised(name);
}

// ---- every job is bounded by the same budget (AC5) ----
for (const [name, job] of Object.entries(jobs)) {
  const timeout = job['timeout-minutes'];
  if (typeof timeout !== 'number') {
    problems.push(`job "${name}" has no timeout-minutes — an unbounded job cannot enforce AC5`);
  } else if (timeout > BUDGET_MINUTES) {
    problems.push(
      `job "${name}" allows ${timeout} minutes, over the ${BUDGET_MINUTES}-minute pipeline budget ` +
        `(F6/AC5). Jobs run in parallel, so the slowest one IS the pipeline.`,
    );
  }
}

// ---- the gate runs every step of the verify chain (AC1) ----
const gateSteps = stepsOf('gate');
for (const command of [
  'pnpm check:repo',
  'pnpm format:check',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm test',
  'pnpm build',
]) {
  if (!gateSteps.includes(command)) {
    problems.push(`the gate job no longer runs "${command}" (F6/AC1)`);
  }
}

// ---- the replay job resets rather than migrating (AC3) ----
const replaySteps = stepsOf('migrations-replay');
if (!replaySteps.includes('pnpm db:reset')) {
  problems.push(
    'the replay job does not run "pnpm db:reset" (F6/AC3, I7). Running db:migrate instead ' +
      'applies migrations to whatever already exists and never proves a replay from empty — ' +
      'which is exactly what this job did until #74.',
  );
}
if (!replaySteps.includes('db:assert-seeded')) {
  problems.push(
    'the replay job does not assert the replayed database is populated. Without it a replay ' +
      'producing an EMPTY catalogue passes green (F3/AC4).',
  );
}
if (/if \[ -f .*schema\.prisma/.test(raw)) {
  problems.push(
    'the replay job has an "if [ -f ... schema.prisma ]" guard again — a conditional whose ' +
      'else-branch is an unconditional pass, which is how this job goes silently vacuous.',
  );
}

// ---- the harness job keeps both guarantees (AC4) ----
const harnessSteps = stepsOf('harness');
if (!harnessSteps.includes('run-hook-tests.mjs')) {
  problems.push('the harness job no longer runs the hook test suite — the merge gate is unguarded');
}
if (!harnessSteps.includes('only|skip')) {
  problems.push('the harness job no longer greps for .only/.skip (F6/AC4, I9)');
}

// ---- the cache cannot make the gate vacuous (AC5) ----
// turbo.json is kept as PURE JSON. It was briefly JSONC (which Turbo and Prettier both
// accept), and the line-anchored comment-stripping workaround that used to live here
// crashed check:repo with a raw SyntaxError on an ordinary TRAILING comment — the
// invariants gate failing on a comment style the file's own format invited
// (pr-reviewer). The rationale that was in those comments is here instead.
const turbo = JSON.parse(readFileSync(join(repoRoot, 'turbo.json'), 'utf8'));

// `.github/workflows/**` and `infra/**` belong to no package, so without them a PR
// touching only CI or infra produced identical task hashes and every cacheable task
// replayed from cache: `pnpm test` reporting 158 tests passed having run none, with no
// Postgres touched. A Postgres major-version bump would never have been tested.
// `turbo.json` itself is included so changing the cache config cannot be cached.
for (const required of ['.github/workflows/**', 'infra/**', 'turbo.json']) {
  if (!(turbo.globalDependencies ?? []).includes(required)) {
    problems.push(
      `turbo.json globalDependencies is missing "${required}". Without it a PR touching only ` +
        `that path produces identical task hashes, so every cacheable task replays from cache — ` +
        `pnpm test reports passing having run nothing (demonstrated by pr-reviewer on #74).`,
    );
  }
}

if (problems.length) {
  console.error(`${WORKFLOW} has drifted from the F6 acceptance criteria:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nThe pipeline is the only quality signal an unattended loop has. Fix it.');
  process.exit(1);
}

console.log(
  `check-ci-workflow: ${Object.keys(jobs).length} jobs, all within the ${BUDGET_MINUTES}-minute budget, all criteria present`,
);
