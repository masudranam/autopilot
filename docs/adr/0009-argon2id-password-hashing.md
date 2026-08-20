# ADR-0009 · Argon2id for password hashing, at m=19 MiB · t=2 · p=1

**Status:** Accepted · 2026-08-14

## Context

F7 stores customer passwords. The choice that has to be made explicit is not "hash them" but which
function, which parameters, and which binding — all three fail quietly if they are wrong.

**Function.** SPEC.md F7/AC1 and CLAUDE.md §Security both name Argon2id specifically, and the "id"
matters. Argon2**d** accesses memory in a password-dependent order, which resists GPU cracking well
but leaks through cache side channels on shared hardware. Argon2**i** is the reverse: side-channel
resistant, weaker against time–memory tradeoffs. Argon2**id** runs the first half-pass as Argon2i
and the rest as Argon2d, and is the variant RFC 9106 and OWASP recommend for password storage.
Nothing in the encoded output makes the difference obvious to a reader, so a wrong constant
downgrades every password in the database silently.

**Parameters.** Argon2id's cost is three numbers, and getting them wrong in either direction is
expensive: too low and offline cracking is cheap, too high and the login endpoint becomes its own
denial-of-service amplifier — an unauthenticated request that makes the server allocate hundreds of
megabytes is a gift to an attacker with a script.

**Binding.** The widely used `argon2` npm package compiles through node-gyp. That means a C++
toolchain on every developer machine and in every CI image, a rebuild whenever the Node ABI changes,
and a class of "works locally, fails in the container" failures that has nothing to do with the
code.

## Decision

**Argon2id**, via **`@node-rs/argon2`** (Rust, NAPI-RS, prebuilt platform binaries), with the
parameters from OWASP's Password Storage Cheat Sheet first Argon2id profile:

| Parameter     | Value          | Why                                                                                                  |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `memoryCost`  | 19456 (19 MiB) | The memory hardness is what defeats GPU and ASIC cracking. 19 MiB is OWASP's floor for t=2.          |
| `timeCost`    | 2              | Two passes. With 19 MiB this lands at ~25–30 ms per hash on the development machine.                 |
| `parallelism` | 1              | One lane. Node hashes on the libuv threadpool; extra lanes multiply memory per call for little gain. |
| `outputLen`   | 32             | 256-bit digest, the RFC 9106 default.                                                                |
| version       | 0x13 (19)      | The library default and the only version worth writing today.                                        |

The parameters live in one exported constant, `ARGON2_PARAMETERS` in
`apps/api/src/modules/auth/password/password-hasher.ts`, and are not configurable through the
environment. They are a security property of the build, not a deployment knob — an operator able to
set `ARGON2_MEMORY=8` in a hurry is a way to weaken every password written afterwards, with no
review and no record.

Two implementation details are load-bearing enough to state here:

- The algorithm is passed as the literal `2`. `@node-rs/argon2` declares `Algorithm` as an ambient
  `const enum`, which this repo's `isolatedModules` forbids reading, and its runtime export is an
  empty object — `Algorithm.Argon2id` would evaluate to `undefined` and silently fall back to the
  library default. `password-hasher.spec.ts` asserts the encoded hash begins with `$argon2id$` and
  carries `m=19456,t=2,p=1`, so a wrong number fails a test rather than weakening a database.
- The salt is generated per call by the library and travels inside the PHC-encoded string along with
  the parameters. Nothing else is stored, and raising the cost later does not invalidate existing
  hashes — a verify can read the old parameters out of the hash it is checking.

## Consequences

**Good**

- No node-gyp: `pnpm install` on a fresh clone and in CI pulls a prebuilt binary. The lockfile
  carries every platform variant, including `linux-x64-gnu` for the CI runner.
- Memory-hard by construction. An attacker with the dumped table pays ~19 MiB per guess per lane,
  which is what makes GPU parallelism uneconomic in a way that bcrypt's 4 KiB does not.
- Cost is upgradable without a migration: bump the constant, and re-hash on next successful login
  when F8 lands.

**Bad**

- ~25–30 ms of CPU and 19 MiB of allocation per registration, and later per login. That is the
  point, but it makes the auth endpoints the natural target for resource exhaustion. Per-IP and
  per-account rate limiting on those routes (F51) is the mitigation, and until it lands the exposure
  is real — registration is the only unauthenticated endpoint that does memory-hard work.
- A native dependency, so an unsupported platform has no fallback. The supported set covers every
  platform this project targets.

**Rejected alternatives**

- **`argon2` (node-gyp)** — same algorithm, but a compiler on every machine and in every CI image,
  and rebuilds on Node upgrades. It buys nothing here.
- **bcrypt** — still respectable, but capped at 72 bytes of input and only mildly memory-hard, so it
  is a much easier GPU target. It is also not what the specification says.
- **scrypt from `node:crypto`** — zero dependencies and genuinely memory-hard, which makes it the
  strongest of the alternatives. Rejected because AC1 names Argon2id, and because getting scrypt's
  N/r/p and `maxmem` right is its own footgun (the default `maxmem` throws for sensible N).
- **Environment-tunable parameters** — rejected above: a security parameter that can be lowered
  without a code review is one that eventually is.

**Follow-ups**

- F8 adds verification and re-hashing on login when the stored parameters are below the current
  ones.
- F51 adds the rate limiting that keeps the cost from becoming a weapon.
- The seed's two accounts still carry unverifiable placeholder hashes; they get real ones when there
  is a login to use them with (F8).
