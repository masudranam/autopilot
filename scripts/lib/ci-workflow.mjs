/**
 * The pipeline invariants, as a pure function over (workflow, turbo) so they can be
 * driven by fixtures.
 *
 * Previously this logic lived inline in a script that read the real files and called
 * process.exit, which meant it could only ever be hand-verified: pr-reviewer replaced
 * the assertNotNeutralised call site with `void assertNotNeutralised;` and everything
 * stayed green. Exporting it is what makes check-ci-workflow.spec.mjs possible, and
 * that spec is what stops these checks silently rotting — the same defect this whole
 * family of checks exists to prevent.
 */

/** F6/AC5: jobs run in parallel, so the pipeline budget is the max over all of them. */
export const BUDGET_MINUTES = 10;

/** The jobs that must exist, and the commands the gate must actually run. */
export const REQUIRED_JOBS = ['gate', 'migrations-replay', 'harness'];

const GATE_COMMANDS = [
  'pnpm check:repo',
  'pnpm format:check',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm test',
  'pnpm build',
];

/**
 * A gate step's `run:` body must be EXACTLY one of its allowed commands.
 *
 * This replaces a blocklist of neutralising shell shapes, which kept losing: two review
 * rounds surfaced `|| true`, `|| :`, an echo prefix, `--testPathPatterns=nothing`,
 * `true &&`, then `|| echo ok`, `|| exit 0`, `set +e`, `--testPathIgnorePatterns=.` and
 * a step-level `shell:`. Enumerating ways to defang a command is unbounded; requiring
 * the command to be exactly what it claims is not.
 *
 * Exact-match also closes the substring hazard that let `pnpm test:e2e` satisfy the
 * `pnpm test` assertion while running zero tests — the single most consequential hole
 * either round found, because it removes the whole suite from CI in one token.
 */
function normaliseRun(run) {
  return String(run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join('\n');
}

/** Shells that behave normally. Anything else can neutralise every command it runs. */
const SAFE_SHELLS = /^(bash|sh|pwsh|powershell|python)$/;

/** Steps identified by `uses:` whose presence is itself an acceptance criterion. */
const REQUIRED_USES = [
  { job: 'gate', match: /actions\/cache/, why: 'the Turbo cache restore step (F6/AC5) is gone' },
  { job: 'gate', match: /actions\/checkout/, why: 'the checkout step is gone' },
  { job: 'gate', match: /pnpm\/action-setup/, why: 'the pnpm setup step is gone' },
];

/**
 * @param {object} input
 * @param {object} input.workflow parsed ci.yml
 * @param {object} input.turbo parsed turbo.json
 * @param {string} input.workflowText raw ci.yml, for patterns YAML parsing loses
 * @param {string} input.turboText raw turbo.json
 * @returns {string[]} problems; empty means the pipeline is intact
 */
export function findPipelineProblems({ workflow, turbo, workflowText, turboText }) {
  const problems = [];
  const jobs = workflow?.jobs ?? {};

  /** `run:` bodies only — a step NAMED "pnpm test" running `echo skipping` is not a test. */
  const runsOf = (jobName) => (jobs[jobName]?.steps ?? []).map((step) => step.run ?? '').join('\n');

  // ---- turbo.json must stay pure JSON ----
  //
  // It was briefly JSONC. Turbo and Prettier both accept that, but every consumer here
  // uses JSON.parse, so one ordinary TRAILING comment crashed check:repo with a raw
  // SyntaxError. Deleting the comments only removed that instance; this is the check
  // that closes it, because a code comment saying "keep this pure" is not enforcement.
  if (
    turboText !== undefined &&
    /^\s*\/\/|[^:]\/\/[^/]/.test(turboText.replace(/"[^"]*"/g, '""'))
  ) {
    problems.push(
      'turbo.json contains a comment. Turbo and Prettier accept JSONC, but every consumer ' +
        'in this repo uses JSON.parse, so a comment crashes check:repo with an unactionable ' +
        'SyntaxError. Keep it pure JSON and put rationale in scripts/lib/ci-workflow.mjs.',
    );
  }

  // ---- required jobs exist, are bounded, and are not neutralised ----
  for (const name of REQUIRED_JOBS) {
    const job = jobs[name];
    if (!job) {
      problems.push(`job "${name}" is missing entirely`);
      continue;
    }

    const timeout = job['timeout-minutes'];
    if (typeof timeout !== 'number') {
      problems.push(`job "${name}" has no timeout-minutes — an unbounded job cannot enforce AC5`);
    } else if (timeout > BUDGET_MINUTES) {
      problems.push(
        `job "${name}" allows ${timeout} minutes, over the ${BUDGET_MINUTES}-minute budget (F6/AC5). ` +
          'Jobs run in parallel, so the slowest one IS the pipeline.',
      );
    }

    // A SKIPPED job SATISFIES a required status check, so `if: false` deletes a
    // criterion while branch protection stays content.
    if (job.if !== undefined) {
      problems.push(
        `job "${name}" has a job-level "if:" — a skipped job still satisfies a required status check`,
      );
    }
    if (job['continue-on-error']) {
      problems.push(`job "${name}" sets continue-on-error — it can fail and still report green`);
    }
    if ((job.steps ?? []).length === 0) {
      problems.push(`job "${name}" has no steps`);
    }

    for (const step of job.steps ?? []) {
      const label = step.name ?? step.uses ?? '(unnamed)';
      if (step['continue-on-error']) {
        problems.push(`step "${label}" in "${name}" sets continue-on-error — it can fail silently`);
      }
      if (step.if !== undefined) {
        problems.push(`step "${label}" in "${name}" has an "if:" — a skipped step checks nothing`);
      }
      // A per-step shell is the targeted version of the defaults.run.shell attack.
      if (step.shell && !SAFE_SHELLS.test(String(step.shell).trim())) {
        problems.push(
          `step "${label}" in "${name}" sets a custom shell (${String(step.shell)}) — it can neutralise the command`,
        );
      }

      // working-directory changes WHAT a command operates on while leaving the run:
      // body byte-identical, so exact matching cannot see it. Verified consequence:
      // `working-directory: packages/contracts` on the gate's Test step exits 0 having
      // run 92 contract tests, while the 158 API tests — everything that needs the
      // Postgres service, i.e. all of AC2 — never run, and every check reports green
      // (pr-reviewer). The gate must run from the repo root.
      if (step['working-directory'] !== undefined) {
        problems.push(
          `step "${label}" in "${name}" sets working-directory (${String(step['working-directory'])}) — ` +
            'this changes which packages the command covers while leaving its text unchanged',
        );
      }
    }
  }

  // ---- a custom shell can neutralise every run: step at once ----
  for (const [scope, defaults] of [
    ['workflow', workflow?.defaults],
    ...REQUIRED_JOBS.map((name) => [`job "${name}"`, jobs[name]?.defaults]),
  ]) {
    const shell = defaults?.run?.shell;
    if (shell && !SAFE_SHELLS.test(String(shell).trim())) {
      problems.push(
        `${scope} sets a custom "defaults.run.shell" (${String(shell)}) — this can neutralise every run: step at once`,
      );
    }
    // Same hazard as the step-level key, applied to every step at once.
    if (defaults?.run?.['working-directory'] !== undefined) {
      problems.push(
        `${scope} sets "defaults.run.working-directory" — every command would run somewhere other than the repo root`,
      );
    }
  }

  // ---- the gate runs the whole verify chain (AC1) ----
  //
  // EXACT match against a normalised run: body, not `includes`. A substring check let
  // `pnpm test:e2e` satisfy `pnpm test` — and since no package declares a test:e2e
  // script, that runs zero tasks and exits 0, silently removing all 158 tests from CI
  // in a one-token edit (pr-reviewer). `pnpm lint:fix` for `pnpm lint` is the milder
  // sibling: a real script that auto-fixes instead of failing.
  const gateRunBodies = new Set((jobs.gate?.steps ?? []).map((step) => normaliseRun(step.run)));
  for (const command of GATE_COMMANDS) {
    if (!gateRunBodies.has(command)) {
      const nearMiss = [...gateRunBodies].find(
        (body) => body.includes(command) && body !== command,
      );
      problems.push(
        `the gate job does not run exactly "${command}" (F6/AC1)` +
          (nearMiss ? ` — closest step is "${nearMiss}", which is not the same command` : ''),
      );
    }
  }

  // ---- steps identified by uses: are asserted too ----
  for (const { job, match, why } of REQUIRED_USES) {
    const uses = (jobs[job]?.steps ?? []).map((step) => step.uses ?? '').join('\n');
    if (!match.test(uses)) problems.push(`${why} (job "${job}")`);
  }

  // ---- the replay job resets rather than migrating (AC3) ----
  //
  // Exact-line match: `echo db:assert-seeded` previously satisfied the assertion below,
  // because the echo guard only looked for the literal "pnpm" on the line.
  const replayLines = new Set(
    (jobs['migrations-replay']?.steps ?? []).flatMap((step) => normaliseRun(step.run).split('\n')),
  );
  const replayRuns = runsOf('migrations-replay');
  if (!replayLines.has('pnpm db:reset')) {
    problems.push(
      'the replay job does not run "pnpm db:reset" (F6/AC3, I7). db:migrate applies migrations to ' +
        'whatever already exists and never proves a replay from empty.',
    );
  }
  if (!replayLines.has('pnpm --filter @repo/api run db:assert-seeded')) {
    problems.push(
      'the replay job does not assert the replayed database is populated — a replay producing an ' +
        'EMPTY catalogue would pass green (F3/AC4).',
    );
  }
  if (workflowText && /if \[ -f .*schema\.prisma/.test(workflowText)) {
    problems.push(
      'the replay job has an "if [ -f ... schema.prisma ]" guard again — a conditional whose ' +
        'else-branch is an unconditional pass',
    );
  }

  // ---- the harness job keeps both guarantees (AC4) ----
  const harnessRuns = runsOf('harness');
  const harnessLines = new Set(
    (jobs.harness?.steps ?? []).flatMap((step) => normaliseRun(step.run).split('\n')),
  );
  // Exact line, so `echo run-hook-tests.mjs` no longer satisfies it.
  if (!harnessLines.has('node .claude/hooks/__tests__/run-hook-tests.mjs')) {
    problems.push(
      'the harness job no longer runs the hook test suite — the merge gate is unguarded',
    );
  }
  // The I9 grep is a multi-line shell block, so it cannot be exact-matched like a
  // single command. Instead the step that CONTAINS the pattern must genuinely invoke
  // grep: substring-matching alone let `true # only|skip '*.spec.ts' …` satisfy all
  // four of these assertions while enforcing nothing (pr-reviewer).
  const i9Step = (jobs.harness?.steps ?? []).find((step) =>
    normaliseRun(step.run).includes('only|skip'),
  );

  if (!i9Step) {
    problems.push('the harness job no longer greps for .only/.skip (F6/AC4, I9)');
  } else {
    const body = normaliseRun(i9Step.run);
    const lines = body.split('\n');

    // A real invocation, not a mention: grep must start a line (allowing `if `), and
    // the step must be able to fail.
    if (!lines.some((line) => /^(if\s+)?grep\b/.test(line))) {
      problems.push(
        'the I9 step mentions "only|skip" but never invokes grep at the start of a line — ' +
          'a comment or an echoed string enforces nothing',
      );
    }
    if (!body.includes('exit 1')) {
      problems.push(
        'the I9 step never exits non-zero, so a planted .only would not fail the build',
      );
    }
    // Quoted, because '*.spec.tsx' CONTAINS '*.spec.ts' — an unquoted check was
    // satisfied by the wrong glob, which the spec caught on its first run.
    for (const suffix of ['*.spec.ts', '*.e2e-spec.ts', '*.spec.tsx']) {
      if (!body.includes(`'${suffix}'`)) {
        problems.push(`the I9 grep no longer covers "${suffix}" — .only becomes plantable there`);
      }
    }
  }

  // ---- the cache cannot make the gate vacuous ----
  //
  // .github/workflows/** and infra/** belong to no package, so without them a PR
  // touching only CI or infra produced identical task hashes and every cacheable task
  // replayed: `pnpm test` reporting 158 passed having run none, no Postgres touched.
  for (const required of ['.github/workflows/**', 'infra/**', 'turbo.json']) {
    if (!(turbo?.globalDependencies ?? []).includes(required)) {
      problems.push(
        `turbo.json globalDependencies is missing "${required}" — a PR touching only that path ` +
          'would replay every cacheable task from cache and report tests passing having run none',
      );
    }
  }

  return problems;
}
