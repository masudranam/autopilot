import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordHasher } from './password/password-hasher';
import { AccessTokenService } from './tokens/access-token.service';
import { RefreshTokenService } from './tokens/refresh-token.service';

/**
 * Identity. F7 registers accounts, F8 issues and rotates tokens.
 *
 * `AuthService` is exported because it is the only thing another module may import
 * from here (ADR-0001) — never the repository. `AccessTokenService` and `JwtAuthGuard`
 * are exported too: F10 registers the guard globally and F12's `/me` is its first real
 * consumer, and both need the provider to be resolvable outside this module.
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
  ],
  exports: [AuthService, AccessTokenService, JwtAuthGuard],
})
export class AuthModule {}
