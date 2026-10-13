/**
 * SourceFetcher interface layer — protocol-agnostic abstraction for source fetching and security validation.
 *
 * Responsibility: abstract "fetching code from some source (git/local/ftp) to a local directory" into a unified interface,
 * with security validation (protocol allowlist + SSRF protection) centralized in each implementation's validate().
 * Concrete implementations (e.g. GitSourceFetcher) depend on simple-git, but that dependency does not leak into this interface layer.
 */

export type SourceType = "git" | "local" | "ftp";

export interface FetchResult {
  /** Local directory where the source code is written to disk (absolute path). */
  localPath: string;
  /** Current version identifier (for git, the first 12 chars of the commit hash; null if unavailable). */
  version: string | null;
  /** Source protocol type. */
  sourceType: SourceType;
}

/**
 * Source fetcher interface. Implementers are responsible for:
 *   1. Validating sourceUrl safety (protocol allowlist, SSRF, etc.)
 *   2. Fetching/syncing the source to localPath
 *   3. Returning the version identifier
 *
 * Implementations:
 *   - GitSourceFetcher: simple-git, first version only public HTTPS (SSH/private repo auth, see doc 005)
 *   - LocalSourceFetcher / FtpSourceFetcher: future extensions
 */
export interface ISourceFetcher {
  /** First fetch: download the source to localPath. */
  fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult>;

  /** Incremental sync: update the existing localPath to the latest version. */
  sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult>;

  /** Validate whether sourceUrl is legal (protocol allowlist + SSRF protection). Throws if illegal. */
  validate(sourceUrl: string): void;

  /** Supported protocol types. */
  readonly supportedType: SourceType;
}
