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
 * `JwtAuthGuard` reads this metadata and has been globally registered since F9/AC5, so
 * an undecorated route is denied rather than open. From F10 the guard resolves this
 * marker against `@Authenticated()` and `@Roles()` together: a handler-level decision
 * beats a class-level one, so a class-level `@Public()` cannot silently open a handler
 * that asked for a role (issue #86).
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
