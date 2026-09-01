# Agentic Ecommerce

An ecommerce platform built through an automated loop: issue → branch → implement → verify → PR →
review → auto-merge on green. [SPEC.md](SPEC.md) is the source of truth and
[docs/architecture.md](docs/architecture.md) explains how it fits together; amend the spec in the
same PR whenever reality diverges. Everything below was seven files under `.claude/rules/`. Where a
line reads oddly specific, it is the scar of a bug that shipped.

## The three rules that override everything

1. **Never commit to `main`.** Every change arrives through a reviewed PR. A `PreToolUse` hook
   blocks it, so an attempt fails loudly rather than silently succeeding.
2. **Never merge without a `PASS`.** `gh pr merge` is blocked unless `pr-reviewer` recorded one for
   the current head SHA. Pushing a fix invalidates the previous verdict.
3. **Never soften a failing result.** A red test, a `BLOCKED` verdict or an unverifiable step is
   reported as exactly that. "Probably fine" is not a status.

## Workflow

One issue, one branch, one PR — `feat/<n>-<slug>`, `fix/<n>-<slug>`, `chore/<slug>`, off fresh
`main`. Never stack on an unmerged branch. Conventional Commits; the subject says what changed, not
what you did. The PR body carries `Closes #<n>`, the ACs as a ticked checklist each naming its
covering test, what was verified, what could not be, and any SPEC amendment.

**CI is the gate, not a local run.** Push and read `gh pr checks`; do not run `pnpm verify` as
ceremony. First prove CI ran on _this_ commit — `git rev-parse HEAD`, `gh pr view --json headRefOid`
and a non-zero check-run count must agree. A push can land without the PR head syncing, and that has
handed a reviewer green checks belonging to the parent commit.

**One reviewer by default** (`pr-reviewer`); add `security-auditor` only for auth, checkout,
payments, admin or a new route. Reviewers read CI rather than re-running it and spend the budget on
mutation testing — breaking the implementation to confirm a named test goes red. **Only four things
block a merge:** red CI on the head SHA, a test that cannot fail, a SPEC.md §2 violation, a HIGH+
security finding. Everything else is advisory and becomes an issue. **Two rounds maximum**, enforced
by `record-verdict.mjs`. If an issue's criteria are impossible or would produce a bad design, say so
on the issue and amend SPEC.md rather than quietly building something else.

## Backend — NestJS

`<domain>.module.ts`, `.controller.ts` (HTTP only), `.service.ts` (the rules), `.repository.ts` (all
Prisma), `dto/`, plus `.service.spec.ts` and `.controller.e2e-spec.ts`. A module imports **only
another module's exported service** — never its repository, tables or internal types (ADR-0001).

- One global `ZodValidationPipe`; every input parsed by a `@repo/contracts` schema. Never a
  `class-validator` DTO — that is a second declaration of a shape (I2).
- Throw domain errors and let the global filter render them. Never build an HTTP body in a service
  or `throw new HttpException` with an ad-hoc shape (I3).
- Every route carries `@Public()`, `@Authenticated()` or `@Roles()`. The guard is global, so an
  undecorated route is denied (I5).
- **Ownership belongs in the query.** Scope by owner in the `where`, 404 on a miss. Never
  fetch-then-compare, never 403 — that confirms the row exists (I4).
- Money is `amountMinor: number` + `currency: string`. No floats, no `toFixed`, no `Decimal` across
  a boundary (I1, ADR-0003; lint blocks the two common mistakes).
- One `prisma.$transaction` for anything atomic, with no network call inside it — capture first.
  Slow or retryable work is a BullMQ job, and jobs must be idempotent.
- Env access goes through the validated config service; `process.env` is read nowhere else.

## Contracts

`packages/contracts` is the only place an API shape is declared (ADR-0002) — schema first, endpoint
second, UI third, and `z.infer` is the only way a contract type exists.

- Enums come from `enums.generated.ts` via `pnpm gen:enums`; `check:repo` fails on drift. Never
  hand-write a union mirroring a database enum.
- Request schemas are `z.strictObject`, so an unknown key is a 422 rather than a silent strip. Zod
  drops unknown keys by default — harmless until someone spreads the parsed body into an insert, at
  which point `{"role":"ADMIN"}` quietly grants admin.
- Use `moneySchema`, `paginatedSchema(item)` and `problemDetailsSchema` (I3); redeclare none of
  them.
- Under `/api/v1` a breaking change adds a field and deprecates the old one. Removing one is
  breaking even if nothing here reads it. A `*Response`/`*Dto`/`*Request` type in `apps/*` is
  blocked by `guard-write`.

## Prisma & data

- `pnpm --filter @repo/api exec prisma migrate dev --name <descriptive>`. Never edit an applied
  migration, never `db push`. Additive first — stop writing a column, ship, drop it later.
- `id String @id @default(uuid(7))`; `createdAt`/`updatedAt` everywhere; money as `Int` minor units
  plus a currency; every FK and every list-endpoint `where` column indexed; `onDelete` explicit.
- **snake_case in the database, camelCase in code, every mapping explicit** —
  `@@map("plural_snake")` on every model, `@map("snake_case")` on every camelCase column, `@@map` on
  every enum. Enforced by `schema-invariants.spec.ts`; adding it later is a full-schema rename.
- N+1 is a bug: use `select`/`include` and a query-count test on list endpoints. Cursor pagination
  keyed on an indexed, unique, ordered column.
- Concurrency-sensitive updates use a `version` column and a conditional update, retrying on zero
  rows. A constraint the database enforces beats a check the service performs — and note
  `migrate diff` cannot see a partial index, so its own test is its only guard.
- `prisma/seed.ts` is idempotent (I8) — `upsert` on natural keys, never bare `create` — and produces
  a catalogue you can browse (F3/AC4). Integration tests run against real Postgres; mocking Prisma
  to test a repository proves nothing.

## Testing

The gate is the only thing between a change and an automatic merge, so **a test that cannot fail is
worse than no test at all.** Verify a mutation actually applied before concluding a check does not
bind, and never report a single run as a property.

- **One test per acceptance criterion**, failing if the behaviour regresses. Not negotiable.
- Cross-account probes where a feature adds an owned resource, on every verb it adds, asserting 404
  not 403 (I4).
- A query-count test on new **list** endpoints; detail and write endpoints do not need one.
- A genuinely parallel test where a race would corrupt state or money — `Promise.all`, never a loop.
  But a race is the wrong instrument for proving a constraint _exists_: assert that directly.
- The failure paths an AC names. Blanket error-branch coverage is not required, and anything beyond
  this list is **never** a reason to block a merge.
- **These fail the gate:** asserting only that a call did not throw; mocking the exact thing the
  criterion is about; a snapshot standing in for a behavioural assertion; a concurrency test that is
  a `for` loop; no assertion at all.
- Never on `main`: `.skip`, `.only`, `xit`, `xdescribe`, a commented-out test (I9). CI greps. No
  dependence on wall-clock time, timezone or randomness — a flake causes a false merge or a false
  stop, and both are expensive.

## Security

- Argon2id, never MD5/SHA/cheap bcrypt. Access tokens 15 min and stateless; refresh tokens
  long-lived, rotating, stored hashed, revocable, and reuse revokes the whole family.
- Login failures generic and **constant-time** — every path pays for one verify, including an
  unknown address. Skipping it is a free account-enumeration oracle.
- Revoking a session does **not** invalidate an issued access token; it dies with its TTL, and
  nothing shortens that (ADR-0010). Do not write down otherwise.
- Everything parsed by Zod at the edge (I2), including control characters — a NUL byte reaching the
  driver is an unhandled 500. Raw SQL only via tagged-template `$queryRaw`. Cap every string, and
  cap collections an account can grow.
- Never read a `.env` to answer a question; ask. No real secret in code, a commit, a log, a fixture
  or a PR comment. Errors leak no stack trace, SQL or path in production (F5/AC2).
- Payments: provider tokens only, never a card number. Verify webhooks against the **raw** body
  before parsing, idempotent by event id (I6), amounts re-derived server-side at capture.
- CSP, HSTS, `nosniff`, `Referrer-Policy`; CORS an allowlist, never `*` with credentials; refresh
  cookie `httpOnly secure sameSite=strict`; rate-limit auth, checkout, search and reset.

## Frontend — Next.js (from E2)

Server Components by default; `'use client'` only for state, effects, refs or browser APIs, pushed
as far down as possible — fetch on the server, the browser holds no token. Every data-driven view
handles **loading, empty, error and populated** and ships `loading.tsx` and `error.tsx`; "it renders
the happy path" fails review. Types from `@repo/contracts`; Tailwind and shadcn/ui composed from
`packages/ui`, never forked to change a padding value. **WCAG AA is an AC and `jsx-a11y` runs as
errors:** semantic elements (a `div` with `onClick` is a bug), keyboard-operable with a visible
focus ring, labels tied to inputs, errors via `aria-describedby`, one `h1`, meaningful `alt`.
`next/image` with explicit dimensions, ISR for catalogue pages, no client waterfalls, Lighthouse ≥
90 perf and ≥ 95 a11y on PDP and PLP (F52, F53). Server Actions validate with the API's own contract
and surface its per-field `errors[]`.

## Environment gotchas

- **Always pass `--reporter=append-only` to pnpm.** The default TUI reporter hangs forever on
  non-TTY stdout — no output, no error. `CI=1` has the same effect.
- **pnpm is pinned to 10.18.0**; the bundled Corepack cannot run pnpm 11 (ADR-0006).
- **PowerShell 5.1 has no `&&`, `||`, `?:` or `?.`** — use `;` or the Bash tool, and never redirect
  a native exe's stderr with `2>&1` there.
- **TypeScript stays on 5.9.3** (TS 7 breaks `typescript-eslint` and `ts-jest`, ADR-0007); **ESLint
  stays on 9.x** (`jsx-a11y` caps there).
- **Never run the Nest app with `tsx`.** esbuild emits no decorator metadata, so DI injects
  `undefined`: the server boots, routes map, the first request crashes, and tests stay green because
  ts-jest uses real tsc. `dev` uses `tsc-watch` for exactly this reason.
- **`*.spec.ts` globs do not match `*.e2e-spec.ts`.** Update jest `testMatch` and
  `tsconfig.build.json` `exclude` together, or the e2e suite silently never runs.
- **`sandbox.failIfUnavailable` must stay `false` here.** The sandbox is enabled, but the Windows
  sandbox is feature-gated off on this machine, so it degrades to a warning and commands run
  unsandboxed. Setting `failIfUnavailable: true` makes Claude Code _refuse to start_ — measured, not
  guessed. Flip it once `claude -p` stops printing the "Sandbox disabled" warning.

## Gate, ports and commands

`pnpm verify` runs check:repo → format:check → lint → typecheck → test → build, every step green
before a PR opens and again before it merges. `check:repo` is the cheap structural pass: every
workspace package declares its gate scripts (one with none is skipped silently by Turbo), every
compose variable is in `.env.example`, and the generated enums match the schema.

Ports are offset because 5432, 5433 and 4200 are taken here — storefront 3000, API 3001, admin 3002,
Postgres 5442, Redis 6389, Mailpit 1026/8026, MinIO 9010/9011.

```
pnpm install --reporter=append-only      # never a bare install from a tool call
pnpm infra:up                            # postgres, redis, mailpit, minio
pnpm db:migrate | db:seed | db:reset     # apply | seed idempotently | replay from empty
pnpm gen:enums                           # regenerate contract enums from schema.prisma
pnpm dev | pnpm verify                   # run everything | the gate
```
