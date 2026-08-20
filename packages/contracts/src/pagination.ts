import { z } from 'zod';

/**
 * The one pagination envelope. Every list endpoint uses it; a module inventing its
 * own shape is drift even though it compiles (SPEC.md §6.5).
 */
export const pageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

export type PageInfo = z.infer<typeof pageInfoSchema>;

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    pageInfo: pageInfoSchema,
  });
}

export interface Paginated<T> {
  items: T[];
  pageInfo: PageInfo;
}

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;

/**
 * Treats an absent, empty or null query value as "not supplied" so the default
 * applies.
 *
 * `?limit=` is a normal thing for a client to emit when a filter is cleared. Without
 * this, the empty string coerces to 0, fails `.positive()`, and the request 422s
 * instead of falling back to the default page size.
 */
const optionalQueryValue = (value: unknown): unknown =>
  value === '' || value === null ? undefined : value;

/** Query parameters for a cursor-paginated list. */
export const cursorQuerySchema = z.object({
  cursor: z.preprocess(optionalQueryValue, z.string().optional()),
  limit: z.preprocess(
    optionalQueryValue,
    z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  ),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/**
 * Offset pagination, permitted by SPEC.md §6.5 only for admin tables that genuinely
 * need page numbers.
 *
 * It exists here so E8's admin tables reuse one shape rather than each inventing its
 * own — the drift that CLAUDE.md § Contracts rule 5 forbids. Storefront list
 * endpoints must still use the cursor envelope above.
 */
export const offsetPageInfoSchema = z.object({
  page: z.int().positive(),
  pageSize: z.int().positive(),
  totalItems: z.int().nonnegative(),
  totalPages: z.int().nonnegative(),
});

export type OffsetPageInfo = z.infer<typeof offsetPageInfoSchema>;

export function offsetPaginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    pageInfo: offsetPageInfoSchema,
  });
}

export interface OffsetPaginated<T> {
  items: T[];
  pageInfo: OffsetPageInfo;
}

/**
 * Derives the database `skip` for an offset page. Pages are 1-based.
 *
 * Provided so every admin table does not hand-roll `(page - 1) * pageSize` — the
 * off-by-one there is easy to write and hard to notice, because page 1 looks correct
 * either way.
 */
export function offsetSkip(query: OffsetQuery): number {
  if (query.page < 1) throw new RangeError('page is 1-based; received ' + String(query.page));
  if (query.pageSize <= 0) throw new RangeError('pageSize must be positive');
  return (query.page - 1) * query.pageSize;
}

/**
 * Total pages for a result set. Zero items means zero pages, not one — an empty
 * table should not report "page 1 of 1".
 */
export function totalPages(totalItems: number, pageSize: number): number {
  if (pageSize <= 0) throw new RangeError('pageSize must be positive');
  return Math.ceil(totalItems / pageSize);
}

export const offsetQuerySchema = z.object({
  page: z.preprocess(optionalQueryValue, z.coerce.number().int().positive().default(1)),
  pageSize: z.preprocess(
    optionalQueryValue,
    z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  ),
});

export type OffsetQuery = z.infer<typeof offsetQuerySchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;
