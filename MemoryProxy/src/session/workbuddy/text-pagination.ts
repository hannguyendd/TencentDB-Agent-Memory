/**
 * text-pagination.ts — standalone pagination for text mode.
 *
 * Differences from card mode (claude-code/pagination.ts):
 *   - Card mode: 3 real items per page + 1 MORE slot (limited by AskUserQuestion's hard cap of 4 options)
 *   - Text mode: 10 real items per page, no MORE slot (markdown has no limit; paging is driven by `next/prev` keywords)
 *
 * Reuses the formData.pageIndex field: card mode and text mode **never coexist** (capability detection decides which path),
 * so the same pageIndex field can be used independently on each side, with no need to introduce textPageIndex.
 *
 * Boundaries:
 *   - items is empty → currentPageItems = [], totalPages = 1, isEmpty = true
 *   - pageIndex out of range (negative / past the end) → clamped to [0, totalPages-1], no throw
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** Number of options shown per page in text mode (excluding keyword action hints such as next/prev/skip). */
export const TEXT_PAGE_SIZE = 10;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TextPagination<T> {
  /** Items to render on the current page (may be a subset of all items). */
  currentPageItems: T[];
  /** Total number of pages (defined as 1 when items is empty, so the render layer can show "Page 1 of 1"). */
  totalPages: number;
  /** Current page number (0-based, clamped to the valid range). */
  currentPageIndex: number;
  /** Whether items is empty. */
  isEmpty: boolean;
  /** Whether there is a next page (used to render the `next` keyword hint). */
  hasNext: boolean;
  /** Whether there is a previous page (used to render the `prev` keyword hint). */
  hasPrev: boolean;
  /** Absolute index of the first item of the current page within items (0-based, used for rendering numbering). */
  offset: number;
}

// ── Compute ────────────────────────────────────────────────────────────────────

/**
 * Compute text-mode pagination info.
 *
 * @param items      - the full items list
 * @param pageIndex  - the requested page number (0-based, may be out of range; clamped internally)
 * @param pageSize   - page size, defaults to TEXT_PAGE_SIZE
 */
export function computeTextPagination<T>(
  items: readonly T[],
  pageIndex = 0,
  pageSize: number = TEXT_PAGE_SIZE,
): TextPagination<T> {
  const total = items.length;
  const safePageSize = Math.max(1, pageSize | 0);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));

  const rawIdx = Number.isFinite(pageIndex) ? Math.trunc(pageIndex) : 0;
  const currentPageIndex = Math.max(0, Math.min(rawIdx, totalPages - 1));

  const offset = currentPageIndex * safePageSize;
  const currentPageItems = items.slice(offset, offset + safePageSize);

  return {
    currentPageItems,
    totalPages,
    currentPageIndex,
    isEmpty: total === 0,
    hasNext: currentPageIndex < totalPages - 1,
    hasPrev: currentPageIndex > 0,
    offset,
  };
}
