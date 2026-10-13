/**
 * Unified pagination (offset style) for metadata list APIs.
 *
 * Input: limit/offset optional; when omitted, defaults to limit=20, offset=0.
 * Output: always a PaginatedResult envelope.
 */
import { z } from "zod";
import type {
  ListPage,
  PaginatedResult,
  PaginationInput,
  PaginationParams,
} from "./types.js";

export const DEFAULT_PAGINATION: PaginationParams = { limit: 20, offset: 0 };

/** Optional pagination fields in the request body (merged into each list schema, with no separate default to avoid odd Zod merge behavior). */
export const paginationInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const paginationResolvedSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Parse pagination input (uses the defaults 20/0 when limit/offset are omitted). */
export function resolvePagination(input?: PaginationInput): PaginationParams {
  return paginationResolvedSchema.parse(input ?? {});
}

/** @deprecated Use resolvePagination */
export function toPaginationParams(input?: PaginationInput): PaginationParams {
  return resolvePagination(input);
}

export function wrapPaginated<T>(
  items: T[],
  total: number,
  pagination: PaginationParams,
): PaginatedResult<T> {
  return {
    items,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

/** Check whether a value is a pagination envelope (Control/SDK parsing stays compatible with legacy bare arrays). */
export function isPaginatedResult<T>(value: unknown): value is PaginatedResult<T> {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && "items" in value
    && Array.isArray((value as PaginatedResult<T>).items)
    && "total" in value
  );
}

/** Unwrap a list response (compatible with PaginatedResult and legacy bare arrays T[]). */
export function unwrapListItems<T>(value: T[] | PaginatedResult<T>): T[] {
  return isPaginatedResult(value) ? value.items : value;
}

/** Unified output of list APIs. */
export function formatListResult<T>(
  page: ListPage<T>,
  pagination: PaginationParams,
): PaginatedResult<T> {
  return wrapPaginated(page.items, page.total, pagination);
}

/** Offset pagination over an already-materialized array (for permission-aggregation scenarios such as listAccessibleAssets). */
export function paginateArray<T>(items: T[], pagination: PaginationParams): PaginatedResult<T> {
  const total = items.length;
  const slice = items.slice(pagination.offset, pagination.offset + pagination.limit);
  return wrapPaginated(slice, total, pagination);
}
