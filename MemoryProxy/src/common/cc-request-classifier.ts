/**
 * Claude Code request classification -- based on the position of the `cache_control`
 * marker in the Anthropic body + tools/thinking fallback, classify all requests the CC client sends to /v1/messages
 * into three kinds: main / fork / sidequery.
 *
 * Criteria (hard constraints from the source + evidence from packet captures):
 *   - MAIN main conversation: the cache_control marker is at messages[n-1] (including the msgs=1 boundary)
 *   - FORK reusing the cache (SUGGESTION/RECAP/COMPACT/...): the marker is at messages[n-2];
 *     the source forkedAgent.ts + claude.ts:3242-3243 forces skipCacheWrite=true, moving the
 *     marker to position n-2 to avoid miscounting cache write cost
 *   - SIDEQUERY independent requests (TITLE/verify_api_key/...): no marker + tools=[] +
 *     thinking.disabled; the source sessionTitle.ts:434 + queryHaiku forcibly turn caching off
 *
 * Fallback for 3P providers that turn caching off: when the body has no marker at all, tools=[] && thinking.disabled
 * are the two hard constraints jointly used to judge sidequery; otherwise default to main -- degrading to the original one-size-fits-all logic, no worse.
 *
 * For detailed design and packet-capture evidence see:
 *   docs/design/2026-07-30-cc-request-routing-plan.md
 */

export type CcRequestKind = "main" | "fork" | "sidequery";

/**
 * Determine the request kind from the Anthropic request body.
 *
 * The input is the body already parsed by the handler (Record<string, unknown>); all field access goes through
 * defensive narrowing, and unknown/malformed bodies always fall back to "main" -- guaranteeing that on a failed determination the behavior
 * is equivalent to the original path.
 */
export function classifyCcRequest(body: Record<string, unknown>): CcRequestKind {
  const rawMsgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  // Filter out non-conversation messages (e.g. role:"system" injected by some CC
  // versions into the messages array). Only user/assistant participate in the
  // cache_control marker position logic that distinguishes main from fork.
  const msgs = rawMsgs.filter((m) => {
    const role = (m as { role?: string })?.role;
    return role === "user" || role === "assistant";
  });
  const n = msgs.length;
  const markerIdx = findLastCacheControlIndex(msgs);

  // Primary determination: cache_control marker position
  if (markerIdx >= 0) {
    // messages[n-2] -> FORK (forced by skipCacheWrite=true)
    if (markerIdx === n - 2) return "fork";
    // Other positions (including last=n-1) -> MAIN
    return "main";
  }

  // No marker: may be a SIDEQUERY, or a MAIN of a 3P provider with caching off
  // Fallback signal: the SIDEQUERY hard constraint is that tools=[] AND thinking.disabled both hit
  //          use && rather than || to avoid hurting main conversations where "the user disabled only tools or only thinking"
  const toolsEmpty = !Array.isArray(body.tools) || (body.tools as unknown[]).length === 0;
  const thinking = body.thinking as { type?: string } | undefined;
  const thinkingOff = thinking?.type === "disabled";
  if (toolsEmpty && thinkingOff) return "sidequery";

  return "main";
}

/**
 * Find the index of the **last** message in the messages array that contains a cache_control marker.
 *
 * In the CC client, cache_control is placed at the content block level (not at the message top level),
 * so every message's content array must be scanned for any block containing a cache_control key.
 * Returns -1 when there is no match.
 */
export function findLastCacheControlIndex(msgs: unknown[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { content?: unknown };
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content as unknown[]) {
      if (b && typeof b === "object" && "cache_control" in (b as object)) return i;
    }
  }
  return -1;
}
