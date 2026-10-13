/**
 * TdaiMemoryToolsInjector — inject a static `<tdai_memory_tools>` text block
 * that teaches the LLM to curl `<proxy>/memory-bridge/v3/*` for TDAI memory
 * read operations.
 *
 * Same design shape as skill-tools-injector (see docs/design/2026-06-17-team-skill-proxy-runtime.md §4):
 *
 *   Why static (NOT native tool defs):
 *     the agent host (IDE / Claude Code) does not recognize native tools; instead let the LLM use the existing Bash
 *     tool to curl a proxy path, the proxy reverse-proxies to the tdai gateway, injecting
 *     IdFields + Bearer in between, ruling out the LLM forging identity + preventing tokens from entering the prompt.
 *
 *   Tool set (**read-only**, statically injected into the system prompt, cache friendly):
 *     - tdai_memory_search       L1 dual-path hybrid search (atomic/search)
 *     - tdai_atomic_query        L1 by type / time / pagination (atomic/query)
 *     - tdai_conversation_search L0 conversation hybrid search (conversation/search)
 *     - tdai_conversation_query  L0 fetch history by session (conversation/query)
 *     - tdai_scenario_ls         L2 list the scene_blocks path index
 *     - tdai_read_scene          L2 read the full text by path
 *
 *   Design trade-offs:
 *     - L0/L1 are **no longer auto-recalled every round** and injected into the user prompt (it would break the KV/prompt cache);
 *       instead static tools retrieve on demand; stable system prompt -> hits the prompt cache.
 *     - L3 (persona) is **injected directly** into the system by tdai-profile-memory-injector, no tool needed.
 *     - The L2 index is also injected directly into the system (`<l2_scene_index>`); the body is read on demand with read_scene.
 *
 *   Write operations (atomic/update / conversation/delete / scenario/write / scenario/rm / core/write)
 *   are not in the bridge allowlist; writes are controlled by the main-path injector.
 *
 *   Injection point: `system.suffix` (unlike skill's `tools.append`, because we no longer use
 *   native tools). A note is appended at the end of the system prompt, telling the LLM that these endpoints
 *   exist and how to call them.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";

export interface TdaiMemoryToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every curl recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
}

/** Renders the whole `<tdai_memory_tools>` text; a pure function for ease of testing. */
export function renderTdaiMemoryToolsBlock(
  proxyBaseUrl: string,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/memory-bridge/v3`;
  // The gateway requires `x-tdai-service-id: <spaceId>` to let requests through; `x-conversation-id`
  // lets the proxy reuse the identity in the session (user_id / team_id / agent_id).
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  const lines: string[] = [
    "<tdai_memory_tools>",
    "**These are memory capabilities you can actively call** (not documentation), used via Bash + curl.",
    "This set of TDAI memory capabilities has the same priority as Claude Code's native Memory/MEMORY.md; when memory is involved, do not check only the local MEMORY.md.",
    "When the user asks about identity/history/preferences/past conclusions/project conventions, you must first query with the TDAI memory tools below, then answer based on the query results.",
    "Do not say \"I don't have this tool / MCP is needed / I can only check local memory\" -- you have the TDAI memory tools, so use the curl commands below.",
    "",
    "How to call: run curl in Bash against the proxy's memory-bridge path. The proxy automatically injects identity auth (team_id/user_id/agent_id), so the body only needs business fields. If the current Agent is bound to multiple chat_memory, search-type interfaces by default search self + imported memories together, and return source_agent_id/source_agent_name/source_agent_role in the results.",
    "",
    "Coverage:",
    "- L3 (persona long-term profile) and the L2 scene index (`<l2_scene_index>`) are already injected directly into the system, no query needed;",
    "- L2 body: read on demand with tdai_read_scene;",
    "- L0/L1 (raw conversations / atomic memories) are **no longer auto-recalled every round** (it would break the KV cache); actively call the tools to retrieve when needed.",
    "",
    "  <tool name=\"tdai_memory_search\">",
    `    curl: ${bridge}/atomic/search`,
    `    body: {"query": "<text>", "limit": 5}`,
    "    use:  Search L1 atomic memories (dual-path hybrid: dense vector + BM25), sorted by relevance. By default searches across the current Agent's self + imported memories; source_agent_* in the returned items indicates the source. Suitable for recalling user preferences, historical conclusions, rules, etc.",
    "    returns: {code, data: {items: [...], searched_agents: [...]}} — hits are in data.items[].",
    "  </tool>",
    "",
    "  <tool name=\"tdai_atomic_query\">",
    `    curl: ${bridge}/atomic/query`,
    `    body: {"type": "?episodic|persona|instruction", "limit": 20, "offset": 0, "time_start": "?ISO", "time_end": "?ISO"}`,
    "    use:  Fetch L1 memories by type / time window / pagination (no semantic retrieval).",
    "  </tool>",
    "",
    "  <tool name=\"tdai_conversation_search\">",
    `    curl: ${bridge}/conversation/search`,
    `    body: {"query": "<text>", "limit": 5, "session_id": "?<sid>"}`,
    "    use:  Search within L0 raw conversations (finer-grained than atomic_search, for finding the original text of specific messages / quotes / timelines). By default searches across the current Agent's self + imported memories; source_agent_* in the returned items indicates the source.",
    "    returns: {code, data: {messages: [...], searched_agents: [...]}} — hits are in data.messages[] (note: different from data.items of atomic_search).",
    "  </tool>",
    "",
    "  <tool name=\"tdai_conversation_query\">",
    `    curl: ${bridge}/conversation/query`,
    `    body: {"session_id": "<sid>", "limit": 50, "offset": 0}`,
    "    use:  Fetch L0 history messages in session order.",
    "  </tool>",
    "",
    "  <tool name=\"tdai_scenario_ls\">",
    `    curl: ${bridge}/scenario/ls`,
    `    body: {"path_prefix": "?optional prefix"}`,
    "    use:  List the L2 scene_blocks path index (with summary, without body). Normally the system already injects the index; use only when a refresh / prefix filtering is needed.",
    "  </tool>",
    "",
    "  <tool name=\"tdai_read_scene\">",
    `    curl: ${bridge}/scenario/read`,
    `    body: {"path": "<scene path>", "agent_id": "?from <agent agent_id=...>, pass when reading imported memories"}`,
    "    use:  Read the full text of an L2 scene file by path. The path must first be obtained from `<l2_scene_index>` or tdai_scenario_ls; do not construct it out of thin air; when reading a path in an imported_from segment, include that segment's agent_id.",
    "  </tool>",
    "",
    "## Call constraints",
    "- These are read-only tools; to modify L1/L2/L3 you must use the main path (agent_id is attributed automatically).",
    "- In each conversation round, atomic_search + conversation_search **total ≤ 3 calls**;",
    "  query / ls / read_scene do not count toward the limit, but do not read the same path repeatedly.",
    "- Failure retry: HTTP 5xx may be retried once; do not retry HTTP 4xx.",
    "- Every curl must carry: " +
      (spaceId ? `x-tdai-service-id: ${spaceId}, ` : "x-tdai-service-id (the current memory instance, see example), ") +
      (sessionId ? `x-conversation-id: ${sessionId}` : "x-conversation-id (from the current session)") +
      "; Content-Type: application/json.",
    "",
    "## Full example",
    "```bash",
    `curl -sfk -X POST ${bridge}/atomic/search \\`,
    `  -H 'Content-Type: application/json'${authHeader} \\`,
    `  -d '{"query": "user preferred programming language", "limit": 5}'`,
    "```",
    "</tdai_memory_tools>",
  ];

  return lines.join("\n");
}

export class TdaiMemoryToolsInjector implements InjectionHook {
  id = "tdai-memory-tools-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "before" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 5;
  description = "Inject <tdai_memory_tools> curl recipes block into system prompt";
  /** Static tool instructions are session-stable; render once at session_init. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private cfg: TdaiMemoryToolsInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    // Identity not recognized -> do not inject (even if the LLM calls curl, the bridge would return 401)
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];
    const session = (ctx.metadata.custom as Record<string, unknown> | undefined)?.session as
      | Record<string, unknown>
      | undefined;
    const spaceId = typeof session?.space_id === "string" ? session.space_id : undefined;
    return this.renderBlocks(identity.sessionId, spaceId);
  }

  prewarm(input: PrewarmInput): ContextBlock[] {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocks(input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(sessionId: string, spaceId?: string): ContextBlock[] {
    return [{
      type: "text",
      content: renderTdaiMemoryToolsBlock(this.cfg.proxyBaseUrl, sessionId, spaceId),
      metadata: {
        source: this.id,
        sessionId,
        cacheKey: "tdai-memory-tools-injector:tools",
      },
    }];
  }
}

/** @deprecated legacy API compatibility name */
export const TdaiToolsInjector = TdaiMemoryToolsInjector;
