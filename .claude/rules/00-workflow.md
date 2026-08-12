# Workflow

How a feature gets from an issue to `main`. The `feature-cycle` skill automates this; these are the
rules it follows.

## One issue, one branch, one PR

```
feat/<issue-number>-<short-slug>      feat/23-product-variants
fix/<issue-number>-<short-slug>       fix/61-cart-merge-double-count
chore/<short-slug>                    chore/bump-prisma
```

Branch from a freshly pulled `main`. Never stack a feature on an unmerged branch — if issue B truly
needs issue A, finish A first. That is what the dependency ordering in SPEC.md §7 is for.

## Commits

Conventional Commits. The subject says what changed, not what you did.

```
feat(catalog): variant option matrix with unique SKUs
fix(cart): stop merge from doubling quantities on repeat login
test(checkout): parallel reservation race on last unit
```

Small and coherent beats one giant commit. `main` never receives a direct commit — a hook blocks it
and branch protection rejects it.

## Definition of done

A feature is done when all of SPEC.md §9 holds. In short: every acceptance criterion has a test that
would fail if the behaviour regressed, `pnpm verify` is green, contracts live in `@repo/contracts`,
migrations replay from empty, cross-account access is tested, and `pr-reviewer` returned `PASS`.

## The pull request

Body must contain:

- `Closes #<n>`
- The acceptance criteria as a checklist, each ticked, each naming the test that covers it
- What was actually verified, and anything that could not be
- Any spec amendment made in this PR, and why

Never write "all tests pass" without having run them in this session. If a step was skipped, say
which and why.

## The review gate

1. `pr-reviewer` runs on the diff. On auth, checkout, payments or admin changes, `security-auditor`
   runs too; on contract or schema changes, `contract-auditor`.
2. Verdicts are posted to the PR with `gh pr review --comment`.
3. `PASS` **and** green CI → record the verdict, then merge:

   ```
   node .claude/bin/record-verdict.mjs --pr <n> --verdict PASS --summary "..."
   gh pr merge <n> --squash --delete-branch
   ```

   The merge is blocked by a hook unless that verdict exists and matches the current head SHA. Do
   not try to work around it — if it blocks, the gate is telling you something true.

4. `FAIL` → fix, push, re-run the reviewer. **Two rounds maximum.** After the second failure, stop
   and report to the human rather than grinding.
5. `BLOCKED` → stop and report immediately.

## When something is wrong with the plan

If an issue's acceptance criteria are impossible, contradictory, or would produce a bad design, do
not quietly build something else. Say so on the issue, propose the change, amend SPEC.md in the PR,
and note the amendment in the PR body.
