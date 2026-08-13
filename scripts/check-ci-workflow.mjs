#!/usr/bin/env node
/**
 * Asserts the pipeline still enforces what SPEC.md F6 says it does.
 *
 * Nothing in this repo checked CI itself, so any of F6's fixes could be silently
 * reverted: the thing being weakened was the thing doing the checking. The invariants
 * live in scripts/lib/ci-workflow.mjs so they can be driven by fixtures — see
 * check-ci-workflow.spec.mjs, which exists because pr-reviewer deleted this check's
 * call site and watched the whole gate stay green.
 *
 * Runs inside `check:repo`, so it runs in CI too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { repoRoot } from './lib/compose.mjs';
import { BUDGET_MINUTES, findPipelineProblems } from './lib/ci-workflow.mjs';

const WORKFLOW = '.github/workflows/ci.yml';

const workflowText = readFileSync(join(repoRoot, WORKFLOW), 'utf8');
const turboText = readFileSync(join(repoRoot, 'turbo.json'), 'utf8');

let turbo;
try {
  turbo = JSON.parse(turboText);
} catch (error) {
  // An unactionable SyntaxError here is how this check failed before: turbo.json was
  // briefly JSONC and a trailing comment crashed it with no explanation. The purity
  // check inside findPipelineProblems is the real guard; this is the fallback message.
  console.error(
    `check-ci-workflow: turbo.json is not valid JSON.\n\n  ${String(error).split('\n')[0]}\n\n` +
      'Turbo and Prettier accept JSONC, but every consumer in this repo uses JSON.parse.\n' +
      'Keep turbo.json pure JSON; rationale belongs in scripts/lib/ci-workflow.mjs.',
  );
  process.exit(1);
}

const problems = findPipelineProblems({
  workflow: parseYaml(workflowText),
  turbo,
  workflowText,
  turboText,
});

if (problems.length > 0) {
  console.error(`${WORKFLOW} has drifted from the F6 acceptance criteria:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nThe pipeline is the only quality signal an unattended loop has. Fix it.');
  process.exit(1);
}

const jobCount = Object.keys(parseYaml(workflowText).jobs ?? {}).length;
console.log(
  `check-ci-workflow: ${jobCount} jobs, all within the ${BUDGET_MINUTES}-minute budget, all criteria present`,
);
