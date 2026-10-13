/**
 * Claude Code AskUserQuestion pagination layout helper.
 *
 * Background: a CC AskUserQuestion question allows at most 4 options. Middle pages must reserve 1
 * slot for "More →", so they hold at most 3 real items; the last page has no MORE and can hold all 4.
 *
 * Strategy:
 *   - total ≤ 4: show everything on a single page (no MORE)
 *   - total > 4: the first N-1 pages hold 3 items each + MORE; the last page holds the rest (∈ [2, 4])
 *
 * Page count: `totalPages = ceil((total - 4) / 3) + 1`
 *   - the first N-1 pages hold 3 items each = 3(N-1) items
 *   - the last page holds total - 3(N-1) items
 *   - solving for N: total - 3(N-1) ∈ [2, 4] ⇔ N - 1 = ceil((total - 4) / 3)
 *
 * Results:
 *   total=4  → [4]                   (single page)
 *   total=5  → [3+MORE, 2]
 *   total=6  → [3+MORE, 3]
 *   total=7  → [3+MORE, 4]           ← last page filled to 4, one page fewer than "3+2+2"
 *   total=8  → [3+MORE, 3+MORE, 2]
 *   total=9  → [3+MORE, 3+MORE, 3]
 *   total=10 → [3+MORE, 3+MORE, 4]   ← last page filled to 4
 *   total=11 → [3+MORE, 3+MORE, 3+MORE, 2]
 *   total=13 → [3+MORE ×3, 4]
 *
 * Each page's count is always ≥ 2 and ≤ 4, so a solo last page never occurs -- the autoSelectSolo* fallback
 * branches in init.ts can no longer reach the MORE paging path (the total===1 case is auto-selected
 * upstream by advanceFromAgentPicked and never reaches the form either).
 *
 * agents and tasks share the same pagination, so behavior is consistent.
 */

/** Hard limit of a CC AskUserQuestion question (including the MORE slot). */
export const CC_MAX_OPTIONS = 4;

/** Number of real options on a non-last page (1 slot reserved for MORE→). */
export const CC_PAGE_SIZE = 3;

/** Single-page threshold: when total ≤ this value, no paging and no MORE; everything is shown on one page. */
export const CC_SINGLE_PAGE_LIMIT = CC_MAX_OPTIONS;

export interface PageSlice {
  /** Element range [start, end) covered by this page; start inclusive, end exclusive -- use directly with slice. */
  start: number;
  end: number;
  /** Whether this page is the last one (the last page does not append a MORE option). */
  isLastPage: boolean;
  /** Number of real options shown on this page (= end - start). */
  count: number;
  /** Total number of pages after pagination (1 when total ≤ 4). */
  totalPages: number;
  /** Total number of elements, handy for callers building hint text. */
  total: number;
}

/**
 * Compute the slice range for `total` items and the target `pageIndex` (0-based).
 *
 * Guarantee: any valid pageIndex returns `count >= 2` (unless total < 2, which is an upstream
 * boundary issue in the form builder, not this function's responsibility).
 *
 * When pageIndex exceeds totalPages-1 it is clamped to the last page (defensive; normal callers first
 * compute safeNextPage using totalPages-1, see the MORE branch in init.ts).
 */
export function computePagination(total: number, pageIndex: number): PageSlice {
  const safeTotal = Math.max(0, total);

  // Single-page threshold: no paging when ≤ CC_SINGLE_PAGE_LIMIT.
  if (safeTotal <= CC_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // When total > 4: the first N-1 pages hold 3 real items each + MORE; the last page holds total - 3(N-1) items (∈ [2, 4]).
  // N - 1 pages at 3 per page need ≥ (total - 4) items (the last page holds at most 4), i.e. N-1 = ceil((total-4) / 3).
  const totalPages = Math.ceil((safeTotal - CC_MAX_OPTIONS) / CC_PAGE_SIZE) + 1;

  // Clamp pageIndex to the valid range (defensive).
  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));

  const isLastPage = idx === totalPages - 1;
  const start = idx * CC_PAGE_SIZE;
  const end = isLastPage ? safeTotal : start + CC_PAGE_SIZE;

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}
