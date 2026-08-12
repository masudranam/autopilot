# ADR-0006 · Pin pnpm 10.18.0

**Status:** Accepted · 2026-08-12

## Context

The development machine runs Node 20.20.0 (via nvm4w), which bundles Corepack 0.34.1.

Corepack 0.34.1 cannot execute pnpm 11.x. It loads the package manager's entry point through a `vm`
based CommonJS loader that has no dynamic-import callback registered, and pnpm 11's bin uses a
dynamic import:

```
TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]: A dynamic import callback was not specified.
    at Object.<anonymous> (…/corepack/v1/pnpm/11.21.0/bin/pnpm.cjs:3:1)
```

The error names Node internals and gives no hint that the pnpm version is the cause, so this is
worth recording rather than rediscovering.

pnpm 10.18.0, 10.4.1 and 9.15.9 were each verified to run correctly under the same Corepack.

## Decision

Pin `"packageManager": "pnpm@10.18.0"` in the root `package.json`.

`corepack enable pnpm` has been run, so a `pnpm` shim exists on `PATH`. Inside this repository the
shim resolves to the pinned version. Outside any project it resolves to `latest` and still crashes —
that is a machine-level quirk, not something this repo can fix.

## Consequences

**Good**

- `pnpm` works for every command in this repo with no per-command `corepack` prefix.
- The version is pinned in the lockfile-adjacent metadata, so CI and local agree.

**Bad**

- Pinned below the current major, so pnpm 11 features are unavailable.
- A contributor on a machine with a newer Corepack gets 10.18.0 anyway — consistent, but not obvious
  without reading this.

**Resolution path**

`npm i -g corepack@latest` replaces the bundled Corepack and unblocks pnpm 11. Not done here because
a global toolchain change to satisfy one project is a poor trade, and 10.18.0 has everything needed.
