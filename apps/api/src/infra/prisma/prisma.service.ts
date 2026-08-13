import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '../../db/client';

/**
 * The one PrismaClient for the application. Modules inject this service; nothing
 * else constructs a client (rules/10-backend.md — repositories only).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor() {
    this.client = createPrismaClient();
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /** Readiness probe: one cheap round trip, bounded by the caller's timeout. */
  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }
}
