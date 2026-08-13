import { Module } from '@nestjs/common';
import { EnvModule } from './config/env.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [EnvModule, PrismaModule, RedisModule, HealthModule],
})
export class AppModule {}
