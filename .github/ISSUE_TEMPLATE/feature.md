---
name: Feature
about: A feature from SPEC.md §7
title: 'F<n> · <name>'
labels: ''
---

Implements **F\<n\>** from [SPEC.md](../blob/main/SPEC.md) §7.

## Acceptance criteria

<!-- Verbatim from the spec. These are the contract pr-reviewer checks against —
     do not paraphrase or summarise them. -->

- [ ] **AC1** —
- [ ] **AC2** —

## Depends on

<!-- Real issue numbers, not F-ids. The loop cannot resolve "depends on F8". -->

- #

## Definition of done

SPEC.md §9 applies in full: a test per AC that would fail on regression, `pnpm verify` green,
contracts in `@repo/contracts`, migrations replay from empty, cross-account probes on every verb,
and a `PASS` from `pr-reviewer`.
