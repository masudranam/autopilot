import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RoleName } from '@repo/contracts';
import { ForbiddenError } from '../errors/domain-error';
import { REQUIRES_AUTH_KEY } from './authenticated.decorator';
import type { RequestWithAuth } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/**
 * Enforces `@Roles()` (F10/AC1, AC2).
 *
 * Runs after `JwtAuthGuard` — both are global, and Nest executes global guards in
 * registration order, so by the time this runs the claims are attached or the request
 * was already refused. That ordering is asserted by a test rather than assumed.
 *
 * 403, not 404. This is the one place the project deliberately does NOT hide existence:
 * I4 is about a caller reaching *another account's* resource, where confirming the row
 * exists is the leak. An admin route is not a per-account resource — its existence is
 * in the OpenAPI document — so the honest answer to an authenticated customer is "you
 * may not", and answering 404 would send a support engineer hunting a missing route.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.requiredRoles(context);

    // No role requirement: any authenticated caller may proceed. The route is still
    // closed by the JWT guard — this guard only ever narrows.
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const role = request.auth?.role;

    // Claims missing on a role-restricted route means the JWT guard did not run — a
    // wiring mistake, and one that must fail closed. Reaching this with no claims and
    // returning true would make every @Roles route public.
    if (!role || !required.includes(role)) {
      throw new ForbiddenError('You do not have permission to perform this action.');
    }

    return true;
  }

  /**
   * The roles required at the NEAREST level that states a decision.
   *
   * Deliberately not `getAllAndOverride(ROLES_KEY, …)`, which would find a class-level
   * `@Roles()` even on a handler marked `@Public()`. That combination produced a route
   * answering 403 to *everyone* — including the named role — because `JwtAuthGuard`
   * honoured the handler's public decision and attached no claims, while this guard
   * still found the class's roles and rejected for want of a role. Closed, but bricked,
   * and silently: the review of PR #90 found it by probing rather than from a test.
   *
   * Reading the handler's markers first, and treating any handler-level decision as the
   * whole answer, makes both guards agree on precedence: a handler-level decision beats
   * a class-level one whatever kind it is.
   */
  private requiredRoles(context: ExecutionContext): RoleName[] | undefined {
    for (const target of [context.getHandler(), context.getClass()]) {
      const roles = this.reflector.get<RoleName[] | undefined>(ROLES_KEY, target);
      if (Array.isArray(roles) && roles.length > 0) return roles;
      // A handler that declared itself public or merely authenticated has answered the
      // question; the class's roles do not apply to it.
      if (this.reflector.get<boolean | undefined>(IS_PUBLIC_KEY, target) === true) return undefined;
      if (this.reflector.get<boolean | undefined>(REQUIRES_AUTH_KEY, target) === true) {
        return undefined;
      }
    }
    return undefined;
  }
}
