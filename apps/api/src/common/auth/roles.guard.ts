import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RoleName } from '@repo/contracts';
import { ForbiddenError } from '../errors/domain-error';
import type { RequestWithAuth } from './jwt-auth.guard';
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
    // Handler first, then class: `@Roles(ADMIN)` on a controller with one route opened
    // to SUPPORT is a decision, and getAllAndOverride is what respects it.
    const required = this.reflector.getAllAndOverride<RoleName[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

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
}
