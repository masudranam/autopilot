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

function stepsOf(jobName) {
  return (jobs[jobName]?.steps ?? [])
    .map((step) => `${step.name ?? step.uses ?? ''} ${step.run ?? ''}`)
    .join('\n');
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
const turbo = JSON.parse(
  readFileSync(join(repoRoot, 'turbo.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
);
for (const required of ['.github/workflows/**', 'infra/**']) {
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
