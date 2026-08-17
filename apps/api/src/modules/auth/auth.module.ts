import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordHasher } from './password/password-hasher';
import { AccessTokenService } from './tokens/access-token.service';
import { RefreshTokenService } from './tokens/refresh-token.service';

/**
 * Identity. F7 registers accounts, F8 issues and rotates tokens, F9 manages sessions.
 *
 * `AuthService` is exported because it is the only thing another module may import
 * from here (ADR-0001) — never the repository. `AccessTokenService` and `JwtAuthGuard`
 * are exported too, since F12's `/me` and every later authenticated route need the
 * providers resolvable outside this module.
 *
 * THE GUARD IS GLOBAL FROM F9, not F10.
 *
 * SPEC put default-closed in F10/AC3 on the reasoning that it needed `@Roles()` in the
 * same change. That reasoning was wrong: a route with no decorator under a global
 * `JwtAuthGuard` is neither public nor unreachable, it is authenticated-only — which is
 * precisely the fail-closed default the rule asks for, and roles narrow it afterwards
 * rather than being a prerequisite.
 *
 * Registering it here is what makes F9 safe to build. F9 adds the first routes that
 * must not be public; without a global guard they would be open, and the I5 sweep — a
 * test asserting every route carries `@Public()` — would have pushed toward marking a
 * session list public to keep the suite green. SPEC.md §7 is amended accordingly.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    PasswordHasher,
    AccessTokenService,
    RefreshTokenService,
    JwtAuthGuard,
    // Applies to every route in the application, not only this module's.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
  ],
  exports: [AuthService, AccessTokenService, JwtAuthGuard],
})
export class AuthModule {}
