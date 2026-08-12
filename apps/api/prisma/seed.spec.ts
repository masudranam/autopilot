/**
 * Integration tests for the seed — real database, no mocks (rules/30-prisma.md).
 *
 * Covers F3/AC3 (idempotency, I8) and F3/AC4 (browsable catalogue). The test script
 * runs `prisma migrate deploy && prisma db seed` first, so the database is migrated
 * and seeded once before jest starts; the idempotency test then re-runs the seed
 * in-process and asserts the state fingerprint did not change at all.
 */
import { createPrismaClient, type PrismaClient } from '../src/db/client';
import { seed } from './seed';

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A byte-level fingerprint of everything the seed touches, including timestamps.
 * The seed never updates existing rows, so a second run must leave this identical —
 * not merely "same counts", which would pass even if the seed rewrote every row.
 */
async function fingerprint() {
  const [
    users,
    categories,
    brands,
    products,
    options,
    values,
    variants,
    inventory,
    priceLists,
    prices,
  ] = await Promise.all([
    prisma.user.findMany({ orderBy: { email: 'asc' } }),
    prisma.category.findMany({ orderBy: { slug: 'asc' } }),
    prisma.brand.findMany({ orderBy: { slug: 'asc' } }),
    prisma.product.findMany({ orderBy: { slug: 'asc' } }),
    prisma.productOption.findMany({ orderBy: { id: 'asc' } }),
    prisma.productOptionValue.findMany({ orderBy: { id: 'asc' } }),
    // include the option-value links: the implicit m2m join table is seeded too, and
    // a fingerprint that skips it would miss a regression touching only the links
    prisma.productVariant.findMany({
      orderBy: { sku: 'asc' },
      include: { optionValues: { orderBy: { id: 'asc' } } },
    }),
    prisma.inventoryItem.findMany({ orderBy: { id: 'asc' } }),
    prisma.priceList.findMany({ orderBy: { name: 'asc' } }),
    prisma.price.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return JSON.stringify({
    users,
    categories,
    brands,
    products,
    options,
    values,
    variants,
    inventory,
    priceLists,
    prices,
  });
}

describe('seed idempotency (AC3, invariant I8)', () => {
  it('a second run changes nothing at all — timestamps included', async () => {
    const before = await fingerprint();
    await seed(prisma);
    const after = await fingerprint();
    expect(after).toBe(before);
  });
});

describe('the catalogue is browsable (AC4)', () => {
  it('has at least 3 categories', async () => {
    expect(await prisma.category.count()).toBeGreaterThanOrEqual(3);
  });

  it('has a real category tree, not a flat list', async () => {
    expect(await prisma.category.count({ where: { parentId: { not: null } } })).toBeGreaterThan(0);
  });

  it('has at least 2 brands', async () => {
    expect(await prisma.brand.count()).toBeGreaterThanOrEqual(2);
  });

  it('has at least 20 published products', async () => {
    expect(await prisma.product.count({ where: { status: 'PUBLISHED' } })).toBeGreaterThanOrEqual(
      20,
    );
  });

  it('every product has at least one variant', async () => {
    const empty = await prisma.product.findMany({
      where: { variants: { none: {} } },
      select: { slug: true },
    });
    expect(empty).toEqual([]);
  });

  it('every variant has stock on hand', async () => {
    const unstocked = await prisma.productVariant.findMany({
      where: { OR: [{ inventory: null }, { inventory: { onHand: { lte: 0 } } }] },
      select: { sku: true },
    });
    expect(unstocked).toEqual([]);
  });

  it('every variant has a price in integer minor units (AC5, I1)', async () => {
    const unpriced = await prisma.productVariant.findMany({
      where: { prices: { none: {} } },
      select: { sku: true },
    });
    expect(unpriced).toEqual([]);

    const prices = await prisma.price.findMany({ select: { amountMinor: true, currency: true } });
    for (const price of prices) {
      expect(Number.isInteger(price.amountMinor)).toBe(true);
      expect(price.amountMinor).toBeGreaterThan(0);
      expect(price.currency).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('SKUs are unique and deterministic', async () => {
    const variants = await prisma.productVariant.findMany({ select: { sku: true } });
    const skus = variants.map((v) => v.sku);
    expect(new Set(skus).size).toBe(skus.length);
    expect(skus).toContain('HARBOR-TEE-M');
  });

  it('has one admin and one customer account', async () => {
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.user.count({ where: { role: 'CUSTOMER' } })).toBeGreaterThanOrEqual(1);
  });

  it('seeded accounts carry unverifiable placeholder hashes, not real-looking ones', async () => {
    const users = await prisma.user.findMany({ select: { passwordHash: true } });
    for (const user of users) {
      expect(user.passwordHash).toMatch(/^SEED_PLACEHOLDER_NOT_A_VERIFIABLE_HASH:/);
    }
  });
});
