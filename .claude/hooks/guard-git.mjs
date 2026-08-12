#!/usr/bin/env node
/**
 * PreToolUse · Bash | PowerShell
 *
 * The enforcement half of the merge gate (docs/adr/0008-hook-enforced-merge-gate.md).
 *
 * Blocks:
 *   1. `git commit` while on main/master — every change must arrive by PR (I10)
 *   2. force pushes and branch deletion of main
 *   3. `gh pr merge` unless pr-reviewer recorded PASS for the CURRENT head SHA
 *
 * Prompt-level instructions get forgotten across a 54-PR unattended run. This does not.
 */
import { execFileSync } from 'node:child_process';
import {
  allow,
  block,
  commandOf,
  readPayload,
  readJsonIfExists,
  segments,
  statePath,
} from './_lib.mjs';

const payload = await readPayload();
const command = commandOf(payload);
if (!command.trim()) allow();

const parts = segments(command);

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 1 · no commits on main

const PROTECTED = new Set(['main', 'master']);

for (const part of parts) {
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(part)) continue;

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!PROTECTED.has(branch)) continue;

  // Bootstrap: before the repository is published there is no PR workflow to route a
  // commit through, so building the initial history on main is legitimate. The moment
  // an 'origin' remote exists, main is closed and everything goes through review.
  const published = git(['remote', 'get-url', 'origin']) !== '';
  if (!published) continue;

  block(
    `BLOCKED: commit on '${branch}'.\n\n` +
      `Every change reaches main through a reviewed pull request (SPEC.md I10).\n` +
      `Create a feature branch first:\n\n` +
      `  git checkout -b feat/<issue-number>-<slug>\n\n` +
      `Then commit, push, open a PR, and let pr-reviewer gate the merge.`,
  );
}

// ---------------------------------------------------------------- 2 · destructive git

for (const part of parts) {
  if (
    /\bgit\b[\s\S]*\bpush\b/.test(part) &&
    /(--force(?!-with-lease)|(?:^|\s)-f(?:\s|$))/.test(part)
  ) {
    block(
      `BLOCKED: force push.\n\n` +
        `Force pushing rewrites published history and can destroy a branch another\n` +
        `process is reviewing. If a branch genuinely needs rewriting, use\n` +
        `--force-with-lease and say why in the PR.`,
    );
  }

  if (/\bgit\b[\s\S]*\bpush\b[\s\S]*--delete[\s\S]*\b(main|master)\b/.test(part)) {
    block('BLOCKED: deleting the main branch on the remote.');
  }

  if (/\bgit\b[\s\S]*\bbranch\b[\s\S]*-D[\s\S]*\b(main|master)\b/.test(part)) {
    block('BLOCKED: deleting the local main branch.');
  }
}

// ---------------------------------------------------------------- 3 · the merge gate

for (const part of parts) {
  if (!/\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b/.test(part)) continue;

  // Require an explicit PR number. Without one we cannot tell which verdict to check,
  // and a gate that guesses is not a gate.
  const prMatch = part.match(/\bpr\s+merge\s+(?:--?[\w-]+(?:[= ][^\s-]\S*)?\s+)*?(\d+)\b/);
  if (!prMatch) {
    block(
      `BLOCKED: 'gh pr merge' without an explicit PR number.\n\n` +
        `The merge gate looks up the recorded review verdict by PR number, so it must\n` +
        `be given one:  gh pr merge 42 --squash --delete-branch`,
    );
  }

  const pr = prMatch[1];
  const verdictFile = statePath(`review-${pr}.json`);
  const verdict = readJsonIfExists(verdictFile);

  if (!verdict) {
    block(
      `BLOCKED: no review verdict recorded for PR #${pr}.\n\n` +
        `Expected: .claude/state/review-${pr}.json\n\n` +
        `Run the pr-reviewer subagent on this PR first. If it returns PASS, the\n` +
        `feature-cycle skill writes the verdict file and this merge will be allowed.\n` +
        `Do not create the verdict file by hand — that defeats the gate.`,
    );
  }

  if (verdict.verdict !== 'PASS') {
    block(
      `BLOCKED: PR #${pr} has verdict '${verdict.verdict}', not PASS.\n\n` +
        (verdict.summary ? `Reviewer said: ${verdict.summary}\n\n` : '') +
        `Address the findings, push a fix, and re-run pr-reviewer.`,
    );
  }

  // Fail closed. If we cannot establish what is about to be merged, or the verdict
  // carries no SHA, we have no basis for trusting it — refuse rather than wave it
  // through. An unverifiable gate that allows is not a gate.
  const headSha = git(['rev-parse', 'HEAD']);

  if (!headSha) {
    block(
      `BLOCKED: cannot determine the current HEAD, so PR #${pr}'s verdict cannot be\n` +
        `validated against it.\n\n` +
        `The gate refuses to merge when it cannot verify what it is merging. Check that\n` +
        `this is a git repository with at least one commit and that 'git' is on PATH.`,
    );
  }

  if (!verdict.headSha) {
    block(
      `BLOCKED: the recorded verdict for PR #${pr} has no headSha.\n\n` +
        `A verdict without a commit cannot be checked for staleness. Re-run pr-reviewer\n` +
        `and record it with .claude/bin/record-verdict.mjs, which stamps the SHA itself.`,
    );
  }

  if (verdict.headSha !== headSha) {
    block(
      `BLOCKED: PR #${pr} moved since it was reviewed.\n\n` +
        `  reviewed: ${verdict.headSha}\n` +
        `  current:  ${headSha}\n\n` +
        `A verdict is only valid for the exact commit it was given on, otherwise a\n` +
        `passing review could be recycled to merge unreviewed code. Re-run pr-reviewer\n` +
        `on the current head.\n\n` +
        `(If you are on a different branch, check out the PR branch before merging —\n` +
        `the gate compares against local HEAD.)`,
    );
  }
}

allow();
