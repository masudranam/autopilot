---
name: feature-cycle
description: Runs one complete feature from GitHub issue to merged PR — pick, branch, implement,
  test, verify, PR, review, gate, merge. Use for "do the next feature", "/next", "work issue #23", or any request to advance the build.
---

# Feature cycle

One issue, start to merge. This is the loop the whole project runs on.

Never skip a step because the change looks small. The steps exist because each one has caught
something.

## 1 · Pick

```
gh issue list --state open --json number,title,labels,body --limit 100
```

Choose the lowest-numbered open issue whose `Depends on` issues are all closed. If nothing is
unblocked, say so and stop — do not start a blocked issue.

If the user named an issue, use that one, but check its dependencies and warn if they are open.

## 2 · Claim

```
gh issue edit <n> --add-label "status:in-progress"
```

Read the issue and its `F*` section in SPEC.md §7. Post a short comment on the issue saying what you
are about to build. If an acceptance criterion is impossible or contradictory, say so on the issue
now, before writing code.

## 3 · Branch

```
git checkout main
git pull --ff-only
git checkout -b feat/<n>-<slug>
```

Always branch from fresh `main`. Committing on `main` is blocked by a hook.

## 4 · Implement

Delegate to the right specialist — `api-engineer` for backend work, `web-engineer` for user-facing
work, both (in sequence, API first) for a full-stack feature. Give the subagent the issue number,
the verbatim acceptance criteria, and the rules files that apply.

Contracts and migrations come before implementation. See `.claude/rules/20-contracts.md`.

## 5 · Test

Run `test-engineer` over the result. It covers every AC, adds the tests that are always missing
(cross-account probes on every verb, query-count tests, genuinely parallel concurrency tests), and
hunts tests that cannot fail.

## 6 · Verify

```
pnpm verify
node .claude/bin/mark-verified.mjs pass
```

Green before a PR exists. If it is red, fix it — do not open a PR and hope CI sorts it out. Record
`fail` if it failed; do not record `pass` on a red gate.

## 7 · Pull request

```
git push -u origin feat/<n>-<slug>
gh pr create --fill --title "..." --body "..."
```

The body must contain `Closes #<n>`, the acceptance criteria as a ticked checklist each naming its
covering test, what was actually verified, anything that could not be, and any SPEC.md amendment
made.

## 8 · Review

Run `pr-reviewer` on the PR. Additionally:

- `security-auditor` if the diff touches auth, checkout, payments, admin or any route definition.
- `contract-auditor` if it touches `schema.prisma`, `packages/contracts` or an app's data layer.

Post each verdict to the PR:

```
gh pr review <n> --comment --body "<the verdict report>"
```

## 9 · The gate

Check CI as well as the reviewer — both must be green:

```
gh pr checks <n>
```

**On `PASS` and green CI**, from the feature branch:

```
node .claude/bin/record-verdict.mjs --pr <n> --verdict PASS --summary "<one line>"
gh pr merge <n> --squash --delete-branch
```

The merge is blocked unless that verdict exists and matches the current head SHA. If the hook blocks
you, it is telling you something true — do not try to route around it.

**On `FAIL`**: fix, push, re-run the reviewer. The verdict is invalidated by the new commit, so it
must run again. **Two rounds maximum** — after a second failure, stop and report to the human with
the reviewer's findings.

**On `BLOCKED`**: stop and report immediately. Do not merge.

## 10 · Advance

```
git checkout main
git pull --ff-only
```

Update the SPEC.md §10 progress table. Then report: what merged, what the reviewer said, and what
the next unblocked issue is.

## Reporting honestly

If the gate failed, say so with the real output. If a step was skipped, say which and why. If
something could not be verified — Docker down, a missing dependency — report it as _not verified_,
never as passing. The whole point of an automated loop is that its reports can be trusted without
re-checking every one.
