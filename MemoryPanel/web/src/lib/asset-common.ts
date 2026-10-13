/**
 * asset-common - types and pure utility functions shared by the asset (Wiki / Code / Skill / Memory) pages.
 *
 * Previously these types and utilities were each defined repeatedly in wiki-constants.ts / code-constants.ts /
 * memory types.ts; here they are consolidated in one place, and the page files keep
 * their original import paths via re-export.
 */

/** List view toggle: cards / table */
export type ViewMode = 'card' | 'list';

/** List status filter */
export type StatusFilter = 'all' | 'ready' | 'processing' | 'error';

/** Asset page sub-view: list / detail */
export type SubView = 'list' | 'detail';

/** Asset scope: team pool / pinned assets */
export type ScopeTab = 'team' | 'fixed';

/**
 * ISO time string → panel display format (local time zone, 'MM/DD HH:MM').
 * Empty or invalid input → returns '—'.
 * Previously implemented identically in wiki-constants.ts and code-constants.ts, now converged here.
 */
export function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
