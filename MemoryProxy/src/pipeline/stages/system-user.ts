/**
 * stages/system-user.ts — systemUser short-circuit stage (Phase 4 stage-ification).
 *
 * Extracted from 4 nearly identical systemUser short-circuit blocks:
 *   - openai-chat runner (line 665-670): body passed in
 *   - anthropic runner (line 691-696): body passed in
 *   - utility runner (line 117-120): no body passed (auxHandler reads it again itself)
 *
 * Semantics (blueprint §5.2):
 *   - hasSystemUsers()=false -> return null directly
 *   - matchSystemUserByUserId matches -> immediately handleSystemUserPassthrough
 *   - no match -> return null so the caller continues the pipeline
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import { handleSystemUserPassthrough } from "../../systemUserPassthrough.js";

/**
 * Check whether a systemUser is hit and passthrough immediately; return null if not hit.
 *
 * @param userId - the already-verified userId (from stageAuth), empty string = unauthenticated, skip
 * @param body   - optional: the already-parsed body from openai-chat/anthropic is passed in,
 *                 handleSystemUserPassthrough serializes and sends it upstream; utility passes undefined.
 */
export async function stageSystemUser(
  c: Context,
  config: ProxyConfig,
  userId: string,
  body?: Record<string, unknown>,
): Promise<Response | null> {
  if (!hasSystemUsers()) return null;
  const sysMatch = matchSystemUserByUserId(userId);
  if (!sysMatch) return null;
  return handleSystemUserPassthrough(c, config, sysMatch, body);
}
