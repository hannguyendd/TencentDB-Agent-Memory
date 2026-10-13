/**
 * Direct passthrough pure helpers (Phase 4.1)。
 *
 * Extracted from the old directHandler.ts (line 70-113); the direct runner and tests both import from here,
 * so the helpers stay side-effect free and can be unit-tested independently.
 */

/** Version segment regex: "v" followed by one or more digits (v1 / v10 ...). */
const VERSION_SEGMENT_RE = /^v\d+$/i;

/** Upstream protocol type. Only these two are observed; other endpoints are passed through as-is. */
export type DirectUpstreamProtocol = "anthropic" | "openai";

/**
 * Parse the upstream target path from a /direct/... request path.
 * Strip the /direct prefix, then the immediately following vN segment; return "" if empty after stripping.
 */
export function stripDirectPrefix(requestPath: string): string {
  const directMatch = requestPath.match(/^\/direct(\/.*)?$/);
  if (!directMatch) return requestPath;
  let rest = directMatch[1] ?? "";
  if (rest === "") return "";
  const firstSegMatch = rest.match(/^\/([^/]+)(\/.*)?$/);
  if (firstSegMatch && VERSION_SEGMENT_RE.test(firstSegMatch[1] ?? "")) {
    rest = firstSegMatch[2] ?? "";
  }
  return rest;
}

/** Upstream URL assembly: upstream.url + stripped path + query string. */
export function buildDirectUpstreamUrl(
  upstreamBase: string,
  requestPath: string,
  requestUrl: string,
): string {
  const stripped = stripDirectPrefix(requestPath);
  const normalizedBase = upstreamBase.replace(/\/+$/, "");
  const pathPart = stripped.startsWith("/") ? stripped : stripped ? `/${stripped}` : "";
  let query = "";
  const qIdx = requestUrl.indexOf("?");
  if (qIdx >= 0) query = requestUrl.slice(qIdx);
  return `${normalizedBase}${pathPart}${query}`;
}

/** Determine the upstream protocol from the stripped path. null = no observation (pure passthrough). */
export function detectProtocol(strippedPath: string): DirectUpstreamProtocol | null {
  const p = strippedPath.replace(/\/+$/, "");
  if (p === "/messages") return "anthropic";
  if (p === "/chat/completions") return "openai";
  return null;
}
