import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Probes each dependency with a bounded timeout. A probe that hangs is as
   * unavailable as one that errors — without the bound, a wedged connection pool
   * would make readiness hang instead of reporting 503.
   */
  async checkReadiness(): Promise<Record<'postgres' | 'redis', boolean>> {
    const [postgres, redis] = await Promise.all([
      this.probe(() => this.prisma.ping()),
      this.probe(() => this.redis.ping()),
    ]);
    return { postgres, redis };
  }

  private async probe(check: () => Promise<unknown>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
