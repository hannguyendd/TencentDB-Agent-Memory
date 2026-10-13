/**
 * clone-url -- low-level URL basic-auth utilities + provider-aware dispatch entry.
 *
 * Layering:
 *   - `injectBasicAuth`: pure `https://<user>:<pass>@host/...` encoding, no business logic
 *   - `buildCloneUrl`: entry point. provider.applyToCloneUrl override -> use provider;
 *     otherwise delegate to provider.authMethod.buildCloneUrl (bearer/basic handle it respectively)
 */

import type { CredentialPayload, ICodeSourceProvider } from "./types.js";

export class CloneUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneUrlError";
  }
}

/**
 * Low-level URL basic-auth encoding utility (no business logic, does not branch on kind).
 *
 * Input `{user, pass}` and repo URL -> output `https://<user>:<pass>@host/...`.
 * Both user and pass are URL-encoded; only https is allowed.
 */
export function injectBasicAuth(
  repoUrl: string,
  auth: { user: string; pass: string },
): string {
  const cleanUrl = stripCredentials(repoUrl);
  const url = tryParse(cleanUrl);
  if (!url) throw new CloneUrlError(`invalid repo URL: ${repoUrl}`);
  if (url.protocol !== "https:") {
    throw new CloneUrlError(`repo URL must be https:// (got ${url.protocol}//)`);
  }
  if (!auth.user) throw new CloneUrlError("basic-auth user is required");
  if (!auth.pass) throw new CloneUrlError("basic-auth pass is required");
  url.username = encodeURIComponent(auth.user);
  url.password = encodeURIComponent(auth.pass);
  return url.toString();
}

/**
 * Strip the credentials out of the URL (the clean address written back to .git/config after clone completes).
 * Idempotent: a clean address passed in is returned as is.
 */
export function stripCredentials(repoUrl: string): string {
  const url = tryParse(repoUrl);
  if (!url) return repoUrl;
  url.username = "";
  url.password = "";
  return url.toString();
}

function tryParse(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * Provider-aware dispatch entry.
 *
 * Priority:
 *   1. `provider.applyToCloneUrl` (provider takes over completely)
 *   2. `provider.authMethod.buildCloneUrl` (default, dispatched by auth method)
 */
export function buildCloneUrl(
  provider: ICodeSourceProvider,
  repoUrl: string,
  cred: CredentialPayload,
): string {
  if (provider.applyToCloneUrl) {
    return provider.applyToCloneUrl(repoUrl, cred);
  }
  return provider.authMethod.buildCloneUrl(repoUrl, cred, provider.cloneUsername);
}
