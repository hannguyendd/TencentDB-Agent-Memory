/**
 * wiki-constants -- constants, types and pure utility functions of the Wiki asset page.
 * Split out of WikiSourcesPanel.tsx, for reuse by the main panel / detail view / hooks.
 *
 * Generic asset types and formatShortTime have been consolidated into @/lib/asset-common; re-exported here
 * to keep the original import paths unchanged.
 */
import type { WikiDetail } from '@/lib/api/knowledge-api';
export type { SubView, ViewMode, StatusFilter } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/** Wiki only allows uploading Markdown-type files (.md / .markdown / .txt). */
export const WIKI_ALLOWED_FILE_RE = /\.(md|txt|markdown)$/i;

// Wiki status badge: draft=shell created but unprocessed (waiting for the user to click ingest); pending=queued; processing=in progress; ready=ready; failed=failed; missing=KS data lost.
// Uses Tea Tag's semantic theme (soft variant), responds to the theme, and does not use hard-coded palette colors.
export const WIKI_STATUS_THEME: Record<WikiDetail['status'], 'warning' | 'success' | 'error' | 'default'> = {
  draft: 'warning',
  pending: 'warning',
  processing: 'warning',
  ready: 'success',
  failed: 'error',
  missing: 'error',
};
export const WIKI_STATUS_KEY: Record<WikiDetail['status'], string> = {
  draft: 'wiki.status.draft',
  pending: 'wiki.status.pending',
  processing: 'wiki.status.processing',
  ready: 'wiki.status.ready',
  failed: 'wiki.status.failed',
  missing: 'wiki.status.missing',
};

export type WikiScopeTab = 'all' | 'team' | 'fixed' | 'scope';
export const SCOPE_LABEL_KEYS: Record<WikiScopeTab, string> = {
  all: 'wiki.scope.all',
  team: 'wiki.scope.team',
  fixed: 'wiki.scope.fixed',
  scope: 'wiki.scope.scope',
};

export type DetailTab = 'overview' | 'graph' | 'pages' | 'search';

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
}

export const TYPE_COLORS: Record<string, string> = {
  entity: 'var(--tea-color-bg-brand-default)',
  concept: 'var(--tea-color-bg-warning-default)',
  source: 'var(--tea-color-bg-amber-default)',
  query: 'var(--tea-color-bg-success-default)',
  synthesis: 'var(--tea-color-bg-error-default)',
  overview: 'var(--tea-color-bg-yellow-default)',
  comparison: 'var(--tea-color-bg-secondary-active)',
  finding: 'var(--tea-color-bg-warning-default)',
  thesis: 'var(--tea-color-bg-error-default)',
  methodology: 'var(--tea-color-bg-success-default)',
  other: 'var(--tea-color-bg-tertiary-default)',
  raw: 'var(--tea-color-bg-secondary-default)',
};
export const TYPE_COLOR_FALLBACK = 'var(--tea-color-text-tertiary)';
