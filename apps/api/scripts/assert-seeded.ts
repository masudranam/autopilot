/**
 * Asserts the database is genuinely populated after a replay.
 *
 * F6/AC3 proves migrations replay from empty; without this, a replay that produced an
 * EMPTY catalogue would still pass CI green. The thresholds mirror F3/AC4 so the two
 * criteria cannot drift apart.
 *
 * A checked-in script rather than inline YAML because it needs the Prisma client, which
 * Prisma 7 emits as TypeScript — an inline `node -e` with require('client.js') fails,
 * since no .js is generated.
 *
 *   pnpm --filter @repo/api exec tsx scripts/assert-seeded.ts
 */
import 'dotenv/config';
import { createPrismaClient } from '../src/db/client';

/** Minimums from SPEC.md F3/AC4 — a browsable catalogue, not three lorem products. */
const MINIMUMS = {
  publishedProducts: 20,
  variants: 20,
  categories: 3,
  brands: 2,
  users: 2,
} as const;

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const actual = {
      publishedProducts: await prisma.product.count({ where: { status: 'PUBLISHED' } }),
      variants: await prisma.productVariant.count(),
      categories: await prisma.category.count(),
      brands: await prisma.brand.count(),
      users: await prisma.user.count(),
    };

    console.log(`replayed database: ${JSON.stringify(actual)}`);

    const shortfalls = Object.entries(MINIMUMS)
      .filter(
        ([key]) => actual[key as keyof typeof actual] < MINIMUMS[key as keyof typeof MINIMUMS],
      )
      .map(
        ([key]) =>
          `${key}: ${actual[key as keyof typeof actual]} < ${MINIMUMS[key as keyof typeof MINIMUMS]}`,
      );

    // Every variant must be sellable — stock and a price — or the catalogue is not
    // genuinely browsable even with the right row counts.
    const unsellable = await prisma.productVariant.count({
      where: {
        OR: [{ inventory: null }, { inventory: { onHand: { lte: 0 } } }, { prices: { none: {} } }],
      },
    });
    if (unsellable > 0) shortfalls.push(`${unsellable} variant(s) without stock or a price`);

    if (shortfalls.length > 0) {
      console.error(`::error::replay produced an unusable database — ${shortfalls.join('; ')}`);
      process.exit(1);
    }

    console.log('replayed database is populated and every variant is sellable');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
