import { Global, Module } from '@nestjs/common';
import { validateEnv, type Env } from './env';

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

/**
 * Validates the environment exactly once, at module construction — so a bad
 * configuration kills the boot with a named-variable message (F4/AC2) before any
 * connection is attempted.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => validateEnv() }],
  exports: [ENV],
})
export class EnvModule {}
