/**
 * GitSourceFetcher — source-code fetch implementation based on simple-git.
 *
 * simple-git internally uses child_process.spawn + an args array, no shell, which eliminates shell injection in principle.
 *
 * Security protections (002 §4-5):
 *   - R1 git hooks: clone/fetch never pulls the remote .git/hooks (hooks are local state), so no extra
 *     core.hooksPath is configured (hardened git rejects that config and needs allowUnsafeHooksPath).
 *   - R2 SSRF: only public HTTPS is allowed + intranet/loopback address blocklist (aligned with the project security_rules).
 *   - Bug fix (plan A): git clean in incremental sync excludes .codegraph/, to avoid deleting the codegraph index DB.
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

/**
 * Recognize git auth / permission errors (simple-git has no TTY; git's interactive Username/Password prompt
 * becomes `could not read Username for '...': No such device or address`).
 *
 * Such errors are highly misleading to users: the essence is that the repo requires authentication (401/403), yet git phrases it as
 * "cannot read username". Identify them centrally here, then in the worker layer convert to a human-readable hint depending on whether credentials were supplied.
 */
export function isGitAuthError(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("could not read username") ||
    msg.includes("could not read password") ||
    msg.includes("authentication failed") ||
    msg.includes("permission denied") ||
    msg.includes("returned error: 401") ||
    msg.includes("returned error: 403") ||
    msg.includes("could not read from remote repository") ||
    msg.includes("unable to access") ||
    msg.includes("remote: you are not allowed")
  );
}

/** Convert a git auth error into a user-facing hint. needsCredential = whether credentials were injected at clone time. */
export function explainGitAuthError(raw: string, needsCredential: boolean): string {
  const brief = raw.split("\n").find((l) => l.trim())?.trim() ?? raw.trim();
  if (needsCredential) {
    return (
      `The access token is invalid or expired, so the repository cannot be fetched (git: ${brief}). ` +
      `Please re-enter the access token in the repository details.`
    );
  }
  return (
    `This repository requires authentication and cannot be cloned as "public" (git: ${brief}). ` +
    `Please delete it and register again, choosing the matching code platform as the source and entering an access token.`
  );
}

/**
 * Intranet / loopback / link-local address blocklist (standard ranges):
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 private ranges
 *   - 169.254.                     → link-local (including cloud metadata 169.254.169.254)
 *   - 127. / 0. / localhost / ::1  → loopback
 *   - fe80:                        → IPv6 link-local
 *
 * This blocklist can be turned off via the env var KNOWLEDGE_SSRF_CHECK=off (see the GitSourceFetcher constructor).
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * Read the SSRF private-network blocklist switch. On by default;
 * turned off when KNOWLEDGE_SSRF_CHECK is off/false/0/no (case-insensitive).
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  /**
   * Whether to enable the SSRF private-network / loopback address blocklist check.
   * Defaults to reading the env var KNOWLEDGE_SSRF_CHECK (on by default); when passed explicitly it takes precedence over the env var.
   */
  ssrfCheck?: boolean;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF private-network blocklist check switch (the https-only protocol check always applies and is unaffected by this switch). */
  private readonly ssrfCheck: boolean;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    // First version: only public HTTPS repos are supported (SSH / private repo auth, see doc 005).
    if (!sourceUrl.startsWith("https://")) {
      throw new Error(
        "first version only supports public HTTPS repos; SSH/private repo support coming soon",
      );
    }
    const host = this.extractHost(sourceUrl);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // R2: SSRF protection — forbid pointing at intranet / loopback addresses (can be turned off via KNOWLEDGE_SSRF_CHECK=off).
    if (this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    // Shallow clone of a single branch. Note: git clone/fetch does not pull the remote .git/hooks (hooks are local state),
    // so a normally cloned repo carries no executable hooks; core.hooksPath is no longer configured here
    // (hardened git rejects that config: needs allowUnsafeHooksPath).
    await simpleGit().clone(sourceUrl, localPath, {
      "--depth": 1,
      "--branch": branch,
    });
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const git = simpleGit(localPath);
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug fix (plan A): clean excludes .codegraph/, otherwise it would delete codegraph's index DB,
    // causing incremental sync to always fail and fall back to a full clone every time.
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── Internal helpers ──

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}
