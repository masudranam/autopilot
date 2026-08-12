import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  cursorQuerySchema,
  pageInfoSchema,
  paginatedSchema,
  sortDirectionSchema,
} from './pagination';

describe('paginatedSchema', () => {
  const schema = paginatedSchema(z.object({ id: z.string() }));

  it('accepts a well-formed page', () => {
    const page = { items: [{ id: 'a' }], pageInfo: { nextCursor: 'x', hasNextPage: true } };
    expect(schema.parse(page)).toEqual(page);
  });

  it('accepts an empty page with a null cursor', () => {
    const page = { items: [], pageInfo: { nextCursor: null, hasNextPage: false } };
    expect(schema.parse(page)).toEqual(page);
  });

  it('rejects a missing pageInfo', () => {
    expect(() => schema.parse({ items: [] })).toThrow();
  });

  it('rejects an item that does not match the element schema', () => {
    expect(() =>
      schema.parse({ items: [{ id: 42 }], pageInfo: { nextCursor: null, hasNextPage: false } }),
    ).toThrow();
  });

  it('requires nextCursor to be present, even when null', () => {
    expect(() => pageInfoSchema.parse({ hasNextPage: false })).toThrow();
  });
});

describe('cursorQuerySchema', () => {
  it('defaults the limit when absent', () => {
    expect(cursorQuerySchema.parse({}).limit).toBe(DEFAULT_PAGE_SIZE);
  });

  // Query strings arrive as strings; without coercion every list endpoint 422s.
  it('coerces a numeric string, as it arrives from a query string', () => {
    expect(cursorQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps the limit so a client cannot request the whole table', () => {
    expect(() => cursorQuerySchema.parse({ limit: MAX_PAGE_SIZE + 1 })).toThrow();
  });

  it('accepts exactly the maximum', () => {
    expect(cursorQuerySchema.parse({ limit: MAX_PAGE_SIZE }).limit).toBe(MAX_PAGE_SIZE);
  });

  it.each([0, -1, 1.5])('rejects a limit of %s', (limit) => {
    expect(() => cursorQuerySchema.parse({ limit })).toThrow();
  });

  it('passes a cursor through', () => {
    expect(cursorQuerySchema.parse({ cursor: 'abc' }).cursor).toBe('abc');
  });
});

describe('sortDirectionSchema', () => {
  it('accepts asc and desc', () => {
    expect(sortDirectionSchema.parse('asc')).toBe('asc');
    expect(sortDirectionSchema.parse('desc')).toBe('desc');
  });

  it('rejects anything else', () => {
    expect(() => sortDirectionSchema.parse('sideways')).toThrow();
  });
});
