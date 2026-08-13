import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, {
      // Boot must not hang on a down Redis — readiness reports it instead (F4/AC3).
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // ioredis emits 'error' on every failed reconnect; without a listener each one
    // becomes an unhandled-error crash. Readiness surfaces the state instead.
    this.client.on('error', () => {
      /* reported via ping() */
    });
  }

  onModuleDestroy(): void {
    // Synchronous on purpose: quit() waits for a server reply, which never comes if
    // the connection never came up. disconnect() just tears down.
    this.client.disconnect();
  }

  /** Readiness probe: PING, connecting lazily on first use. */
  async ping(): Promise<void> {
    if (this.client.status === 'wait') await this.client.connect();
    await this.client.ping();
  }
}
