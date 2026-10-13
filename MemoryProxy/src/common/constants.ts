/**
 * Collection of constants reused across handler/pipeline stages.
 *
 * Extracted from the per-handler copies of `SKIP_REQUEST_HEADERS` in handler.ts / anthropicHandler.ts / codexHandler.ts / workbuddyHandler.ts /
 * directHandler.ts / auxiliaryHandler.ts /
 * `SKIP_RESPONSE_HEADERS` (Phase 0.4, 2026-09-28).
 *
 * ## Semantic differences (intentionally preserved)
 *
 * Among the 6 handlers, SKIP_REQUEST_HEADERS has two versions:
 *   - `SKIP_REQUEST_HEADERS_HOP_BY_HOP` (4 items): used by handler/direct/aux, filters only
 *      the RFC 7230 hop-by-hop headers
 *   - `SKIP_REQUEST_HEADERS_WITH_INTERNAL` (5 items): used by anthropic/codex/wb,
 *      adds `x-tdai-user-key` (the proxy's internal identity header) on top of hop-by-hop
 *
 * WARNING: **latent bug (to be fixed uniformly during the Phase 4 migration)**:
 *    direct/aux use the HOP_BY_HOP version, which means that if a client (unlikely scenario) deliberately
 *    sends the `x-tdai-user-key` header, direct/aux would pass it through to the upstream, leaking the proxy's
 *    internal identity to the external API. When Phase 4.1 switches direct/aux into the pipeline, they will uniformly use the
 *    WITH_INTERNAL version, fixing this latent leak along the way. The current Phase 0 keeps backward
 *    compat and does not change behavior.
 *
 * ## Response headers (completely identical)
 *
 * The 4 SKIP_RESPONSE_HEADERS (content-length, content-encoding, transfer-encoding,
 * connection) are identical across the 6 handlers, differing only slightly in order -- semantically equivalent, so they are unified into
 * a single copy.
 */

/**
 * Request header blacklist -- hop-by-hop version (4 items).
 * Original users: handler.ts / directHandler.ts / auxiliaryHandler.ts.
 */
export const SKIP_REQUEST_HEADERS_HOP_BY_HOP: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Request header blacklist -- hop-by-hop + proxy internal identity header (5 items).
 * Original users: anthropicHandler.ts / codexHandler.ts / workbuddyHandler.ts.
 * `x-tdai-user-key` is a header used only by the proxy's internal session-init and must never be passed through upstream.
 */
export const SKIP_REQUEST_HEADERS_WITH_INTERNAL: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-tdai-user-key",
]);

/**
 * Response header blacklist (4 items, completely identical across the 6 handlers).
 * They are stripped because in SSE + chunked encoding scenarios content-length would not match the actual body
 * length, and the client would report a parse error.
 */
export const SKIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/**
 * Copy response headers, stripping the fields in SKIP_RESPONSE_HEADERS.
 * Extracted from the identical implementations in each of the direct/utility/codex/wb runners (Phase 4 stage-ification).
 */
export function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}
