/**
 * Service-to-service auth middleware.
 *
 * Model (aligned with the Layer 1 Bearer semantics of the MemoryCore gateway):
 *   - KNOWLEDGE_SERVICE_KEY empty     → auth disabled, everything allowed (backward compatible with local/dev deployments);
 *   - KNOWLEDGE_SERVICE_KEY non-empty → all endpoints under /v3 except the read-only allowlist require
 *     `Authorization: Bearer <serviceKey>`; missing/wrong is always 401 (fail-closed).
 *
 * The read-only allowlist (Agent direct-access surface) stays open:
 *   tools/list, tools/call (Agent self-discovery and read-only tool execution), wiki/code-graph query endpoints,
 *   source-credential/status (metadata contains no secret), source-provider list,
 *   auto-sync/status。
 * Note: although llm-binding status/list do not echo the api_key in plaintext, they expose the binding's
 * existence and base_url (reconnaissance value), so they are not allowlisted — the only caller, Panel, always carries the key.
 * Write/admin surface (wiki ingest, raw/page write, llm-binding/set, source-credential/put,
 * auto-sync/trigger, etc.) always requires the key — newly added endpoints are protected by default.
 *
 * /health, /docs, /openapi.json are mounted outside the api sub-app (server.ts) and are not affected by this middleware.
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { wrapError } from "../api-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

export interface KnowledgeAuthConfig {
  serviceKey: string;
}

/**
 * Timing-safe string comparison. When lengths differ it still performs a comparison against itself,
 * to avoid leaking the key length via response timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Read-only allowlist (paths relative to apiPrefix, e.g. "/tools/list").
 * These endpoints still need no auth after a key is enabled.
 */
const READONLY_POST_PATHS: ReadonlySet<string> = new Set([
  // Agent self-discovery + read-only tool execution (search_wiki / query_code_graph, etc.)
  "/tools/list",
  "/tools/call",
  // wiki query endpoints
  "/wiki/get",
  "/wiki/list",
  "/wiki/raw/ls",
  "/wiki/raw/read",
  "/wiki/page/ls",
  "/wiki/page/read",
  "/wiki/graph",
  "/wiki/search",
  // code-graph query endpoints
  "/code-graph/list",
  "/code-graph/get",
  // Note: /internal/llm-binding/* all require the key (including status/list) —
  // although they do not echo the api_key in plaintext, they expose binding existence and base_url;
  // the only caller is Panel (which carries KNOWLEDGE_AUTH_TOKEN), see ensure-knowledge-llm-binding.
]);

const READONLY_GET_PATHS: ReadonlySet<string> = new Set([
  "/source-credential/status", // metadata, no secret
  "/auto-sync/status",
]);

/** Everything under source-provider is a GET read-only list endpoint; allowed by prefix. */
const READONLY_GET_PREFIXES: readonly string[] = ["/source-provider"];

export function isReadonlyPath(method: string, path: string): boolean {
  if (method === "POST") return READONLY_POST_PATHS.has(path);
  if (method === "GET") {
    return READONLY_GET_PATHS.has(path) || READONLY_GET_PREFIXES.some((p) => path.startsWith(p));
  }
  return false;
}

/** Pure function: check whether the Authorization header is `Bearer <serviceKey>`. */
export function verifyBearer(authHeader: string | undefined, serviceKey: string): boolean {
  if (!authHeader) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
  if (!m) return false;
  return safeEqual(m[1], serviceKey);
}

/**
 * Hono middleware factory. Mounted on the /v3 sub-app (server.ts),
 * c.req.path is the full path; strip apiPrefix first, then match the allowlist.
 */
export function createServiceAuthMiddleware(
  cfg: KnowledgeAuthConfig,
  apiPrefix: string,
): MiddlewareHandler {
  return async (c, next) => {
    // No key configured = auth disabled (backward compatible; a posture warn log is emitted at startup)
    if (!cfg.serviceKey) return next();

    const full = c.req.path;
    const path = full.startsWith(apiPrefix) ? full.slice(apiPrefix.length) : full;
    if (isReadonlyPath(c.req.method, path)) return next();

    if (verifyBearer(c.req.header("authorization"), cfg.serviceKey)) return next();

    log.warn(`rejected unauthenticated request: ${c.req.method} ${full}`);
    return c.json(wrapError(401, "unauthorized: valid service key required"), 401);
  };
}
