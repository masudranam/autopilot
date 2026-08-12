import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Prisma 7 requires a driver adapter — `new PrismaClient()` bare throws
 * PrismaClientInitializationError. This is the one place the adapter is constructed;
 * everything else receives a client rather than building one.
 *
 * The fallback URL matches infra/docker-compose.yml's defaults so a fresh clone works
 * before anyone writes a .env (same policy as prisma.config.ts).
 */
export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const connectionString =
    databaseUrl ??
    process.env.DATABASE_URL ??
    'postgresql://ecommerce:ecommerce_dev_password@localhost:5442/ecommerce?schema=public';

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export type { PrismaClient };
