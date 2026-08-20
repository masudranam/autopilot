/**
 * Static assertions over schema.prisma — no database required.
 *
 * These lock in F3/AC1 (the §5 entities exist) and F3/AC5 / invariant I1 (money is
 * integer minor units + currency, never Float/Decimal). They read the schema text:
 * crude, but a regression — someone adding a `Float` price or dropping an entity —
 * fails loudly in CI without needing Postgres.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** SPEC.md §5 entity list — the contract this schema implements. */
const SPEC_ENTITIES = [
  'User',
  'Session',
  'Address',
  'Category',
  'Brand',
  'Product',
  'ProductOption',
  'ProductVariant',
  'MediaAsset',
  'InventoryItem',
  'StockReservation',
  'PriceList',
  'Price',
  'Promotion',
  'Coupon',
  'Cart',
  'CartLine',
  'CheckoutSession',
  'Order',
  'OrderLine',
  'Payment',
  'Refund',
  'Shipment',
  'ReturnRequest',
  'Review',
  'WishlistItem',
  'AuditLog',
  'ShippingZone',
  'ShippingRate',
];

function modelBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm)) {
    blocks.set(match[1]!, match[2]!);
  }
  return blocks;
}

describe('schema covers SPEC.md §5 (AC1)', () => {
  const models = modelBlocks();

  it.each(SPEC_ENTITIES)('declares %s', (entity) => {
    expect(models.has(entity)).toBe(true);
  });

  it('every model has an id, createdAt and updatedAt (except append-only AuditLog)', () => {
    for (const [name, body] of models) {
      expect(body).toMatch(/\bid\s+String\s+@id/);
      expect(body).toMatch(/\bcreatedAt\s+DateTime/);
      if (name !== 'AuditLog') expect(body).toMatch(/\bupdatedAt\s+DateTime\s+@updatedAt/);
    }
  });

  it('inventory carries a version column for optimistic concurrency', () => {
    expect(models.get('InventoryItem')).toMatch(/\bversion\s+Int/);
  });

  it('reviews are unique per customer per product (F41/AC4 shape)', () => {
    expect(models.get('Review')).toMatch(/@@unique\(\[productId, userId\]\)/);
  });
});

describe('money is integer minor units (AC5, invariant I1)', () => {
  it('the schema contains no Float and no Decimal anywhere', () => {
    // Strip comments so prose mentioning the words does not trip it.
    const code = schema.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bFloat\b/);
    expect(code).not.toMatch(/\bDecimal\b/);
  });

  it('every *Minor money column is an Int', () => {
    const code = schema.replace(/\/\/[^\n]*/g, '');
    for (const match of code.matchAll(/\b(\w*[Mm]inor)\s+(\w+\??)/g)) {
      expect(`${match[1]}: ${match[2]}`).toBe(
        `${match[1]}: Int${match[2]!.endsWith('?') ? '?' : ''}`,
      );
    }
  });

  it('every model holding money also carries a currency', () => {
    for (const [name, body] of modelBlocks()) {
      const stripped = body.replace(/\/\/[^\n]*/g, '');
      if (/\b\w*[Mm]inor\s+Int/.test(stripped)) {
        expect(`${name} has currency`).toBe(
          /\bcurrency\s+String/.test(stripped)
            ? `${name} has currency`
            : `${name} is MISSING currency`,
        );
      }
    }
  });
});

describe('relational hygiene (CLAUDE.md § Prisma & data)', () => {
  it('every relation declares an explicit onDelete', () => {
    const code = schema.replace(/\/\/[^\n]*/g, '');
    for (const match of code.matchAll(/@relation\([^)]*fields:[^)]*\)/g)) {
      expect(match[0]).toMatch(/onDelete:/);
    }
  });

  it('ids default to uuid(7)', () => {
    const code = schema.replace(/\/\/[^\n]*/g, '');
    const ids = [...code.matchAll(/@id\s+@default\(([^)]*\)?)\)/g)];
    expect(ids.length).toBeGreaterThan(0);
    for (const match of ids) expect(match[1]).toBe('uuid(7)');
  });
});

describe('database naming is snake_case (CLAUDE.md § Prisma & data)', () => {
  const models = modelBlocks();
  const enumNames = [...schema.matchAll(/^enum\s+(\w+)\s+\{/gm)].map((m) => m[1]!);
  const scalarTypes = new Set([
    'String',
    'Int',
    'Boolean',
    'DateTime',
    'Json',
    'BigInt',
    'Bytes',
    ...enumNames,
  ]);

  const toSnake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

  it('every model maps to a plural snake_case table', () => {
    for (const [name, body] of models) {
      const map = /@@map\("([^"]+)"\)/.exec(body);
      expect(`${name}: ${map?.[1] ?? 'NO @@map'}`).toMatch(/: [a-z][a-z0-9_]*s$/);
    }
  });

  it('every camelCase scalar column maps to its snake_case name', () => {
    for (const [modelName, body] of models) {
      const code = body.replace(/\/\/[^\n]*/g, '');
      for (const line of code.split('\n')) {
        const field = /^\s{2}(\w+)\s+(\w+)(\??)(\[\])?\s*(.*)$/.exec(line);
        if (!field) continue;
        const [, name, type, , , rest] = field;
        if (!scalarTypes.has(type!)) continue; // relation object fields have no column
        if (!/[A-Z]/.test(name!)) continue; // already snake-identical
        const map = /@map\("([^"]+)"\)/.exec(rest!);
        expect(`${modelName}.${name}: ${map?.[1] ?? 'NO @map'}`).toBe(
          `${modelName}.${name}: ${toSnake(name!)}`,
        );
      }
    }
  });

  it('every enum type maps to a snake_case DB type', () => {
    const enums = [...schema.matchAll(/^enum\s+(\w+)\s+\{([\s\S]*?)^\}/gm)];
    expect(enums.length).toBeGreaterThan(0);
    for (const [, name, body] of enums) {
      const map = /@@map\("([^"]+)"\)/.exec(body!);
      expect(`${name}: ${map?.[1] ?? 'NO @@map'}`).toBe(`${name}: ${toSnake(name!)}`);
    }
  });
});
