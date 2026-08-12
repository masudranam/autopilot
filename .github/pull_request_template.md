Closes #

## What this does

<!-- One paragraph. What changed and why, not a list of files. -->

## Acceptance criteria

<!-- Copy every AC from the issue. Tick only what is genuinely done, and name the test
     that covers it. An AC without a covering test is not done. -->

- [ ] **AC1** — … · covered by `path/to/file.spec.ts › test name`
- [ ] **AC2** — … · covered by `…`

## Verified

<!-- What you actually ran in this session. Not what you expect to pass. -->

- [ ] `pnpm format:check`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:e2e` (user-facing changes)

**Not verified:** <!-- anything you could not run, and why. "Nothing" is a valid answer.
                      Never leave this blank to imply everything passed. -->

## Invariants

Tick the ones this diff touches (SPEC.md §2):

- [ ] I1 money is integer minor units
- [ ] I2 contracts live in `@repo/contracts`
- [ ] I3 errors are RFC 9457 Problem Details
- [ ] I4 cross-account access returns 404, probed on every verb
- [ ] I5 every route has explicit authorisation
- [ ] I6 money-moving endpoints are idempotent
- [ ] I7/I8 migrations replay from empty, seed is idempotent

## Spec changes

<!-- Any amendment made to SPEC.md in this PR, and why reality diverged from it. -->
