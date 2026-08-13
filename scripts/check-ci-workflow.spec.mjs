#!/usr/bin/env node
/**
 * Tests for the pipeline invariants.
 *
 * This file exists because pr-reviewer replaced `assertNotNeutralised`'s call site with
 * `void assertNotNeutralised;` and the entire gate stayed green — 63 lines of new
 * enforcement with nothing behind it, which is the exact defect the check itself was
 * written to prevent, recurring in the same file.
 *
 * It works on FIXTURES derived from the real ci.yml, so it closes the class rather than
 * one instance: every attack gets an entry, and a future attack gets a new one here
 * rather than a hand-verification that evaporates when the PR merges.
 *
 *   node scripts/check-ci-workflow.spec.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { repoRoot } from './lib/compose.mjs';
import { findPipelineProblems } from './lib/ci-workflow.mjs';

const workflowText = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const turboText = readFileSync(join(repoRoot, 'turbo.json'), 'utf8');

/** Deep clone so a mutation cannot leak into the next case. */
const clone = (value) => structuredClone(value);

const baseWorkflow = parseYaml(workflowText);
const baseTurbo = JSON.parse(turboText);

let passed = 0;
const failures = [];

/**
 * @param name what the mutation does
 * @param mutate receives { workflow, turbo, texts } and returns nothing (mutate in place)
 * @param expect substring the diagnostic must contain, proving it failed for the right reason
 */
function attack(name, mutate, expect) {
  const workflow = clone(baseWorkflow);
  const turbo = clone(baseTurbo);
  const texts = { workflowText, turboText };
  mutate({ workflow, turbo, texts });

  const problems = findPipelineProblems({
    workflow,
    turbo,
    workflowText: texts.workflowText,
    turboText: texts.turboText,
  });

  if (problems.length === 0) {
    failures.push(`${name}\n    NOT CAUGHT — the checker reported no problems`);
    return;
  }
  if (expect && !problems.some((problem) => problem.includes(expect))) {
    failures.push(
      `${name}\n    caught, but no diagnostic mentions "${expect}"\n    got: ${problems[0]}`,
    );
    return;
  }
  passed += 1;
}

function expectClean(name, mutate = () => {}) {
  const workflow = clone(baseWorkflow);
  const turbo = clone(baseTurbo);
  const texts = { workflowText, turboText };
  mutate({ workflow, turbo, texts });

  const problems = findPipelineProblems({
    workflow,
    turbo,
    workflowText: texts.workflowText,
    turboText: texts.turboText,
  });
  if (problems.length === 0) passed += 1;
  else failures.push(`${name}\n    expected no problems, got:\n      ${problems.join('\n      ')}`);
}

const stepIn = (workflow, job, predicate) => workflow.jobs[job].steps.find(predicate);
const testStep = (workflow) => stepIn(workflow, 'gate', (step) => step.run === 'pnpm test');

// ---------------------------------------------------------------- baseline

expectClean('the real pipeline passes');

// ---------------------------------------------------------------- neutralisation

attack(
  'a step LABELLED "pnpm test" whose run is a no-op',
  ({ workflow }) => {
    const step = testStep(workflow);
    step.name = 'pnpm test';
    step.run = 'echo skipping';
  },
  'does not run exactly "pnpm test"',
);

attack(
  'pnpm test || true',
  ({ workflow }) => {
    testStep(workflow).run = 'pnpm test || true';
  },
  'does not run exactly "pnpm test"',
);

attack(
  'the command echoed rather than run',
  ({ workflow }) => {
    testStep(workflow).run = 'echo would run pnpm test';
  },
  'does not run exactly "pnpm test"',
);

attack(
  'a test path filter that selects nothing',
  ({ workflow }) => {
    testStep(workflow).run = 'pnpm test -- --testPathPatterns=zzz-nothing';
  },
  'does not run exactly "pnpm test"',
);

attack(
  'if: false on the replay job (a skipped job satisfies a required check)',
  ({ workflow }) => {
    workflow.jobs['migrations-replay'].if = false;
  },
  'still satisfies a required status check',
);

attack(
  'continue-on-error on the Test step',
  ({ workflow }) => {
    testStep(workflow)['continue-on-error'] = true;
  },
  'fail silently',
);

attack(
  'continue-on-error on a whole job',
  ({ workflow }) => {
    workflow.jobs.harness['continue-on-error'] = true;
  },
  'still report green',
);

attack(
  'a custom defaults.run.shell neutralising every step at once',
  ({ workflow }) => {
    workflow.defaults = { run: { shell: 'bash -c "true" {0}' } };
  },
  'neutralise every run: step',
);

// The targeted version of the same attack — the per-step `shell:` key was never read.
attack(
  'a custom step-level shell',
  ({ workflow }) => {
    testStep(workflow).shell = 'bash -c "true" {0}';
  },
  'custom shell',
);

// A step-level `if:` was enforced but had no fixture — the one mutation of fourteen the
// spec missed, so it could have rotted silently (pr-reviewer).
attack(
  'if: false on the Test step',
  ({ workflow }) => {
    testStep(workflow).if = false;
  },
  'skipped step checks nothing',
);

/**
 * The substring hazard, in the assertion that guards the test suite itself.
 *
 * `'pnpm test:e2e'.includes('pnpm test')` is true, and since no package declares a
 * test:e2e script, `turbo run test:e2e` runs zero tasks and exits 0 — so this one-token
 * edit removed all 158 tests from CI while the checker reported every criterion present.
 * The most consequential hole either review round found.
 */
attack(
  'pnpm test swapped for pnpm test:e2e (runs zero tasks, exits 0)',
  ({ workflow }) => {
    testStep(workflow).run = 'pnpm test:e2e';
  },
  'does not run exactly "pnpm test"',
);

attack(
  'pnpm lint swapped for pnpm lint:fix (auto-fixes instead of failing)',
  ({ workflow }) => {
    stepIn(workflow, 'gate', (step) => step.run === 'pnpm lint').run = 'pnpm lint:fix';
  },
  'does not run exactly "pnpm lint"',
);

// The blocklist of neutralising shell shapes kept losing — these five are the ones two
// review rounds found after the first three were closed. Exact-match makes the whole
// class unreachable rather than enumerating it.
for (const [label, run] of [
  ['|| echo ok', 'pnpm test || echo ok'],
  ['|| exit 0', 'pnpm test || exit 0'],
  ['set +e then exit 0', 'set +e\npnpm test\nexit 0'],
  ['--testPathIgnorePatterns', 'pnpm test -- --testPathIgnorePatterns=.'],
  ['|| true', 'pnpm test || true'],
  ['; exit 0', 'pnpm test; exit 0'],
  ['echoed', 'echo pnpm test'],
]) {
  attack(
    `Test neutralised with ${label}`,
    ({ workflow }) => {
      testStep(workflow).run = run;
    },
    'does not run exactly "pnpm test"',
  );
}

// The harness and replay assertions were echo-able because the old guard required the
// literal "pnpm" on the line.
attack(
  'the hook suite command echoed rather than run',
  ({ workflow }) => {
    stepIn(workflow, 'harness', (step) => String(step.run ?? '').includes('run-hook-tests')).run =
      'echo node .claude/hooks/__tests__/run-hook-tests.mjs';
  },
  'merge gate is unguarded',
);

attack(
  'the populate assertion echoed rather than run',
  ({ workflow }) => {
    stepIn(workflow, 'migrations-replay', (step) =>
      String(step.run ?? '').includes('db:assert-seeded'),
    ).run = 'echo db:assert-seeded';
  },
  'EMPTY catalogue',
);

attack(
  'an emptied steps list',
  ({ workflow }) => {
    workflow.jobs.gate.steps = [];
  },
  'no steps',
);

// ---------------------------------------------------------------- budget

attack(
  'a job over the budget',
  ({ workflow }) => {
    workflow.jobs.harness['timeout-minutes'] = 30;
  },
  'over the 10-minute budget',
);

attack(
  'a job with no timeout at all',
  ({ workflow }) => {
    delete workflow.jobs.gate['timeout-minutes'];
  },
  'no timeout-minutes',
);

// ---------------------------------------------------------------- the criteria themselves

for (const command of [
  'pnpm check:repo',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm test',
  'pnpm build',
]) {
  attack(
    `the gate dropping "${command}"`,
    ({ workflow }) => {
      workflow.jobs.gate.steps = workflow.jobs.gate.steps.filter((step) => step.run !== command);
    },
    `does not run exactly "${command}"`,
  );
}

// Binds the db:reset EXACT match specifically: a substring check accepts this, because
// the line still contains "db:reset". Reverting the checker to `includes` left the spec
// at 47 passed, which is how pr-reviewer found this enforcement had no fixture.
attack(
  'db:reset neutralised with || true (exact-match coverage)',
  ({ workflow }) => {
    stepIn(workflow, 'migrations-replay', (step) => step.run === 'pnpm db:reset').run =
      'pnpm db:reset || true';
  },
  'does not run "pnpm db:reset"',
);

attack(
  'the replay job reverting to db:migrate',
  ({ workflow }) => {
    stepIn(workflow, 'migrations-replay', (step) => step.run === 'pnpm db:reset').run =
      'pnpm db:migrate';
  },
  'does not run "pnpm db:reset"',
);

attack(
  'dropping the populate assertion',
  ({ workflow }) => {
    workflow.jobs['migrations-replay'].steps = workflow.jobs['migrations-replay'].steps.filter(
      (step) => !String(step.run ?? '').includes('db:assert-seeded'),
    );
  },
  'EMPTY catalogue',
);

attack(
  'reintroducing the schema.prisma conditional',
  ({ texts }) => {
    texts.workflowText += '\n          if [ -f apps/api/prisma/schema.prisma ]; then :; fi\n';
  },
  'unconditional pass',
);

attack(
  'dropping the hook test suite',
  ({ workflow }) => {
    workflow.jobs.harness.steps = workflow.jobs.harness.steps.filter(
      (step) => !String(step.run ?? '').includes('run-hook-tests'),
    );
  },
  'merge gate is unguarded',
);

/**
 * working-directory changes WHAT a command covers while leaving its text byte-identical,
 * so exact matching is blind to it. Verified consequence: `packages/contracts` on the
 * Test step exits 0 having run 92 contract tests, while the 158 API tests — everything
 * needing the Postgres service, i.e. all of AC2 — never run (pr-reviewer).
 */
attack(
  'working-directory on the Test step (all 158 API tests silently skipped)',
  ({ workflow }) => {
    testStep(workflow)['working-directory'] = 'packages/contracts';
  },
  'sets working-directory',
);

attack(
  'job-level defaults.run.working-directory',
  ({ workflow }) => {
    workflow.jobs.gate.defaults = { run: { 'working-directory': 'packages/contracts' } };
  },
  'defaults.run.working-directory',
);

attack(
  'workflow-level defaults.run.working-directory',
  ({ workflow }) => {
    workflow.defaults = { run: { 'working-directory': 'packages/contracts' } };
  },
  'defaults.run.working-directory',
);

// The I9 step is a multi-line block, so it cannot be exact-matched. These two prove the
// substitute — "grep must actually be invoked, and the step must be able to fail" —
// binds. Substring matching alone accepted a no-op that merely mentioned the strings.
attack(
  'the whole I9 step replaced by a no-op that merely mentions the strings',
  ({ workflow }) => {
    stepIn(workflow, 'harness', (step) => String(step.run ?? '').includes('only|skip')).run =
      "true # only|skip '*.spec.ts' '*.e2e-spec.ts' '*.spec.tsx'";
  },
  'never invokes grep',
);

attack(
  'the I9 grep left in place but unable to fail',
  ({ workflow }) => {
    const step = stepIn(workflow, 'harness', (s) => String(s.run ?? '').includes('only|skip'));
    step.run = step.run.replace(/exit 1/g, 'exit 0');
  },
  'never exits non-zero',
);

attack(
  'narrowing the I9 grep so .only becomes plantable',
  ({ workflow }) => {
    const step = stepIn(workflow, 'harness', (s) => String(s.run ?? '').includes('only|skip'));
    step.run = step.run.replace(/--include='\*\.spec\.ts'/, "--include='*.nope'");
  },
  'no longer covers "*.spec.ts"',
);

attack(
  'deleting the Turbo cache restore step (F6/AC5)',
  ({ workflow }) => {
    workflow.jobs.gate.steps = workflow.jobs.gate.steps.filter(
      (step) => !String(step.uses ?? '').includes('actions/cache'),
    );
  },
  'cache restore step',
);

// ---------------------------------------------------------------- vacuity

for (const dependency of ['.github/workflows/**', 'infra/**', 'turbo.json']) {
  attack(
    `removing "${dependency}" from globalDependencies`,
    ({ turbo }) => {
      turbo.globalDependencies = turbo.globalDependencies.filter((entry) => entry !== dependency);
    },
    'having run none',
  );
}

// ---------------------------------------------------------------- turbo.json purity

attack(
  'a TRAILING comment in turbo.json (the crash that was never actually closed)',
  ({ texts }) => {
    texts.turboText = texts.turboText.replace('"infra/**",', '"infra/**", // compose versions');
  },
  'contains a comment',
);

attack(
  'a line-leading comment in turbo.json',
  ({ texts }) => {
    texts.turboText = texts.turboText.replace('  "ui"', '  // stream is easier to parse\n  "ui"');
  },
  'contains a comment',
);

// This case previously took no mutate argument, making it byte-identical to the
// baseline: it could not fail for its stated reason, and deleting the string-stripping
// pass left the spec at 29 passed (pr-reviewer). It now injects a URL with a DOUBLE
// slash in the path, which is the form that actually false-positives without stripping.
expectClean('a URL containing // inside a string is not mistaken for a comment', ({ texts }) => {
  texts.turboText = texts.turboText.replace(
    '"ui": "stream",',
    '"ui": "stream",\n  "docsUrl": "https://example.dev//deep/path",',
  );
});

// ---------------------------------------------------------------- report

console.log(`\nci-workflow invariants: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL  ${failure}\n`);
  console.log('The pipeline guard is not trustworthy until these pass.');
  process.exit(1);
}
console.log('Every known way to weaken the pipeline is caught.');
