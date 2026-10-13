/**
 * Session registration — builds SessionInfo locally, no longer calls TMC.
 *
 * The proxy persists session state independently via SessionStore (L1 memory + L2 Redis/SQLite),
 * so it no longer needs to POST /api/v1/proxy/sessions to write to TMC. User identity comes
 * directly from apiKey → auth/verify.
 */

import type { SessionInfo, SessionRegistrationData } from "./types.js";

/**
 * Build SessionInfo locally (does not call TMC).
 *
 * @param spaceId Kernel instance ID from the request URL path `/proxy/<spaceId>/...`
 *   (e.g. `mem-example001`). The injector uses it for the
 *   `x-tdai-service-id` header when constructing MetadataClient — if it is an empty string,
 *   the kernel returns `invalid_user_key`, which is expected behavior (the caller already
 *   handles it in the session init bypass).
 */
export function buildSessionInfo(
  data: SessionRegistrationData,
  userKey?: string,
  spaceId?: string,
): SessionInfo {
  const now = new Date().toISOString();
  return {
    session_id: data.session_id,
    team_id: data.team_id,
    agent_id: data.agent_id,
    user_id: data.user_id,
    task_id: data.task_id,
    user_key: userKey,
    space_id: spaceId,
    created_at: now,
  };
}