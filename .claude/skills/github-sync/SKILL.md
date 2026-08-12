---
name: github-sync
description:
  Creates or updates the GitHub board from SPEC.md — labels, milestones and one issue per feature,
  idempotently. Use when bootstrapping the repo or after amending SPEC.md §7.
---

# GitHub sync

Turns [SPEC.md](../../../SPEC.md) §7 into the board the loop consumes. Safe to re-run: it updates
rather than duplicates.

Requires `gh auth login` to have been run. Check first:

```
gh api user --jq .login
```

If that fails, stop and ask the user to authenticate — everything here depends on it.

## 1 · Labels

```
gh label create "epic:E0" --color 1D76DB --description "Foundation" --force
```

`--force` makes it idempotent. Create:

- `epic:E0` … `epic:E9` — one per epic in SPEC.md §8
- `area:api`, `area:storefront`, `area:admin`, `area:infra`, `area:contracts`
- `size:s`, `size:m`, `size:l`
- `status:in-progress`, `status:blocked`, `status:needs-review`

## 2 · Milestones

One per epic, titled as in SPEC.md §8 (`E1 · Identity & accounts`). Milestones need the REST API:

```
gh api repos/{owner}/{repo}/milestones --method POST -f title="E0 · Foundation" -f description="F1–F6"
```

Check for an existing milestone of the same title first — the API will happily create a duplicate.

## 3 · Issues

Delegate to the `issue-planner` subagent. It reads SPEC.md §7, copies acceptance criteria verbatim,
and creates issues in dependency order so that `Depends on` can reference real issue numbers.

Do not paraphrase acceptance criteria when creating issues. They are the contract `pr-reviewer`
checks against, and a summarised AC is an unenforceable one.

## 4 · Verify the board

```
gh issue list --state open --limit 100 --json number,title,milestone,labels
```

Confirm: 54 issues, every one with an epic label and a milestone, and every `Depends on` pointing at
a real issue number rather than an `F*` id.

## Re-running after a spec change

1. Diff SPEC.md §7 against the existing issues.
2. New feature → new issue. Changed AC → update that issue's body. Removed feature → close its issue
   with a comment explaining why.
3. Never silently rewrite an AC on an issue that is already in progress — comment on it so the
   change is visible to whoever is building it.

## Report

A table of `feature → issue → action`, plus anything that could not be synced and why.
