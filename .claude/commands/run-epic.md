---
description: Run the feature cycle back to back over every open issue in an epic
argument-hint: '<epic number, e.g. 2 or E2>'
---

Run the `feature-cycle` skill repeatedly over every open issue in epic $ARGUMENTS, in dependency
order, until the epic is complete or something stops you.

```
gh issue list --state open --label "epic:E$ARGUMENTS" --json number,title,body --limit 50
```

For each issue, run the full cycle. Between features, return to a clean `main` and pull.

**Stop and report to the human — do not continue to the next issue — if:**

- a `pr-reviewer` verdict is `FAIL` twice on the same PR
- any verdict is `BLOCKED`
- CI is red for a reason you cannot fix in one attempt
- an acceptance criterion turns out to be impossible or contradictory
- the merge gate blocks you for a reason you do not understand

Do not work around a blocked merge. The gate blocking is information.

At the end, report: which issues merged, which did not and why, any spec amendments made, and the
state of the epic.
