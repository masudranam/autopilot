---
description: Sync the GitHub board from SPEC.md — labels, milestones, issues
argument-hint: '[epic number — optional, defaults to all]'
---

Run the `github-sync` skill to bring the GitHub board in line with SPEC.md §7.

Scope: $ARGUMENTS (all epics if empty)

This is idempotent — it updates existing issues rather than duplicating them. Check for an existing
issue before creating one.

Copy acceptance criteria **verbatim** from the spec. They are the contract `pr-reviewer` checks
against, so a paraphrased AC is an unenforceable one. If you believe an AC is wrong, report it and
propose an amendment rather than quietly rewriting it.

If an issue is already `status:in-progress` and its criteria changed, comment on it rather than
silently editing the body.

Report a table of `feature → issue → action taken`, and anything that could not be synced.
