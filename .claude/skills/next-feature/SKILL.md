---
name: next-feature
description:
  Scaffolds a Next.js route or feature the way this project does it — server components, the four
  states, forms, accessibility. Use when adding a page or feature to apps/storefront or apps/admin.
---

# Next feature

## Shape

```
app/(group)/<route>/
  page.tsx          Server Component — fetches and composes
  loading.tsx       skeleton, not a spinner
  error.tsx         'use client' — with a retry
  not-found.tsx     where a 404 is reachable
  _components/      route-local components
```

Shared components go in `packages/ui`, not duplicated into an app.

## Order

1. **Types** — import from `@repo/contracts`. If the shape is missing, add it there. Declaring it
   locally is blocked by a hook (I2).
2. **Server Component** — fetch on the server, in parallel. No client-side waterfall.
3. **The four states** — loading, empty, error, populated. All four designed. An empty state says
   what the user can do next; an error state offers a retry.
4. **Interactivity last** — `'use client'` only on the leaf that needs it, never on the page.
5. **Forms** — Server Actions validated with the same contract schema the API uses. Surface the
   API's per-field `errors[]`, not one generic message.
6. **Tests** — Playwright for the journey in the acceptance criteria.

## Accessibility — an acceptance criterion

`eslint-plugin-jsx-a11y` runs as errors. Beyond the linter:

- Semantic elements. A `div` with `onClick` is a bug — use a `button`.
- Everything interactive reachable by keyboard, with a visible focus ring.
- Inputs labelled; errors linked with `aria-describedby`.
- One `h1`, no skipped heading levels.
- `alt` on every image, `alt=""` when decorative.
- Test the journey with the keyboard, not just the mouse.

## Performance

- `next/image` with explicit dimensions — no layout shift.
- ISR on catalogue pages, revalidated on product change.
- No `'use client'` dragging a subtree into the bundle unnecessarily.

## Then

```
pnpm verify
pnpm test:e2e
```

Report the real result. Do not claim a Lighthouse score you did not measure.
