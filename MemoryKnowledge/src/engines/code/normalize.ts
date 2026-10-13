/**
 * Git URL normalization — unify SSH/HTTPS/bare paths into the host/namespace/project form.
 *
 * Examples:
 *   git@gitlab.example.com:namespace/project/repo.git      → gitlab.example.com/namespace/project/repo
 *   https://gitlab.example.com/namespace/project/repo.git  → gitlab.example.com/namespace/project/repo
 *   gitlab.example.com/namespace/project/repo              → gitlab.example.com/namespace/project/repo (pass-through)
 */

/**
 * Normalize a Git URL to the `host/path` form (without the .git suffix).
 */
export function normalizeRepoUrl(input: string): string {
  let host: string;
  let path: string;

  // SSH: git@host:path.git
  const sshMatch = input.match(/^(?:ssh:\/\/)?(?:\w+@)([^:/]+)[:/](.+?)(?:\.git)?$/);
  if (sshMatch) {
    host = sshMatch[1];
    path = sshMatch[2];
    return `${host}/${path.replace(/\.git$/, "")}`;
  }

  // HTTPS: https://host/path.git
  const httpsMatch = input.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    host = httpsMatch[1];
    path = httpsMatch[2];
    return `${host}/${path.replace(/\.git$/, "")}`;
  }

  // Already in normalized form (host/namespace/project)
  return input.replace(/\.git$/, "");
}

/**
 * Generate the unique data source key: normalized_url + ":" + branch
 */
export function sourceKey(repo: string, branch: string): string {
  return `${normalizeRepoUrl(repo)}:${branch || "main"}`;
}

/**
 * Extract repo and branch from the unique key
 */
export function parseSourceKey(key: string): { repo: string; branch: string } {
  const lastColon = key.lastIndexOf(":");
  return {
    repo: key.slice(0, lastColon),
    branch: key.slice(lastColon + 1),
  };
}
