import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  cursorQuerySchema,
  offsetPaginatedSchema,
  offsetQuerySchema,
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

  // `?limit=` is normal when a client clears a filter. Coercing "" to 0 would fail
  // .positive() and 422 the request instead of falling back to the default.
  it('treats an empty limit as absent rather than zero', () => {
    expect(cursorQuerySchema.parse({ limit: '' }).limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it('treats an empty cursor as absent', () => {
    expect(cursorQuerySchema.parse({ cursor: '' }).cursor).toBeUndefined();
  });
});

describe('offsetQuerySchema', () => {
  it('defaults to the first page', () => {
    const parsed = offsetQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('coerces query strings', () => {
    expect(offsetQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it('treats empty values as absent', () => {
    expect(offsetQuerySchema.parse({ page: '', pageSize: '' }).page).toBe(1);
  });

  it.each([0, -1, 1.5])('rejects a page of %s', (page) => {
    expect(() => offsetQuerySchema.parse({ page })).toThrow();
  });

  it('caps pageSize like the cursor query does', () => {
    expect(() => offsetQuerySchema.parse({ pageSize: MAX_PAGE_SIZE + 1 })).toThrow();
  });
});

describe('offsetPaginatedSchema', () => {
  const schema = offsetPaginatedSchema(z.object({ id: z.string() }));

  it('accepts a well-formed offset page', () => {
    const page = {
      items: [{ id: 'a' }],
      pageInfo: { page: 1, pageSize: 24, totalItems: 1, totalPages: 1 },
    };
    expect(schema.parse(page)).toEqual(page);
  });

  it('allows a genuinely empty result set', () => {
    const page = {
      items: [],
      pageInfo: { page: 1, pageSize: 24, totalItems: 0, totalPages: 0 },
    };
    expect(schema.parse(page)).toEqual(page);
  });

  it('rejects a page number of zero — offset pages are 1-based', () => {
    expect(() =>
      schema.parse({
        items: [],
        pageInfo: { page: 0, pageSize: 24, totalItems: 0, totalPages: 0 },
      }),
    ).toThrow();
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
