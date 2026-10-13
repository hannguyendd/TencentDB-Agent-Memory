/**
 * stages/resolve-user-id.ts — 4-layer userId fallback + debugForceUserId override.
 *
 * Extracted from the identical ~15-line userId resolve block in the openai-chat + anthropic runners.
 * Semantics:
 *   1. Prefer earlyVerify.userId (already resolved by the auth service)
 *   2. Fall back to headers: x-user-id / x-cb-user-id / x-tdai-user-token
 *   3. debugForceUserId forces an override (local integration debugging)
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";

export interface ResolveUserIdInput {
  c: Context;
  config: ProxyConfig;
  earlyVerifyUserId: string;
  logTag: string;
}

export function stageResolveUserId(input: ResolveUserIdInput): string {
  const { c, config, earlyVerifyUserId, logTag } = input;
  let userId = earlyVerifyUserId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-tdai-user-token")
    || "";
  const debugForceUserId = config.sessionInit?.debugForceUserId;
  if (debugForceUserId) {
    console.log(
      `[${logTag}] DEBUG override userId ${userId || "<empty>"} → ${debugForceUserId}`,
    );
    userId = debugForceUserId;
  }
  return userId;
}
