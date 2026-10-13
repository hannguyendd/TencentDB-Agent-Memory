/**
 * code-constants -- constants, types and pure utility functions of the Code asset page.
 * Split out of CodeSourcesPanel.tsx.
 *
 * Generic asset types and formatShortTime have been consolidated into @/lib/asset-common; re-exported here
 * to keep the original import paths unchanged.
 */
export type { SubView, ViewMode, StatusFilter, ScopeTab } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/**
 * Validate whether it is a valid HTTP(S) Git repository address (regex match).
 * Requirements: http/https protocol, host contains a dot (real domain), path has no spaces and ends with .git.
 * A regex is used rather than URL parsing -- new URL() accepts spaces in the path (e.g. /a b/repo.git)
 * and does not enforce the .git suffix, neither of which fits the strict constraints of code graph registration.
 * SSH (git@...) is not judged true here -- the caller shows a separate "SSH not supported yet" hint.
 */
const GIT_HTTP_URL_RE = /^https?:\/\/[^\s/]+\.[^\s/]+\/[^\s]+\.git$/i;
export function isValidGitHttpUrl(raw: string): boolean {
  return GIT_HTTP_URL_RE.test(raw.trim());
}

/**
 * Extract a readable repository name from a Git URL.
 *
 * repo_name may be empty (legacy data), and falling back to the URL would look very long.
 * Here the last two path segments of the URL are extracted as the `namespace/repo` format:
 *   https://<host>/namespace/repo.git → namespace/repo
 *   https://<host>/org/project.git → org/project
 *   https://<host>/group/sub/repo.git → sub/repo
 * If there is only one path segment, return that segment directly (without the .git suffix).
 * On parse failure, return the original URL (fallback).
 */
export function formatRepoName(repoName: string, repoUrl: string): string {
  if (repoName && !repoName.startsWith('http')) return repoName;
  const url = repoName || repoUrl;
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    if (segments.length === 1) return segments[0];
  } catch {
    // fallback
  }
  return url;
}
