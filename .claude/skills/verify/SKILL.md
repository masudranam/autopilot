---
name: verify
description:
  Runs the full quality gate — format, lint, typecheck, test, build, and optionally e2e — and
  reports the real result. Use before opening a PR, before merging, or when asked whether the tree
  is green.
---

# Verify

The gate. Every step must pass before a PR is opened and again before it merges.

## Run it

```
pnpm verify
```

That chains format:check → lint → typecheck → test → build. To see everything rather than stopping
at the first red, run them individually:

```
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Each as its own command — PowerShell 5.1 has no `&&`. Use the Bash tool if you want chaining.

For user-facing changes, also:

```
pnpm test:e2e
```

## Record the result

```
node .claude/bin/mark-verified.mjs pass    # or: fail
```

The Stop hook checks this. Recording `pass` on a red gate defeats the only automated check that the
tree was ever verified — do not do it.

## Fixing what it finds

- **format** — `pnpm format` rewrites in place.
- **lint** — `pnpm lint:fix` for the mechanical ones. A `no-restricted-properties` error on
  `toFixed` or `parseFloat` is the money invariant (I1); fix the arithmetic, do not disable the
  rule.
- **typecheck** — never silence with `any` or `@ts-expect-error`. `any` is a lint error precisely
  because it erases the contract guarantees the design depends on.
- **test** — read the failure before changing anything. A test failing because it is wrong and a
  test failing because the code is wrong look identical for the first thirty seconds.
- **build** — usually a server/client boundary problem in Next, or a missing export in a package.

## Integration tests need Docker

```
pnpm infra:up
```

If the daemon is down, integration tests do not run. That is **not verified** — it is not a pass.
Say so.

## Reporting

Show the real output of anything that failed, not a paraphrase. State plainly which steps ran, which
passed, and which could not run. "Verify is green" is only an acceptable summary when every step
actually ran and actually passed.
