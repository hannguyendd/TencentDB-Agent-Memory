/**
 * chat_memory asset ID generation rules.
 *
 * Convention: each (team, agent) combination corresponds to **one** stable chat_memory asset, and asset_id
 * is composed from team_id and agent_id:
 *
 *     chat_memory-{team_id}-{agent_id}
 *
 * This deterministic ID makes the write path automatically idempotent -- no matter how many times the same (team, agent) is requested,
 * the computed asset_id is the same, and the store layer's primary key constraint naturally blocks duplicate inserts.
 *
 * Forward composition needs no reverse parsing. `/v3/chat-memory/clear` needs to locate (team, agent)
 * from asset_id to clear the content, but **does not split the string** -- team_id / agent_id may both
 * contain `-`, and splitting would be ambiguous. Reverse lookup always goes through `resolveChatMemoryAgentId`:
 * take the asset's known team_id + a candidate agent_id, compose forward and compare; a hit confirms it.
 */

/** chat_memory asset ID prefix. */
export const CHAT_MEMORY_ASSET_PREFIX = "chat_memory-";

/** Stably generate the chat_memory asset ID for a (team, agent). */
export function buildChatMemoryAssetId(teamId: string, agentId: string): string {
  return `${CHAT_MEMORY_ASSET_PREFIX}${teamId}-${agentId}`;
}

/**
 * Find the agent_id that matches assetId among the candidate agent list.
 *
 * Uses forward-composition comparison rather than splitting the string, so it stays correct when team_id / agent_id contain `-`.
 *
 * @param assetId    chat_memory asset ID
 * @param teamId     team_id on the asset record (authoritative value; not guessed from assetId)
 * @param agentIds   candidate agent_id list under this team
 * @returns          the matching agent_id; undefined if none match
 */
export function resolveChatMemoryAgentId(
  assetId: string,
  teamId: string,
  agentIds: Iterable<string>,
): string | undefined {
  for (const agentId of agentIds) {
    if (buildChatMemoryAssetId(teamId, agentId) === assetId) return agentId;
  }
  return undefined;
}
