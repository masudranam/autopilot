import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { EnvModule } from './config/env.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { TraceMiddleware } from './common/trace/trace.middleware';

@Module({
  imports: [EnvModule, PrismaModule, RedisModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including ones that 404 — a request that never reaches a
    // controller still needs a trace id and an access log line (AC3, AC4).
    consumer.apply(TraceMiddleware).forRoutes('*splat');
  }
}
