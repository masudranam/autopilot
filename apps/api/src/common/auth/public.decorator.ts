import { SetMetadata, type CustomDecorator } from '@nestjs/common';

/** Metadata key carrying "this route is intentionally unauthenticated". */
export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Marks a route as deliberately open (invariant I5).
 *
 * The invariant is that EVERY route carries an explicit authorisation decision, not
 * that every route requires a token. Registration, login and the infrastructure health
 * probes cannot demand credentials — but "no decorator" and "decided to be public"
 * must be distinguishable, otherwise a route added without thought is indistinguishable
 * from a route that was thought about.
 *
 * The guard that reads this metadata and denies everything without it arrives with RBAC
 * (F10/AC3), which is where "default closed" gets its test. Applying the marker now
 * means F10 is a guard plus a `@Roles()` decorator, not a sweep through every existing
 * controller — the sweep is where a route gets missed.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
