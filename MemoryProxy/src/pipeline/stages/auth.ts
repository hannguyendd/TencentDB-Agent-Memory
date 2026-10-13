/**
 * stages/auth.ts — early-auth stage (Phase 1)。
 *
 * Extracted from 4 nearly identical pieces of code:
 *   - handler.ts:461-471
 *   - anthropicHandler.ts:544-553  (uses extractApiKey to support x-api-key)
 *   - codexHandler.ts:309-323      (explicit fallback x-api-key + compose keyId)
 *   - workbuddyHandler.ts:1108-1124 (same as codex)
 *
 * There are only two differences, both preserved:
 *   1. apiKey extraction source:
 *      - handler only recognizes Bearer
 *      - anthropic/codex/wb support Bearer + x-api-key fallback
 *      - unified strategy: all support the x-api-key fallback; when handler uses Bearer, x-api-key
 *        is always undefined, so behavior is equivalent
 *   2. error envelope format when rejected:
 *      - openai (handler/codex/wb): `{error: "..."}`
 *      - anthropic:                 `{type:"error",error:{type,message}}`
 *      - decided by the caller (protocol.buildErrorResponse); this stage only returns the rejected result
 *
 * WARNING: order preserved: verifyUserKey must come before body parse; rejected traffic does not consume the body reader.
 */

import type { Context } from "hono";
import { verifyUserKey } from "../../auth.js";
import { extractBearerToken, apiKeyToKeyId } from "../../opik.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";

export interface AuthStageResult {
  /** Raw API key extracted from Bearer/x-api-key */
  apiKey: string;
  /** guaranteed non-empty when rejected=false; the userId returned by verifyUserKey or the fallback keyId */
  keyId: string;
  /** userId returned by verifyUserKey (may be an empty string) */
  userId: string;
  /** spaceId extracted from the URL (may be an empty string) */
  spaceId: string;
  /** only meaningful when rejected=true, semantics consistent with verifyUserKey */
  rejected: boolean;
  rejectReason?: string;
}

/**
 * API key extraction mode (the 4 old handlers all differed; preserved during migration):
 *   - "bearer-only" (handler.ts): only recognizes Bearer, ignores x-api-key
 *   - "bearer-first" (codex/wb/utility): Bearer first, x-api-key as fallback
 *   - "xapi-first" (anthropic): x-api-key first, Bearer as fallback
 * These three modes produce different results when both headers are present (anthropic uses x-api-key,
 * codex/wb use Bearer). The stage must explicitly support all 3.
 */
export type ApiKeyExtractionMode = "bearer-only" | "bearer-first" | "xapi-first";

/**
 * Extract the API key from the Hono Context.
 */
export function extractApiKeyFromContext(
  c: Context,
  mode: ApiKeyExtractionMode = "bearer-first",
): string {
  const xApiKey = c.req.header("x-api-key");
  const bearer = extractBearerToken(
    c.req.header("authorization") ?? c.req.header("Authorization") ?? "",
  );
  if (mode === "xapi-first") {
    if (xApiKey) return xApiKey;
    return bearer ?? "";
  }
  if (mode === "bearer-only") {
    return bearer ?? "";
  }
  // bearer-first (default)
  if (bearer) return bearer;
  if (xApiKey) return xApiKey;
  return "";
}

/**
 * Early auth stage — runs before body parsing; rejected requests short-circuit.
 *
 * When it returns `rejected: true`, the caller should immediately use protocol.buildErrorResponse
 * to generate a 401 and not proceed further.
 */
export async function stageAuth(
  c: Context,
  mode: ApiKeyExtractionMode = "bearer-first",
): Promise<AuthStageResult> {
  const apiKey = extractApiKeyFromContext(c, mode);
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const verify = await verifyUserKey(apiKey, spaceId);
  if (verify.rejected) {
    return {
      apiKey,
      keyId: "",
      userId: "",
      spaceId,
      rejected: true,
      rejectReason: verify.rejectReason,
    };
  }
  const userId = verify.userId;
  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");
  return { apiKey, keyId, userId, spaceId, rejected: false };
}
