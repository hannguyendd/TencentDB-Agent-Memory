/**
 * Codex `request_user_input` pagination layout — structure copied from
 * `session/claude-code/pagination.ts`, except codex's option limit differs from CC's:
 *
 * - A single codex question has at most **3** options (the client automatically appends "Other" taking 1 slot,
 *   which we must not fill ourselves, so 2 or 3 are actually usable)
 * - Middle pages need to reserve 1 slot for the "MORE →" page-turn → at most 2 real per page
 * - The last page has no MORE → can be filled to 3
 *
 * Strategy:
 *   - total ≤ 3: show everything on a single page (no MORE)
 *   - total > 3: each of the first N-1 pages has 2 real + MORE; the last page takes the rest (∈ [2, 3])
 *
 * Page count: `totalPages = ceil((total - 3) / 2) + 1`
 *   - each of the first N-1 pages has 2 real = 2(N-1) items
 *   - the last page has total - 2(N-1) items
 *
 * Effect:
 *   total=3  → [3]                   (single page)
 *   total=4  → [2+MORE, 2]
 *   total=5  → [2+MORE, 3]           ← last page filled to 3, avoids the solo of "2+2+1"
 *   total=6  → [2+MORE, 2+MORE, 2]
 *   total=7  → [2+MORE, 2+MORE, 3]
 *   total=8  → [2+MORE, 2+MORE, 2+MORE, 2]
 *
 * Per-page count is always ≥ 2 and ≤ 3; the last page is never solo.
 *
 * Shares the same philosophy as CC pagination, only the constants differ (3/2 vs 4/3). Both agents and tasks
 * use this scheme.
 */

/** Hard cap on options for a single codex `request_user_input` question (the client's "Other" slot is separate). */
export const CODEX_MAX_OPTIONS = 3;

/** Number of real options on a non-last page (1 slot reserved for MORE→). */
export const CODEX_PAGE_SIZE = 2;

/** Single-page threshold: when total ≤ this value, no pagination and no MORE. */
export const CODEX_SINGLE_PAGE_LIMIT = CODEX_MAX_OPTIONS;

export interface CodexPageSlice {
  /** Element range [start, end) covered by this page. */
  start: number;
  end: number;
  /** Whether this page is the last page (the last page does not append a MORE option). */
  isLastPage: boolean;
  /** Number of real options shown on this page (= end - start). */
  count: number;
  /** Total pages after pagination (1 when total ≤ 3). */
  totalPages: number;
  /** Total number of elements, so callers can compose hint text. */
  total: number;
}

/**
 * Compute the slice range for `total` items and the target `pageIndex` (0-based).
 *
 * Guarantees: any valid pageIndex returns `count >= 2` (unless total < 2 — that edge case is covered by the
 * upstream form builder).
 *
 * When pageIndex exceeds totalPages-1 it is clamped to the last page (defensive; normal callers first
 * use totalPages-1 to compute safeNextPage).
 */
export function computeCodexPagination(
  total: number,
  pageIndex: number,
): CodexPageSlice {
  const safeTotal = Math.max(0, total);

  if (safeTotal <= CODEX_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // When total > 3: each of the first N-1 pages has 2 real + MORE; the last page takes total - 2(N-1) items (∈ [2, 3]).
  const totalPages =
    Math.ceil((safeTotal - CODEX_MAX_OPTIONS) / CODEX_PAGE_SIZE) + 1;

  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));
  const isLastPage = idx === totalPages - 1;
  const start = idx * CODEX_PAGE_SIZE;
  const end = isLastPage ? safeTotal : start + CODEX_PAGE_SIZE;

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}
