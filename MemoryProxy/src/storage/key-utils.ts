/**
 * key-utils -- ProxyStorage key path generation & validation utilities.
 *
 * See docs/design/2026-07-12-cos-shark-sts-credential-plan.md section 3.2
 * (the directory layout of the original plan 2026-07-10-cos-ttl-nottl-split-plan.md section 4.2 is extended here with a spaceId layer).
 *
 * Directory scheme: <ttl|nottl>/<spaceId>/<userId>/<agentSource>/<sessionId>/<data-type>[/subpath]
 *
 * The spaceId layer was introduced in P4 (kernel-sts) -- STS permissions are isolated by spaceId, so the path also carries a
 * spaceId segment; the key layout aligns with the STS resource `proxy_cache/{ttl|nottl}/{spaceId}/*`.
 *
 * The validity of the four-segment isolation key is validated centrally by this file; each Repo builds keys by generating a
 * prefix via `sessionDirOf` (always ending with `/`), then appending its own data-type segment. Before writing, the segments prone to injection
 * (spaceId / userId / agentSource / sessionId / hookId / skillId) are validated, to prevent
 * `../` path traversal, key collisions from empty segments, and illegal characters in agentSource breaking through the directory layers.
 */

const AGENT_SOURCE_RE = /^[a-z0-9-]+$/;

/**
 * Generic segment validation: non-empty + contains no `/` + contains no `..` substring.
 *
 * The `..` check rejects every case that contains the substring ("..", "foo..bar", "..a" are all rejected), more conservative than only rejecting
 * a full ".." -- in production sessionId / userId / hookId should theoretically never contain two
 * consecutive dots, so the false-positive cost is very low while the injection-prevention value is high.
 */
export function assertKeySegment(name: string, value: string): void {
  if (!value || value.includes("/") || value.includes("..")) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

/**
 * agentSource value-domain validation: `^[a-z0-9-]+$`.
 *
 * Allows lowercase + digit + hyphen, consistent with the format of the first URL path segment
 * (what handler.ts / anthropicHandler.ts parse out of the path is this format).
 * Uppercase, underscore, dot, and slash are all rejected.
 */
export function assertAgentSource(value: string): void {
  if (!AGENT_SOURCE_RE.test(value)) {
    throw new Error(`invalid agentSource: ${value}`);
  }
}

/**
 * Generate the session-level directory prefix: `<bucket>/<spaceId>/<userId>/<agentSource>/<sessionId>/`.
 *
 * The trailing slash is **kept**, so callers can directly concatenate `${sessionDirOf(...)}<datatype>`;
 * directory-level operations (`listNames` / `delPrefix`) also use the return value directly as a prefix.
 *
 * The spaceId segment is fixed right after the bucket (after ttl/nottl); this is the key constraint that lets a lifecycle rule
 * match all spaces with a single prefix -- rules do not support wildcards in the middle of a path.
 */
export function sessionDirOf(
  bucket: "ttl" | "nottl",
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("userId", userId);
  assertAgentSource(agentSource);
  assertKeySegment("sessionId", sessionId);
  return `${bucket}/${spaceId}/${userId}/${agentSource}/${sessionId}/`;
}

/**
 * 2-segment version: `<bucket>/<spaceId>/<sessionId>/`.
 *
 * For BindingRepo -- the bridge must be able to read back the identity from just (spaceId, sessionId);
 * userId/agentSource move into JSON inner fields. See docs/design/2026-08-03-binding-flatten.md.
 * The old 4-segment `sessionDirOf` continues to serve SessionRepo (ttl inj-sess.json), unchanged.
 */
export function sessionBindingDirOf(
  bucket: "ttl" | "nottl",
  spaceId: string,
  sessionId: string,
): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("sessionId", sessionId);
  return `${bucket}/${spaceId}/${sessionId}/`;
}
