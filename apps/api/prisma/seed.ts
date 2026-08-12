/**
 * Seed — produces a browsable catalogue (SPEC.md F3/AC4) and is idempotent (I8).
 *
 * Idempotency strategy: create-if-missing on natural keys (slug, sku, email, name),
 * never update. A second run therefore performs ZERO writes and the database state —
 * including every updatedAt — is byte-identical, which is what the seed.spec asserts.
 * Content is fully deterministic: no randomness, no wall-clock-dependent values.
 *
 * The accounts get placeholder password hashes with a prefix no verifier will ever
 * match. Real Argon2id hashing arrives with the auth module (F7), which re-seeds
 * these two accounts with real hashes. Documented here so nobody mistakes the
 * placeholder for a weakly-hashed password.
 */
import 'dotenv/config';
import { createPrismaClient } from '../src/db/client';
import type { PrismaClient } from '../src/db/client';

const PLACEHOLDER_HASH_PREFIX = 'SEED_PLACEHOLDER_NOT_A_VERIFIABLE_HASH:';

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
      passwordHash: `${PLACEHOLDER_HASH_PREFIX}${email}`,
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
