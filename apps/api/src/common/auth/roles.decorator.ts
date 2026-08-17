import { SetMetadata } from '@nestjs/common';
import type { RoleName } from '@repo/contracts';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to the listed roles (F10/AC1).
 *
 * Narrows the authenticated default rather than establishing it: the global
 * `JwtAuthGuard` (F9/AC5) already denies an undecorated route, so this says *which*
 * authenticated callers may proceed, not *whether* authentication is required.
 *
 * ```ts
 * @Roles(Role.ADMIN)
 * @Get('orders')
 * ```
 *
 * A route carrying `@Roles()` needs no `@Authenticated()` as well — requiring a role
 * implies requiring a token, and the I5 sweep accepts it as an explicit decision on its
 * own. Listing several roles means any one of them suffices.
 */
export const Roles = (...roles: [RoleName, ...RoleName[]]) => SetMetadata(ROLES_KEY, roles);
