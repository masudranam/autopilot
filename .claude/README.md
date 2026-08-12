# The harness

Everything that makes this project build itself. Read
[docs/architecture.md](../docs/architecture.md) §5 for how the pieces fit together.

```
.claude/
  rules/        loaded into every session via CLAUDE.md
  agents/       subagents — pr-reviewer is the merge gate
  skills/       feature-cycle is the loop; the rest are called by it
  commands/     /next  /run-epic  /status  /plan-epics
  hooks/        enforcement — these run whether or not anyone remembers them
  bin/          small tools the hooks and skills call
  state/        runtime verdicts and markers (gitignored)
```

## The gate

`pr-reviewer` decides; `guard-git.mjs` enforces. A merge is impossible unless
`.claude/state/review-<pr>.json` holds a `PASS` stamped with the current head SHA.

This is deliberate. Prompt-level instructions are forgotten across a 54-PR unattended run; a
`PreToolUse` hook is not. See [ADR-0008](../docs/adr/0008-hook-enforced-merge-gate.md) for why the
gate is a hook rather than a GitHub approval.

## Changing a hook

Hooks are the only thing standing between a broken change and an automatic merge, so they have their
own adversarial test suite:

```
node .claude/hooks/__tests__/run-hook-tests.mjs
```

19 cases covering what must block (commits on a published `main`, force pushes, `.env` writes, API
types outside `packages/contracts`, merges with no/stale/failing verdicts, hand-forged verdict
files) and what must not (`--force-with-lease`, `--force` inside a commit message, ordinary pushes,
local view models, a `PASS` at the current head).

**Run it after any hook edit.** A gate that stops blocking is worse than no gate, because it still
looks like one.

## Deliberate design notes

- **Fail closed.** If `guard-git` cannot determine HEAD, or a verdict has no SHA, it refuses. An
  unverifiable gate that allows is not a gate.
- **Verdicts are SHA-keyed.** Pushing a fix invalidates the previous review, so the reviewer always
  runs against the code that will actually merge.
- **`main` locks on publish, not on first commit.** Before an `origin` remote exists there is no PR
  workflow to route through; the moment there is one, `main` is closed.
- **`.claude/state/` is gitignored.** Verdicts are per-checkout, not shared history.
