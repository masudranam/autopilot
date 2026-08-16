import { Module } from '@nestjs/common';
import { EnvModule } from './config/env.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Tracing is deliberately NOT applied here. Nest registers its body parsers during
 * `NestFactory.create`, ahead of anything `configure()` applies, so a middleware class
 * cannot wrap a body-parse failure. `configureApp` registers the trace handler with
 * `app.use()` before the parsers instead — see app.setup.ts.
 */
@Module({
  imports: [EnvModule, PrismaModule, RedisModule, HealthModule, AuthModule],
})
export class AppModule {}
