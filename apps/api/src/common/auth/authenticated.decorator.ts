import { SetMetadata } from '@nestjs/common';

export const REQUIRES_AUTH_KEY = 'requiresAuth';

/**
 * Marks a route as deliberately requiring a valid access token (I5).
 *
 * With `JwtAuthGuard` registered globally the guard already denies an undecorated
 * route, so this decorator changes no runtime behaviour — it exists so the *decision*
 * is visible on the handler and can be asserted.
 *
 * Why that matters here specifically. The I5 sweep requires every registered route to
 * carry an explicit decision, and until F9 the only decision available was `@Public()`.
 * F9 adds the first routes that must NOT be public, so the cheapest way to make the
 * suite green would have been to mark a session list `@Public()` — shipping every
 * account's devices and IP addresses to anyone, while the test that exists to prevent
 * exactly that reported success. Both the F7 and F8 security audits predicted this and
 * named F9 as where it would land.
 *
 * So the sweep now accepts either marker and still rejects the absence of both: a new
 * route is a 401 by default from the guard, and a red test until someone states which
 * it is. Silence is not one of the answers.
 */
export const Authenticated = () => SetMetadata(REQUIRES_AUTH_KEY, true);
