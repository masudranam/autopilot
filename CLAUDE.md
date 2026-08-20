# Agentic Ecommerce

A modern ecommerce platform built entirely through an automated loop: GitHub issue → branch →
implement → verify → PR → subagent review → auto-merge on green.

[SPEC.md](SPEC.md) is the source of truth. [docs/architecture.md](docs/architecture.md) explains how
the system fits together. Amend the spec in the same PR whenever reality diverges from it.

## Rules

These were seven files under `.claude/rules/`. Consolidated here because six of them loaded on every
session regardless of relevance. Where a line below reads like an oddly specific detail, it is one —
each is the scar of a bug that shipped.

### Workflow

- One issue, one branch, one PR. `feat/<n>-<slug>`, `fix/<n>-<slug>`, `chore/<slug>`, branched from
  fresh `main`. Never stack on an unmerged branch; finish the dependency first.
- Conventional Commits. The subject says what changed, not what you did.
- PR body carries `Closes #<n>`, the acceptance criteria as a ticked checklist each naming its
  covering test, what was verified, what could not be, and any SPEC amendment made.
- **CI is the gate, not a local run.** Push and read `gh pr checks`; do not run `pnpm verify`
  locally as ceremony. Before trusting CI, confirm it ran on _this_ commit — `git rev-parse HEAD`,
  `gh pr view --json headRefOid` and a non-zero check-run count must agree. A push can land without
  the PR head syncing, and a reviewer was once handed green checks belonging to the parent commit.
- **One reviewer by default** (`pr-reviewer`). Add `security-auditor` only for auth, checkout,
  payments, admin or a new route. Reviewers read CI rather than re-running the gate, and spend the
  budget on mutation testing — breaking the implementation to confirm a named test goes red.
- **Only four things may block a merge:** red CI, a test that cannot fail, a SPEC.md §2 invariant
  violation, a HIGH security finding. Everything else is advisory and becomes an issue.
- **Two review rounds maximum**, enforced by `record-verdict.mjs`. After the second failure, stop
  and report rather than grinding.
- If an issue's criteria are impossible or would produce a bad design, say so on the issue, propose
  the change, amend SPEC.md in the PR. Do not quietly build something else.

### Backend — NestJS

- Module layout: `<domain>.module.ts`, `.controller.ts` (HTTP only), `.service.ts` (the rules),
  `.repository.ts` (all Prisma), `dto/`, plus `.service.spec.ts` and `.controller.e2e-spec.ts`.
- A module may import **only another module's exported service** — never its repository, its tables
  or its internal types (ADR-0001).
- One global `ZodValidationPipe`; every input parsed by a `@repo/contracts` schema. Never a
  `class-validator` DTO — that is a second declaration of a shape (I2).
- Throw domain errors and let the global filter render them. Never build an HTTP body in a service,
  never `throw new HttpException` with an ad-hoc shape (I3).
- Every route carries an explicit authorisation decorator — `@Public()`, `@Authenticated()` or
  `@Roles()`. The guard is global, so an undecorated route is denied (I5).
- **Ownership belongs in the query, not after it.** Scope by owner in the `where` and return 404 on
  a miss. Never fetch-then-compare, never 403 — that confirms the row exists (I4).
- Money is `amountMinor: number` + `currency: string`. No floats, no `toFixed`, no `Decimal` across
  a boundary (I1, ADR-0003; lint blocks the two common mistakes).
- One `prisma.$transaction` for anything that must succeed or fail together. No network calls inside
  a transaction — capture first, then open it.
- Slow or retryable work is a BullMQ job, and jobs must be idempotent: a retry must not send a
  second email or refund twice.
- All env access goes through the validated config service. `process.env` is read nowhere else.

### Contracts

`packages/contracts` is the only place an API shape is declared (ADR-0002).

- Schema first, then the endpoint, then the UI. `z.infer` is the only way a contract type exists.
- **Enums come from Prisma.** `enums.generated.ts` is produced by `pnpm gen:enums`; `check:repo`
  fails on drift. Never hand-write a union mirroring a database enum.
- Money uses the shared `moneySchema`; pagination uses `paginatedSchema(itemSchema)`; errors use
  `problemDetailsSchema` (I3). Do not redeclare any of them.
- Served under `/api/v1`. A breaking change is a new field plus a deprecation, not a silent change
  of meaning. Removing a field is breaking even if nothing here reads it.
- A `*Response` / `*Dto` / `*Request` type declared in `apps/*` is blocked by `guard-write`.

### Prisma & data

- `pnpm --filter @repo/api exec prisma migrate dev --name <descriptive>`. Never edit an applied
  migration, never `db push`. Additive first — stop writing a column, ship, drop it later.
- `id String @id @default(uuid(7))`; `createdAt`/`updatedAt` everywhere; money as `Int` minor units
  plus a currency `String`; every FK and every list-endpoint `where` column indexed; `onDelete`
  explicit on every relation.
- **snake_case in the database, camelCase in code, every mapping explicit.** Every model
  `@@map("plural_snake")`, every camelCase column `@map("snake_case")`, every enum
  `@@map("snake_case")`. Enforced by `schema-invariants.spec.ts` — adding it later is a full-schema
  rename.
- N+1 is a bug. Use `select`/`include`, and add a query-count test on list endpoints.
- Cursor pagination on list endpoints, keyed on an indexed, unique, ordered column.
- Concurrency-sensitive updates use a `version` column and a conditional update, retrying on zero
  rows affected. This is what prevents overselling.
- `prisma/seed.ts` must be idempotent (I8) — `upsert` on stable natural keys, never bare `create`.
  It must also produce a catalogue you can actually browse (F3/AC4).
- Integration tests run against real Postgres. Mocking Prisma to test a repository proves nothing.

### Testing

The gate is the only thing between a change and an automatic merge, so **a test that cannot fail is
worse than no test at all.**

- **One test per acceptance criterion**, and it must fail if the behaviour regresses. Not
  negotiable.
- Cross-account probes only where a feature adds an owned resource, on the verbs it adds, asserting
  404 and not 403 (I4).
- A query-count test on new **list** endpoints. Detail and write endpoints do not need one.
- A genuinely parallel test where a race would corrupt state or money — fire with `Promise.all`. A
  sequential loop passes with the race present, which is worse than useless.
- The failure paths an acceptance criterion names. Blanket error-branch coverage is not required.
- Anything beyond this list is welcome and is **never** a reason to block a merge.
- **These do not count and fail the gate:** asserting only that a call did not throw; mocking the
  exact thing the criterion is about; a snapshot standing in for a behavioural assertion; a
  concurrency test that is a `for` loop; a test with no assertion.
- Never on `main`: `.skip`, `.only`, `xit`, `xdescribe`, or a commented-out test (I9). CI greps.
- No dependence on wall-clock time, timezone or randomness. A flake in an unattended loop causes a
  false merge or a false stop, and both are expensive.

### Security

- Argon2id for passwords — never MD5, SHA-family, or low-cost bcrypt.
- Access tokens 15 min and stateless; refresh tokens long-lived, rotating, stored **hashed**,
  revocable. Presenting an already-rotated token is theft, not a retry: revoke the whole family.
- Login failures are generic and constant-time — every path pays for one verify, including an
  unknown address. Skipping it is a free account-enumeration oracle.
- Revoking a session does **not** invalidate an access token already issued; it expires with its
  TTL. Do not write down otherwise (ADR-0010).
- Everything parsed by Zod at the edge (I2). Raw SQL only via tagged-template `$queryRaw`.
- Uploads: validate real content type, cap size, never trust the client filename.
- Never read a `.env` to answer a question — ask. Never put a real secret in code, a commit, a log,
  a fixture or a PR comment. Errors must not leak stack traces, SQL or paths in production.
- Payments: never store a card number, only provider tokens. Verify webhooks against the **raw**
  body — parsing before verifying makes verification meaningless. Idempotent by provider event id
  (I6). Re-derive amounts server-side at capture; a client total is a suggestion.
- CSP, HSTS, `nosniff`, `Referrer-Policy` on both frontends. CORS is an explicit allowlist, never
  `*` with credentials. Refresh cookie is `httpOnly`, `secure`, `sameSite=strict`.
- Per-IP and per-account rate limits on auth, checkout, search and password reset; 429 carries
  `Retry-After`.
- `security-auditor`'s HIGH and above are blocking; MEDIUM and below are advisory.

### Frontend — Next.js (applies from E2)

- Server Components by default. `'use client'` only for state, effects, refs or browser APIs, pushed
  as far down the tree as possible. Data fetching happens on the server; the browser holds no token.
- Every data-driven view handles **loading, empty, error and populated**. Every data route ships
  `loading.tsx` and `error.tsx`. "It renders the happy path" fails review.
- Types come from `@repo/contracts`; declaring an API shape locally is blocked (I2).
- Tailwind + shadcn/ui, composed from `packages/ui`. Do not fork a component to change a padding
  value. Tokens live in the Tailwind config, not as hex literals.
- **WCAG AA is an acceptance criterion, and `jsx-a11y` runs as errors.** Semantic elements — a `div`
  with `onClick` is a bug. Keyboard-operable with a visible focus ring. Labels tied to inputs,
  errors via `aria-describedby`. One `h1`, no skipped levels. Meaningful `alt`, or `alt=""` when
  decorative.
- `next/image` with explicit dimensions. ISR for catalogue pages with on-demand revalidation. No
  client-side waterfalls. Lighthouse performance ≥ 90, a11y ≥ 95 on PDP and PLP (F52, F53).
- Server Actions validated with the same contract the API uses; show the API's per-field `errors[]`
  rather than one generic message.

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

Runs check:repo → format:check → lint → typecheck → test → build. Every step must be green before a
PR is opened and again before it merges. Individual steps: `pnpm check:repo`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`.

`check:repo` is the cheap structural pass: every workspace package declares its gate scripts (a
package with none is skipped silently by Turbo), and every variable the compose stack reads is
documented in `.env.example`.

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
- **Never run the Nest app with `tsx`.** esbuild does not emit decorator metadata, so DI silently
  injects `undefined` — the server boots, routes map, and the first request crashes, while tests
  stay green because ts-jest uses real tsc. The api `dev` script uses `tsc-watch` for exactly this
  reason. `tsx` is fine for DI-free scripts (the seed).
- **`**/*.spec.ts` does not match `*.e2e-spec.ts`.** When adding a test suffix, update jest
  `testMatch` and `tsconfig.build.json` `exclude` together, or the e2e suite silently never runs.

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
