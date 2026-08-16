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

Every acceptance criterion has a test that would fail if the behaviour regressed, **CI is green on
the head SHA**, contracts live in `@repo/contracts`, migrations replay from empty, and `pr-reviewer`
returned `PASS`.

CI is the authoritative gate, not a local run. Push and let it report rather than running
`pnpm verify` locally first — the local run needs Docker, takes minutes, and CI re-runs all of it
anyway on the exact commit that will merge. Run it locally when you want a faster loop on a specific
failure, not as a ceremony before every push.

## The pull request

Body must contain:

- `Closes #<n>`
- The acceptance criteria as a checklist, each ticked, each naming the test that covers it
- What was actually verified, and anything that could not be
- Any spec amendment made in this PR, and why

Never write "all tests pass" without having run them in this session. If a step was skipped, say
which and why.

## The review gate

**One reviewer by default.** `pr-reviewer` runs on the diff. The other two are exceptions, not
routine:

- `security-auditor` — only when the diff touches auth, checkout, payments, admin, or adds a route.

There is no separate contract auditor. `pr-reviewer` checks I2 and the Prisma conventions as part of
its invariant pass, which is where those findings actually came from in practice. Running a second
and third agent over an ordinary diff costs an hour and finds nothing the first one missed.

1. **Reviewers do not re-run the gate.** CI already ran it on this exact SHA — read
   `gh pr checks <n>` and report that. Rebuilding a database to repeat a green run is the single
   most expensive habit in this loop and adds no information. Spend that budget on mutation testing
   instead: break the implementation and confirm a named test goes red. That is the one check
   nothing else performs.
2. Verdicts are posted to the PR with `gh pr review --comment`.
3. `PASS` **and** green CI → record the verdict, then merge:

   ```
   node .claude/bin/record-verdict.mjs --pr <n> --verdict PASS --summary "..."
   gh pr merge <n> --squash --delete-branch
   ```

   The merge is blocked by a hook unless that verdict exists and matches the current head SHA. Do
   not try to work around it — if it blocks, the gate is telling you something true.

4. `FAIL` → fix, push, re-run the reviewer. **Two rounds maximum**, enforced by
   `record-verdict.mjs`, which refuses a third. After the second failure, stop and report to the
   human rather than grinding.
5. `BLOCKED` → stop and report immediately.

## What may block a merge

Only these:

- CI red on the head SHA.
- A `security-auditor` finding of HIGH or above.
- A test that cannot fail — a criterion whose covering test still passes when the implementation is
  broken.
- An invariant violation from SPEC.md §2.

**Everything else is advisory and gets filed as an issue, not fixed before merge** — missing
documentation, an undocumented environment variable, a naming preference, extra coverage a reviewer
would like, a deferral already tracked in SPEC.md. A reviewer that blocks on one of these is
misreading its brief. Advisory findings still go in the review comment so the record is complete.

## When something is wrong with the plan

If an issue's acceptance criteria are impossible, contradictory, or would produce a bad design, do
not quietly build something else. Say so on the issue, propose the change, amend SPEC.md in the PR,
and note the amendment in the PR body.
