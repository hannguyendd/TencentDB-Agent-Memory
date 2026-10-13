/**
 * chat-memory-governance.ts -- ownership / sharing data model specific to the chat_memory asset.
 *
 * Not shared with skill / wiki / code: each asset type has a different ownership model, and forcing an abstraction would hold back future work.
 *
 * Data shape:
 *   Each Agent carries a ChatMemoryAgentRel (sharing switch + imports <= 2)
 *
 * Persistence:
 *   The backend schema does not yet have a real chat_memory_rel field; for the demo phase it is stored in
 *   the "chat_memory" namespace of Agent.metadata_json, sharing the same contract with the frontend.
 *   Once the backend adds the field, switch the readChatMemoryRel / writeChatMemoryRel implementations to the real field.
 */

/** Import limit -- specific to chat_memory. Other assets define their own if they ever get an import concept. */
export const MAX_IMPORTED_AGENTS = 2;

export interface ChatMemoryAgentRel {
  /** Whether its own memory is visible to the whole team. This release's UI locks it to true ("show globally whenever it exists"). */
  memory_shared_with_team: boolean;
  /** Imported agent_ids (<= MAX_IMPORTED_AGENTS, must be in the same team, exclude self, deduplicated). */
  imported_agent_ids: string[];
}

export const DEFAULT_CHAT_MEMORY_REL: ChatMemoryAgentRel = {
  memory_shared_with_team: true,
  imported_agent_ids: [],
};

export type ValidateResult = { ok: true } | { ok: false; reason: string };

/** Rules for validating self's imported ids; shared by frontend and backend. */
export function validateImportedAgents(
  selfId: string,
  ids: string[],
  teamAgents: Array<{ agent_id: string }>,
): ValidateResult {
  if (!Array.isArray(ids)) return { ok: false, reason: 'imported_agent_ids must be an array' };
  if (ids.length > MAX_IMPORTED_AGENTS) {
    return { ok: false, reason: `At most ${MAX_IMPORTED_AGENTS} agents can be imported` };
  }
  const teamSet = new Set(teamAgents.map((a) => a.agent_id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || typeof id !== 'string') return { ok: false, reason: 'Invalid agent_id present' };
    if (id === selfId) return { ok: false, reason: 'Cannot import its own memory' };
    if (!teamSet.has(id)) return { ok: false, reason: `agent_id "${id}" is not in the current team` };
    if (seen.has(id)) return { ok: false, reason: 'Duplicate agent in the import list' };
    seen.add(id);
  }
  return { ok: true };
}

const METADATA_NS = 'chat_memory';

interface AgentLike {
  agent_id: string;
  metadata_json?: string;
}

/** Read chat_memory_rel from the Agent; returns the default when missing. Never throws. */
export function readChatMemoryRel(agent: AgentLike): ChatMemoryAgentRel {
  if (!agent.metadata_json) return { ...DEFAULT_CHAT_MEMORY_REL };
  try {
    const meta = JSON.parse(agent.metadata_json) as Record<string, unknown>;
    const slot = meta?.[METADATA_NS];
    if (slot && typeof slot === 'object') {
      return normalizeRel(slot as Partial<ChatMemoryAgentRel>);
    }
  } catch {
    /* Old value invalid, use the default */
  }
  return { ...DEFAULT_CHAT_MEMORY_REL };
}

/** Merge chat_memory_rel back into metadata_json and return the new JSON string (input not modified). */
export function writeChatMemoryRel(
  prevMetadataJson: string | undefined,
  rel: ChatMemoryAgentRel,
): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* discard */
    }
  }
  meta[METADATA_NS] = normalizeRel(rel);
  return JSON.stringify(meta);
}

function normalizeRel(input: Partial<ChatMemoryAgentRel>): ChatMemoryAgentRel {
  return {
    memory_shared_with_team:
      typeof input.memory_shared_with_team === 'boolean'
        ? input.memory_shared_with_team
        : DEFAULT_CHAT_MEMORY_REL.memory_shared_with_team,
    imported_agent_ids: Array.isArray(input.imported_agent_ids)
      ? Array.from(new Set(input.imported_agent_ids.filter((x) => typeof x === 'string'))).slice(
          0,
          MAX_IMPORTED_AGENTS,
        )
      : [],
  };
}
