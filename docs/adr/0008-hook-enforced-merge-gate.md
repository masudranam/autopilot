# ADR-0008 · The merge gate is a hook, not a GitHub approval

**Status:** Accepted · 2026-08-12

## Context

The requirement is that a review subagent approves each pull request before it merges, with the
whole cycle automated.

GitHub does not permit the author of a pull request to approve it. Every PR here is authored by the
same identity that would review it, so `gh pr review --approve` returns _"Can not approve your own
pull request."_ A branch-protection rule requiring one approval would therefore deadlock every PR in
the repository permanently.

Three options were considered:

1. **A second identity** — a bot PAT or GitHub App producing genuine approvals. Correct, but
   requires credential setup the user has not asked for and would have to maintain.
2. **Prompt-level discipline** — instruct the loop to review before merging. Free, and worthless: a
   48-PR unattended run is exactly the situation where an instruction gets forgotten, and nothing
   would detect it.
3. **Enforce it in the harness** — make merging without a recorded review mechanically impossible.

## Decision

Option 3. The `pr-reviewer` verdict is written to `.claude/state/review-<pr>.json`, keyed to the
pull request's head SHA. A `PreToolUse` hook (`.claude/hooks/guard-git.mjs`) intercepts every Bash
and PowerShell call and **blocks `gh pr merge` unless a `PASS` verdict exists for the current head
SHA**.

Keying on the head SHA matters: it means a verdict cannot be recycled. Pushing a fix commit
invalidates the previous review, so the reviewer must run again on the code that will actually
merge.

The verdict itself is posted to the PR with `gh pr review --comment`, so the reasoning is visible in
the timeline even though it cannot be an approval.

Branch protection still requires a pull request and green status checks on `main`. Required
approvals stay off, for the deadlock reason above.

## Consequences

**Good**

- The gate cannot be bypassed by an agent that loses track of its instructions — the tool call
  fails.
- Stale reviews cannot be reused, because the SHA changes.
- No credentials to provision or rotate.

**Bad**

- The PR shows a review _comment_, not a green approved check. A reader unfamiliar with this setup
  might read the PR as unreviewed.
- The enforcement is local to this working copy. Someone merging from the GitHub web UI, or from
  another machine, is not covered by it.
- `.claude/state/` is gitignored, so verdict history is per-checkout rather than shared.

**Upgrade path**

Adding a bot identity later turns the comment into a real approval and lets branch protection
require it, closing the web-UI gap. Nothing else in the design changes.
