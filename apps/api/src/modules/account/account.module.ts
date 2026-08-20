import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountRepository } from './account.repository';
import { AccountService } from './account.service';

/**
 * Profile and address book (SPEC.md F12).
 *
 * Exports only `AccountService` — never the repository (ADR-0001). Nothing imports it
 * yet; checkout (E5) will, for the shipping and billing address.
 */
@Module({
  controllers: [AccountController],
  providers: [AccountService, AccountRepository],
  exports: [AccountService],
})
export class AccountModule {}
