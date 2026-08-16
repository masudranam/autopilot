/**
 * Integration tests for the seed — real database, no mocks (rules/30-prisma.md).
 *
 * Covers F3/AC3 (idempotency, I8) and F3/AC4 (browsable catalogue). The test script
 * runs `prisma migrate deploy && prisma db seed` first, so the database is migrated
 * and seeded once before jest starts; the idempotency test then re-runs the seed
 * in-process and asserts the state fingerprint did not change at all.
 */
import { verify } from '@node-rs/argon2';
import { createPrismaClient, type PrismaClient } from '../src/db/client';
import { seed, SEED_ACCOUNT_PASSWORD } from './seed';

let prisma: PrismaClient;

/**
 * The seed's own accounts, and the scope of every assertion this file makes about
 * `users`.
 *
 * `users` stopped being a table only the seed writes to when F7 landed: the
 * registration e2e suite creates real accounts, with real Argon2id hashes, in a
 * PARALLEL jest worker against this same database. An unscoped `user.findMany()` here
 * therefore reads whatever that suite happens to have in flight, which made both the
 * idempotency fingerprint and the placeholder-hash assertion fail at random — roughly
 * one full-suite run in seven, and every run when the two files are scheduled together.
 *
 * Scoping to the seed's domain is not a weakening: every assertion below states what
 * the SEED produces, and `SEEDED_EMAILS` pins the exact set, so the filter cannot
 * silently start matching nothing or quietly tolerate an extra seeded account.
 */
const SEED_EMAIL_DOMAIN = '@agentic-shop.test';

const SEEDED_EMAILS = ['admin@agentic-shop.test', 'customer@agentic-shop.test'];

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
    // Scoped — see SEED_EMAIL_DOMAIN. Rows the F7 registration suite creates in a
    // parallel worker are not the seed's output and must not enter the fingerprint.
    prisma.user.findMany({
      where: { email: { endsWith: SEED_EMAIL_DOMAIN } },
      orderBy: { email: 'asc' },
    }),
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

  /**
   * Since F8 the demo accounts are genuinely signable-in.
   *
   * The password is asserted through the library's own `verify` — the only proof that
   * what is stored is a usable credential rather than a plausible-looking string — and
   * the hash is checked to be Argon2id at the ADR-0009 cost, so a seed that quietly
   * wrote a cheaper hash fails here.
   */
  it('seeded accounts carry real Argon2id hashes of the documented dev password', async () => {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: SEED_EMAIL_DOMAIN } },
      select: { email: true, passwordHash: true },
      orderBy: { email: 'asc' },
    });

    // Asserted first, so the scoped filter cannot pass this test by matching nothing.
    expect(users.map((user) => user.email)).toEqual(SEEDED_EMAILS);

    for (const user of users) {
      expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      await expect(verify(user.passwordHash, SEED_ACCOUNT_PASSWORD)).resolves.toBe(true);
      await expect(verify(user.passwordHash, `${SEED_ACCOUNT_PASSWORD}x`)).resolves.toBe(false);
    }

    // Salted per account: two demo users sharing one password must not share a hash.
    expect(new Set(users.map((user) => user.passwordHash)).size).toBe(users.length);
  });
});

/**
 * The credential guard (security review of PR #78).
 *
 * `SEED_ACCOUNT_PASSWORD` is committed to this repository and one seeded account is an
 * ADMIN, so a *verifiable* hash of it is a published administrator credential anywhere
 * but a throwaway local database. The test above asserts the hash works; this one
 * asserts it only works where it is safe, which is the half that stops the seed being
 * an authentication bypass on a demo or staging box.
 *
 * Runs last and restores the usable hashes afterwards, so the assertions above — and a
 * developer's own database — are unaffected.
 */
describe('the seed only writes a usable credential on a local database', () => {
  const realDatabaseUrl = process.env.DATABASE_URL;

  afterAll(async () => {
    process.env.DATABASE_URL = realDatabaseUrl;
    await prisma.user.deleteMany({ where: { email: { in: SEEDED_EMAILS } } });
    await seed(prisma);
  });

  it('writes an unusable hash when DATABASE_URL names a remote host', async () => {
    await prisma.user.deleteMany({ where: { email: { in: SEEDED_EMAILS } } });
    process.env.DATABASE_URL = 'postgresql://app:pw@db.staging.example.com:5432/app?schema=public';

    await seed(prisma);

    const admin = await prisma.user.findUnique({
      where: { email: 'admin@agentic-shop.test' },
      select: { role: true, passwordHash: true },
    });

    // The account still exists — F3/AC4 wants a browsable catalogue everywhere. It is
    // the credential that is withheld, not the seed.
    expect(admin?.role).toBe('ADMIN');
    expect(admin?.passwordHash).toMatch(/^SEED_PLACEHOLDER_NOT_A_VERIFIABLE_HASH:/);
    // Not merely "different" — nothing Argon2id could ever verify against.
    expect(admin?.passwordHash.startsWith('$argon2id$')).toBe(false);
  });

  it('writes an unusable hash when NODE_ENV is production, even on loopback', async () => {
    await prisma.user.deleteMany({ where: { email: { in: SEEDED_EMAILS } } });
    process.env.DATABASE_URL = realDatabaseUrl;
    const realNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      await seed(prisma);
    } finally {
      process.env.NODE_ENV = realNodeEnv;
    }

    const admin = await prisma.user.findUnique({
      where: { email: 'admin@agentic-shop.test' },
      select: { passwordHash: true },
    });
    expect(admin?.passwordHash).toMatch(/^SEED_PLACEHOLDER_NOT_A_VERIFIABLE_HASH:/);
  });
});
