# Agentic Ecommerce

A modern ecommerce platform built entirely through an automated loop: GitHub issue → branch →
implement → verify → PR → subagent review → auto-merge on green.

[SPEC.md](SPEC.md) is the source of truth. [docs/architecture.md](docs/architecture.md) explains how
the system fits together. Amend the spec in the same PR whenever reality diverges from it.

## Rules

@.claude/rules/00-workflow.md @.claude/rules/10-backend.md @.claude/rules/20-contracts.md
@.claude/rules/30-prisma.md @.claude/rules/40-frontend.md @.claude/rules/50-testing.md
@.claude/rules/60-security.md

## The three rules that override everything

1. **Never commit to `main`.** Every change arrives through a reviewed pull request. A `PreToolUse`
   hook blocks it, so an attempt fails loudly rather than silently succeeding.
2. **Never merge without a `PASS`.** `gh pr merge` is blocked unless `pr-reviewer` recorded a `PASS`
   for the pull request's current head SHA. Pushing a fix invalidates the previous verdict.
3. **Never soften a failing result.** A red test, a `BLOCKED` verdict or an unverifiable step gets
   reported as exactly that. "Probably fine" is not a status.

## Verify gate

```
pnpm verify
```

Runs format:check → lint → typecheck → test → build. Every step must be green before a PR is opened
and again before it merges. Individual steps: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm build`, `pnpm test:e2e`.

## Environment gotchas

These cost real time when forgotten:

- **Always run pnpm with `--reporter=append-only`.** pnpm's default TUI reporter hangs forever on a
  non-TTY stdout — no output, no error, the process just sits there. `CI=1` has the same effect.
- **pnpm is pinned to 10.18.0** (`packageManager` field). The Corepack bundled with Node 20.20
  cannot run pnpm 11 — see [ADR-0006](docs/adr/0006-pnpm-version-pin.md).
- **PowerShell 5.1 has no `&&`, `||`, `?:` or `?.`.** Use `;` or `if ($?) { … }`, or use the Bash
  tool instead. Do not redirect a native executable's stderr with `2>&1` in PowerShell — it reports
  failure on exit 0.
- **TypeScript stays on 5.9.3.** TS 7 breaks `typescript-eslint` and `ts-jest`
  ([ADR-0007](docs/adr/0007-typescript-5-not-7.md)). Do not "helpfully" upgrade it.
- **ESLint stays on 9.x.** `eslint-plugin-jsx-a11y` does not support ESLint 10.

## Ports

Offset from the defaults because 5432, 5433 and 4200 are already taken on this machine.

| Service    | Port |     | Service             | Port        |
| ---------- | ---- | --- | ------------------- | ----------- |
| Storefront | 3000 |     | PostgreSQL          | 5442        |
| API        | 3001 |     | Redis               | 6389        |
| Admin      | 3002 |     | Mailpit SMTP / UI   | 1026 / 8026 |
|            |      |     | MinIO API / console | 9010 / 9011 |

## Common commands

```
pnpm install --reporter=append-only   # never bare pnpm install from a tool call
pnpm infra:up                         # postgres, redis, mailpit, minio
pnpm db:migrate                       # apply migrations
pnpm db:seed                          # idempotent seed
pnpm db:reset                         # drop, migrate, seed from empty
pnpm dev                              # api + storefront + admin
pnpm verify                           # the gate
```

## Layout

```
apps/api            NestJS modular monolith — see .claude/rules/10-backend.md
apps/storefront     Next.js customer app
apps/admin          Next.js operator app
packages/contracts  Zod schemas — the ONLY place API shapes are declared
packages/ui         shared React components
packages/config     eslint · tsconfig · prettier bases
infra/              docker-compose
e2e/                Playwright
.claude/            this harness
```
