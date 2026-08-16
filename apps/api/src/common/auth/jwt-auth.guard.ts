import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AccessTokenClaims } from '@repo/contracts';
import { UnauthenticatedError } from '../errors/domain-error';
import {
  ACCESS_TOKEN_REJECTED,
  AccessTokenService,
} from '../../modules/auth/tokens/access-token.service';
import { IS_PUBLIC_KEY } from './public.decorator';

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
 * Deliberately NOT registered as a global `APP_GUARD` here. Default-closed — a route
 * with no decorator being denied — is F10/AC3, and it needs the `@Roles()` decorator
 * and role guard to land in the same change or every future route is either public or
 * unreachable. What F8 owns is the part AC5 names: an expired or malformed token is a
 * 401 with a Problem Details body, never a 500 from an unhandled `TokenExpiredError`.
 *
 * `@Public()` is honoured here already, so switching this on globally in F10 is one
 * line in a module and not a sweep through every controller — the sweep is where a
 * route gets missed.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler first, then controller: a `@Public()` route inside an otherwise-protected
    // controller is a decision, and getAllAndOverride is what respects it.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = bearerTokenOf(request.headers.authorization);

    // Same error for "no header" as for "bad token": `verify` throws
    // UnauthenticatedError with one message for every failure mode, and a missing
    // header must not be the one case that answers differently.
    if (!token) throw new UnauthenticatedError(ACCESS_TOKEN_REJECTED);

    request.auth = this.accessTokens.verify(token);
    return true;
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
