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
 * Query parameters for a cursor-paginated list.
 *
 * `limit` is coerced because it arrives from a query string, and capped so a client
 * cannot ask for the entire table in one request.
 */
export const cursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;
