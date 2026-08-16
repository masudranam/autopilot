/**
 * Seed — produces a browsable catalogue (SPEC.md F3/AC4) and is idempotent (I8).
 *
 * Idempotency strategy: create-if-missing on natural keys (slug, sku, email, name),
 * never update. A second run therefore performs ZERO writes and the database state —
 * including every updatedAt — is byte-identical, which is what the seed.spec asserts.
 * Content is fully deterministic: no randomness, no wall-clock-dependent values.
 *
 * Since F8 the two demo accounts carry REAL Argon2id hashes of a documented
 * development password, because `POST /auth/login` now exists and a demo account
 * nobody can sign in to is not a demo account. The password is deliberately long,
 * obviously non-production, and only ever hashed into a database that a developer
 * seeded on purpose — the seed never runs against a production database, and the two
 * addresses are on the reserved `.test` TLD.
 *
 * The hash is written ONLY when the account is created. Re-hashing on every run would
 * produce a new salt each time and break I8: the second run must change nothing.
 */
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { ARGON2_PARAMETERS } from '../src/modules/auth/password/argon2-parameters';
import { createPrismaClient } from '../src/db/client';
import type { PrismaClient } from '../src/db/client';

/**
 * The development password for both seeded accounts.
 *
 * Exported so the seed spec asserts against this exact value rather than a copy that
 * can drift — and so `pnpm dev` users have one place to read it from.
 */
export const SEED_ACCOUNT_PASSWORD = 'seed-development-password-not-for-production';

/** Mirrors `scripts/db-reset.mjs` — one definition of "this is a dev database". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A hash no verifier can ever match. Argon2id parses `$argon2id$…`; this is not that
 * shape, so `verify` rejects it rather than throwing something a caller might mistake
 * for a match.
 */
const UNUSABLE_HASH = 'SEED_PLACEHOLDER_NOT_A_VERIFIABLE_HASH';

/**
 * Whether this run may write a password that actually logs in.
 *
 * `SEED_ACCOUNT_PASSWORD` is committed to a repository, and one of the two seeded
 * accounts is an ADMIN. Writing a *verifiable* hash of it is therefore only safe on a
 * throwaway local database — anywhere else it is a published administrator credential,
 * which is an authentication bypass rather than a convenience.
 *
 * Resolves the target the same way `src/db/client.ts` does, and that detail is
 * load-bearing: an ABSENT `DATABASE_URL` means the client falls back to its hard-coded
 * loopback compose URL, so absent is loopback rather than unknown. Treating absent as
 * hostile looks safer and is simply wrong — `turbo.json` sets `globalEnv` without
 * `DATABASE_URL` and Turbo 2 defaults to `envMode: strict`, so the variable is stripped
 * from the test task and absent is the NORMAL case in CI. That mistake reached CI once;
 * it is written down so it does not again.
 *
 * Still fails closed where it counts: an unparseable URL, any non-loopback host, and an
 * explicit production `NODE_ENV` even on loopback. Same guard and the same known limit
 * as `scripts/db-reset.mjs`: a tunnel to a remote database lands on 127.0.0.1 and would
 * pass, so this stops an accident, not a determined operator. Reaching a real
 * production database requires `DATABASE_URL` to name it, and that is the case checked.
 *
 * The catalogue still seeds everywhere — F3/AC4 asks for something browsable, and that
 * requirement is what makes people run this on demo boxes in the first place. Only the
 * credential is withheld.
 */
function mayWriteUsableCredentials(): boolean {
  if (process.env.NODE_ENV === 'production') return false;

  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') return true;

  try {
    const parsed = new URL(url);

    // libpq-style `?host=` / `?port=` OVERRIDE the authority for the real driver, so
    // `…@localhost:5432/db?host=db.prod.example.com` parses as loopback here and
    // connects somewhere else entirely. That is the documented Cloud SQL, PgBouncer and
    // Supabase-pooler form, so it arrives by ordinary configuration rather than by
    // craft. Refuse rather than try to out-parse the driver.
    if (parsed.searchParams.has('host') || parsed.searchParams.has('port')) return false;

    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Deterministic round-robin pick — total, so noUncheckedIndexedAccess stays honest. */
function cycle<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('cycle() over an empty array');
  return item;
}

// ---------------------------------------------------------------- data

const CATEGORIES = [
  { slug: 'apparel', name: 'Apparel', children: ['t-shirts', 'hoodies'] },
  { slug: 't-shirts', name: 'T-Shirts', children: [] },
  { slug: 'hoodies', name: 'Hoodies', children: [] },
  { slug: 'mugs', name: 'Mugs', children: [] },
  { slug: 'posters', name: 'Posters', children: [] },
] as const;

const BRANDS = [
  { slug: 'northwind', name: 'Northwind' },
  { slug: 'acme-supply', name: 'Acme Supply' },
  { slug: 'blue-harbor', name: 'Blue Harbor' },
] as const;

interface ProductSpec {
  slug: string;
  name: string;
  category: string;
  brand: string;
  basePriceMinor: number;
  options: { name: string; values: string[] }[];
  stockPerVariant: number;
}

/**
 * 24 products. Apparel gets a Size option (3 variants each); mugs and posters get a
 * single Style/Format option. Prices are deterministic and distinct so lists sort
 * interestingly. All USD, integer minor units (I1).
 */
const PRODUCTS: ProductSpec[] = [];

const SHIRT_NAMES = [
  'Harbor Tee',
  'Ridge Tee',
  'Prairie Tee',
  'Summit Tee',
  'Meadow Tee',
  'Canyon Tee',
  'Dune Tee',
  'Fjord Tee',
];
SHIRT_NAMES.forEach((name, i) =>
  PRODUCTS.push({
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    category: 't-shirts',
    brand: cycle(BRANDS, i).slug,
    basePriceMinor: 1900 + i * 150, // $19.00 … $29.50
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    stockPerVariant: 12 + (i % 5) * 3,
  }),
);

const HOODIE_NAMES = [
  'Harbor Hoodie',
  'Ridge Hoodie',
  'Summit Hoodie',
  'Fjord Hoodie',
  'Canyon Hoodie',
  'Dune Hoodie',
];
HOODIE_NAMES.forEach((name, i) =>
  PRODUCTS.push({
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    category: 'hoodies',
    brand: cycle(BRANDS, i + 1).slug,
    basePriceMinor: 4900 + i * 300, // $49.00 … $64.00
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    stockPerVariant: 8 + (i % 4) * 2,
  }),
);

const MUG_NAMES = ['Compass Mug', 'Lighthouse Mug', 'Anchor Mug', 'Beacon Mug', 'Harbor Mug'];
MUG_NAMES.forEach((name, i) =>
  PRODUCTS.push({
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    category: 'mugs',
    brand: cycle(BRANDS, i + 2).slug,
    basePriceMinor: 1200 + i * 100, // $12.00 … $16.00
    options: [{ name: 'Style', values: ['Classic', 'Matte'] }],
    stockPerVariant: 25 + i * 5,
  }),
);

const POSTER_NAMES = [
  'Coastline Poster',
  'Skyline Poster',
  'Forest Poster',
  'Desert Poster',
  'Glacier Poster',
];
POSTER_NAMES.forEach((name, i) =>
  PRODUCTS.push({
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    category: 'posters',
    brand: cycle(BRANDS, i).slug,
    basePriceMinor: 1500 + i * 250, // $15.00 … $25.00
    options: [{ name: 'Format', values: ['A2', 'A1'] }],
    stockPerVariant: 15 + i * 2,
  }),
);

// ---------------------------------------------------------------- seeding

async function ensureUser(
  prisma: PrismaClient,
  email: string,
  role: 'ADMIN' | 'CUSTOMER',
  firstName: string,
  lastName: string,
) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      role,
      firstName,
      lastName,
      // Hashed here rather than pasted as a constant: a literal hash would pin one
      // salt into the repository and would silently stop matching the day the cost
      // parameters change. Off a dev database this writes an unusable value instead —
      // see `mayWriteUsableCredentials`.
      passwordHash: mayWriteUsableCredentials()
        ? await hash(SEED_ACCOUNT_PASSWORD, ARGON2_PARAMETERS)
        : `${UNUSABLE_HASH}:${email}`,
    },
  });
}

export async function seed(prisma: PrismaClient): Promise<void> {
  // Accounts (F3/AC4: one admin, one customer)
  await ensureUser(prisma, 'admin@agentic-shop.test', 'ADMIN', 'Ada', 'Admin');
  await ensureUser(prisma, 'customer@agentic-shop.test', 'CUSTOMER', 'Casey', 'Customer');

  // Categories — parents first so children can reference them.
  for (const cat of CATEGORIES) {
    const existing = await prisma.category.findUnique({ where: { slug: cat.slug } });
    if (!existing) {
      await prisma.category.create({ data: { slug: cat.slug, name: cat.name } });
    }
  }
  // Tree wiring, separately and idempotently (parent may not have existed above).
  for (const cat of CATEGORIES) {
    for (const childSlug of cat.children) {
      const child = await prisma.category.findUniqueOrThrow({ where: { slug: childSlug } });
      if (!child.parentId) {
        const parent = await prisma.category.findUniqueOrThrow({ where: { slug: cat.slug } });
        await prisma.category.update({ where: { id: child.id }, data: { parentId: parent.id } });
      }
    }
  }

  for (const brand of BRANDS) {
    const existing = await prisma.brand.findUnique({ where: { slug: brand.slug } });
    if (!existing) await prisma.brand.create({ data: brand });
  }

  // One default price list; F44 adds more.
  let priceList = await prisma.priceList.findUnique({ where: { name: 'Default' } });
  priceList ??= await prisma.priceList.create({ data: { name: 'Default', priority: 0 } });

  for (const spec of PRODUCTS) {
    const existing = await prisma.product.findUnique({ where: { slug: spec.slug } });
    if (existing) continue; // a product is created whole; presence means done

    const category = await prisma.category.findUniqueOrThrow({ where: { slug: spec.category } });
    const brand = await prisma.brand.findUniqueOrThrow({ where: { slug: spec.brand } });

    const product = await prisma.product.create({
      data: {
        slug: spec.slug,
        name: spec.name,
        description: `${spec.name} by ${brand.name}. Deterministic seed data for a browsable catalogue.`,
        status: 'PUBLISHED',
        categoryId: category.id,
        brandId: brand.id,
      },
    });

    for (const optionSpec of spec.options) {
      const option = await prisma.productOption.create({
        data: { productId: product.id, name: optionSpec.name },
      });

      for (const [index, value] of optionSpec.values.entries()) {
        const optionValue = await prisma.productOptionValue.create({
          data: { optionId: option.id, value, position: index },
        });

        const sku = `${spec.slug}-${value}`.toUpperCase().replace(/[^A-Z0-9]+/g, '-');
        const variant = await prisma.productVariant.create({
          data: {
            productId: product.id,
            sku,
            weightGrams: spec.category === 'hoodies' ? 650 : spec.category === 'mugs' ? 400 : 180,
            optionValues: { connect: { id: optionValue.id } },
          },
        });

        await prisma.inventoryItem.create({
          data: { variantId: variant.id, onHand: spec.stockPerVariant },
        });

        // Larger sizes/formats cost slightly more — deterministic, index-based.
        await prisma.price.create({
          data: {
            variantId: variant.id,
            priceListId: priceList.id,
            amountMinor: spec.basePriceMinor + index * 200,
            currency: 'USD',
          },
        });
      }
    }
  }
}

/* c8 ignore start */
async function main() {
  const prisma = createPrismaClient();
  try {
    await seed(prisma);
    const counts = {
      users: await prisma.user.count(),
      categories: await prisma.category.count(),
      brands: await prisma.brand.count(),
      products: await prisma.product.count(),
      variants: await prisma.productVariant.count(),
      prices: await prisma.price.count(),
    };
    console.log(`seeded: ${JSON.stringify(counts)}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
/* c8 ignore stop */
