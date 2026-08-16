import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordHasher } from './password/password-hasher';

/**
 * Identity. F7 registers accounts; F8 will add the login exchange here.
 *
 * `AuthService` is exported because it is the only thing another module may import
 * from here (ADR-0001) — never the repository.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, PasswordHasher],
  exports: [AuthService],
})
export class AuthModule {}
