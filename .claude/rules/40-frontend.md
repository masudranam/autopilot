# Frontend — Next.js 16

Two apps, same conventions: `apps/storefront` (customers) and `apps/admin` (operators).

## Server first

Components are Server Components unless they need interactivity. Add `'use client'` only when the
component uses state, effects, refs or browser APIs — and push it as far down the tree as possible.
A `'use client'` at the top of a page drags the whole subtree into the bundle.

Data fetching happens on the server. The browser does not hold an API token; the server does.

## Route structure

```
app/
  (shop)/
    products/[slug]/page.tsx      loading.tsx  error.tsx  not-found.tsx
    categories/[...path]/page.tsx
  cart/page.tsx
  checkout/…
  api/                            route handlers only where genuinely needed
```

Every route that fetches data ships `loading.tsx` and `error.tsx`. An unhandled error boundary or a
blank flash during navigation counts as an incomplete feature, not a polish item.

## The four states

Every data-driven view handles **loading, empty, error and populated**. Empty states say what the
user can do next; error states offer a retry. "It only renders the happy path" fails review.

## Types

Import from `@repo/contracts`. Never declare an API shape locally — a hook blocks it (I2).

## Styling

Tailwind + shadcn/ui. Compose the shared primitives in `packages/ui`; do not fork a component into
an app to change one padding value. Design tokens live in the Tailwind config, not as magic hex
values sprinkled through components.

## Accessibility — a gate criterion, not a nice-to-have

WCAG AA is an acceptance criterion on user-facing features, and `eslint-plugin-jsx-a11y` runs as
errors rather than warnings.

- Semantic elements. A `div` with an `onClick` is a bug — use a `button`.
- Every interactive element reachable and operable by keyboard, with a visible focus ring.
- Labels tied to inputs; errors associated via `aria-describedby`.
- One `h1` per page and no skipped heading levels.
- Images carry meaningful `alt`, or `alt=""` when decorative. The API requires alt text at write
  time so it cannot go missing later.

## Performance

- `next/image` for every image, with explicit dimensions to avoid layout shift.
- ISR for catalogue pages, with on-demand revalidation when a product changes.
- No client-side waterfall: fetch in parallel on the server, not sequentially in effects.
- Lighthouse performance ≥ 90 and a11y ≥ 95 on PDP and PLP (F52, F53).

## Forms

Server Actions with Zod validation against the same contract the API uses. Show field-level errors
from the API's `errors[]` array rather than a single generic message — the API already returns
per-field detail, so use it.
