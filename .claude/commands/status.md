---
description: Show the state of the build — issues, PRs, branch, CI, services
---

Report the current state of the project. Gather in parallel where you can:

```
git rev-parse --abbrev-ref HEAD
git status --porcelain
gh issue list --state open --json number,title,labels,milestone --limit 100
gh pr list --state open --json number,title,headRefName,statusCheckRollup
docker compose -f infra/docker-compose.yml ps
```

Present:

1. **Progress** — issues closed vs total per epic, as a table, and the overall count against the 54
   features in SPEC.md.
2. **In flight** — open PRs with their CI state and whether a review verdict is recorded in
   `.claude/state/`.
3. **Next up** — the next unblocked issue, and anything blocked with what is blocking it.
4. **Working tree** — branch, uncommitted changes.
5. **Services** — which docker services are up.

If `gh` is not authenticated, say so plainly and note that issue and PR state is unavailable rather
than reporting zeroes as if they were real.

Keep it scannable. This is a status check, not a report.
