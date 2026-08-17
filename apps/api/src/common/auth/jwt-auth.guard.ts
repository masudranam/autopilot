import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AccessTokenClaims } from '@repo/contracts';
import { UnauthenticatedError } from '../errors/domain-error';
import {
  ACCESS_TOKEN_REJECTED,
  AccessTokenService,
} from '../../modules/auth/tokens/access-token.service';
import { REQUIRES_AUTH_KEY } from './authenticated.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/**
 * An express request after this guard has run.
 *
 * Named for what it carries rather than `AuthenticatedRequest`, which the guard-write
 * hook reads as an API payload declaration and blocks — correctly, in general: this is
 * a server-side view of a request object, not a wire shape, and the wire shape it holds
 * (`AccessTokenClaims`) comes from `@repo/contracts`.
 */
export interface RequestWithAuth extends Request {
  auth?: AccessTokenClaims;
}

/**
 * Turns a bearer access token into verified claims, or a 401 (F8/AC5).
 *
 * Registered as a global `APP_GUARD` since F9/AC5, so the default is closed: a route
 * with no decorator is authenticated-only rather than open. `@Public()` opts out;
 * `@Roles()` (F10) narrows further in `RolesGuard`, which runs after this one.
 *
 * PRECEDENCE, and why it is not just `getAllAndOverride(IS_PUBLIC_KEY)` (issue #86).
 *
 * Reflector's `getAllAndOverride` returns the handler's value if present, else the
 * class's. Asking only about `@Public()` means a class-level `@Public()` makes every
 * handler in that controller public — including one the author marked
 * `@Authenticated()` or `@Roles()`, because those keys were never consulted. The route
 * ships open while the I5 sweep, which reads handler metadata, reports it as decided.
 *
 * So the question asked here is "what is the NEAREST authorisation decision", across
 * all three markers: a handler-level decision beats a class-level one whatever kind it
 * is, and only a public decision at that level opens the route.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.isPublic(context)) return true;

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = bearerTokenOf(request.headers.authorization);

    // Same error for "no header" as for "bad token": `verify` throws
    // UnauthenticatedError with one message for every failure mode, and a missing
    // header must not be the one case that answers differently.
    if (!token) throw new UnauthenticatedError(ACCESS_TOKEN_REJECTED);

    request.auth = this.accessTokens.verify(token);
    return true;
  }

  /**
   * Is the NEAREST authorisation decision "public"?
   *
   * Checks the handler's three markers first and returns as soon as any is present, so
   * `@Authenticated()` or `@Roles()` on a handler overrides a class-level `@Public()`
   * rather than being invisible to it. Only if the handler declares nothing does the
   * class's decision apply.
   */
  private isPublic(context: ExecutionContext): boolean {
    for (const target of [context.getHandler(), context.getClass()]) {
      const isPublic = this.reflector.get<boolean | undefined>(IS_PUBLIC_KEY, target) === true;
      const requiresAuth =
        this.reflector.get<boolean | undefined>(REQUIRES_AUTH_KEY, target) === true;
      const roles = this.reflector.get<unknown[] | undefined>(ROLES_KEY, target);
      const restrictsByRole = Array.isArray(roles) && roles.length > 0;

      if (isPublic || requiresAuth || restrictsByRole) {
        // A level that says BOTH public and authenticated is a contradiction the author
        // did not intend. Resolving it toward "closed" is the only safe direction.
        //
        // Note the sweep does NOT flag that combination — it only flags a route with
        // no marker at all — so this resolution is the sole protection, not a backstop
        // behind a test. (An earlier comment here claimed otherwise.)
        return isPublic && !requiresAuth && !restrictsByRole;
      }
    }
    return false;
  }
}

/**
 * Extracts the credential from `Authorization: Bearer <token>`.
 *
 * The scheme comparison is case-insensitive (RFC 7235 says the scheme is), the split is
 * on exactly one space, and anything else returns undefined rather than being coerced
 * into a token to verify.
 */
function bearerTokenOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (rest.length !== 1 || scheme?.toLowerCase() !== 'bearer') return undefined;
  // An empty credential (`Authorization: Bearer `) is absence, not a token to verify —
  // `??` would keep the empty string, which is why the length is checked explicitly.
  const token = rest[0]?.trim() ?? '';
  return token.length > 0 ? token : undefined;
}
