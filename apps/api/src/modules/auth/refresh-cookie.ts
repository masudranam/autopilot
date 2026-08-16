import type { CookieOptions, Response } from 'express';
import { REFRESH_COOKIE_NAME } from '@repo/contracts';
import type { Env } from '../../config/env';

/**
 * The Set-Cookie policy for the refresh token (F8/AC1).
 *
 * Every flag here is load-bearing:
 *
 * - `httpOnly` — script cannot read it, so an XSS on the storefront cannot exfiltrate a
 *   30-day credential. This is the single most valuable flag on this cookie.
 * - `secure` — never sent over plain HTTP. Set unconditionally rather than "in
 *   production": a flag that depends on an environment variable is a flag that is off
 *   on the machine where someone is testing over http on a shared network. Browsers
 *   treat http://localhost as a secure context, so local development still works.
 * - `sameSite: 'strict'` — the cookie is not attached to cross-site requests at all, so
 *   another origin cannot silently mint an access token in the user's name. Strict
 *   rather than lax because refresh is a POST that changes server state, and no
 *   legitimate flow arrives at it by top-level navigation from another site.
 * - `path` — scoped to the auth routes, so the cookie is not attached to every catalogue
 *   request for the rest of the session. Derived from `API_PREFIX` rather than
 *   hard-coded, because a prefix change would otherwise silently orphan the cookie: the
 *   browser would keep sending it to a path nothing listens on.
 *
 * There is no `domain`: omitting it scopes the cookie to the exact host that set it,
 * where setting it to a parent domain would share the refresh token with every
 * subdomain, including whatever gets deployed there next.
 */
export function refreshCookieOptions(env: Env, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: refreshCookiePath(env),
    maxAge: maxAgeMs,
  };
}

export function refreshCookiePath(env: Env): string {
  return `/${env.API_PREFIX}/auth`;
}

/**
 * Writes the refresh token cookie.
 *
 * `expiresAt` comes from the same value stored on the session row, so the cookie and
 * the database agree on when the token dies — a cookie that outlives its row produces a
 * silent 401 on a request the client believed was still valid.
 */
export function setRefreshCookie(
  response: Response,
  env: Env,
  token: string,
  expiresAt: Date,
  now: Date = new Date(),
): void {
  const maxAgeMs = Math.max(0, expiresAt.getTime() - now.getTime());
  response.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions(env, maxAgeMs));
}
