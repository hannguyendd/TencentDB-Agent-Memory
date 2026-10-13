import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { TdaiClient } from "../../tdai/client.js";
import type { TdaiMemoryConfig } from "../../tdai/types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./tdai-fixed-asset.js";

/**
 * L2/L3 injection (refactored following the official openclaw / hermes approach):
 *   - L3 (persona) -> inject the full content (stable and usually short, as the long-term persona)
 *   - L2 (scenarios) -> **only inject the Scene Navigation index (path list + summary)**,
 *     without pre-reading the full text. When the LLM needs details it actively calls the `tdai_read_scene` tool to fetch by path.
 *   - Also attach the memory-tools-guide text, telling the LLM how to use the tools + the call limits.
 *
 * This allows:
 *   1. Greatly reducing first-round token consumption (L2 full text is often thousands of chars x N)
 *   2. Letting the LLM fetch text on demand instead of having its context polluted by irrelevant scenes
 *
 * Cross-agent: "own + borrowed" are segmented by agent; under each segment L3 and the Scene index sit side by side.
 *
 * Degradation when the control plane is unreachable: only inject the current agent's L3 + Scene index.
 */
export class TdaiProfileMemoryInjector implements InjectionHook {
  id = "tdai-profile-memory-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "inside_append" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 10;
  description = "Inject TDAI L3 (persona) + L2 scene index (path-only, agent reads via tool)";
  /** L2/L3 profile snapshot is injected once after session registration, like skill listing. */
  cacheStrategy: CacheStrategy = "session_init";

  /**
   * @param baseConfig  starter TdaiClient config; per-request `serviceId` will
   *   be overridden with `session.space_id` in `renderBlocksForContext`. This
   *   config's `serviceId` acts as a fallback when no `space_id` is present.
   * @param coreSkillCfg  kernel gateway config for MetadataClient (fixed-asset
   *   agent resolution).
   */
  constructor(
    private baseConfig: TdaiMemoryConfig,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    return this.renderBlocksForContext(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocksForContext(createPrewarmAgentContext(input));
  }

  private async renderBlocksForContext(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId comes from `/proxy/<spaceId>/...` in the URL path saved at session registration;
    // used as the kernel's `x-tdai-service-id` header for tenant routing. An empty string is rejected by the kernel (invalid_user_key)
    // -- the caller already handled bypass in the session-init stage.
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Build a per-request TdaiClient with the correct tenant. Falls back to
    // baseConfig.serviceId (config value) when spaceId is empty.
    const client = new TdaiClient({
      ...this.baseConfig,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    // For each agent independently fetch L3 + L2 index (without reading L2 full text)
    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    // All empty -> still inject the tools-guide (the LLM can actively search L1 / read L2)
    const hasAnything = groups.some((g) => g.l3 || g.l2Entries.length > 0);
    if (!hasAnything) {
      return [{
        type: "text",
        content: MEMORY_TOOLS_GUIDE,
        metadata: { source: this.id, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only" },
      }];
    }

    const lines: string[] = [
      "<tdai_profile_memory>",
      "Below is the long-term working memory TDAI maintains for the current agent (own + borrowed segments; L2 gives only an index, read the full text with tools on demand):",
    ];

    let l2TotalCount = 0;
    let l3Count = 0;
    for (const g of groups) {
      if (!g.l3 && g.l2Entries.length === 0) continue;
      const tag = g.ctx.isSelf ? "self" : "imported_from";
      lines.push(
        `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
      );
      if (g.l3?.content) {
        l3Count++;
        lines.push("<l3_core_memory>", truncate(g.l3.content, 6000), "</l3_core_memory>");
      }
      if (g.l2Entries.length > 0) {
        lines.push("<l2_scene_index>");
        for (const e of g.l2Entries) {
          l2TotalCount++;
          // Index line: path + summary (if any); fetch the body with a tool
          if (e.summary) {
            lines.push(`- \`${e.path}\` — ${truncate(e.summary, 200)}`);
          } else {
            lines.push(`- \`${e.path}\``);
          }
        }
        lines.push("</l2_scene_index>");
      }
      lines.push("</agent>");
    }

    lines.push("</tdai_profile_memory>");
    // Immediately followed by a memory-tools-guide, telling the LLM how to use the three tools + the call limits
    lines.push("");
    lines.push(MEMORY_TOOLS_GUIDE);

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          agentCount: groups.length,
          l3Count,
          l2IndexCount: l2TotalCount,
          mode: "index+tools",
        },
      },
    ];
  }
}

function createPrewarmAgentContext(input: PrewarmInput): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: `prewarm:${input.keyId}`,
      keyId: input.keyId,
      modelId: "prewarm",
      stream: false,
      agentSource: "session-init",
      custom: { session: input.sessionInfo },
    },
  };
}

/** Memory usage guide: L0/L1 are retrieved on demand with tools (no longer auto-recalled), L3 is injected directly, L2 index is injected directly. */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ Important: this is not documentation, this is your available capability

The tdai_memory_search / tdai_conversation_search etc. listed in the \`<tdai_memory_tools>\` below
are **capabilities you can actively call** (not documentation for reference only). They are used via **Bash + curl**
(see the full call instructions and URLs in the \`<tdai_memory_tools>\` section above).

**Do not** answer with things like "I don't have this tool / MCP is needed / a slash command is needed".
**Correct approach**: when you determine memory needs to be looked up, run curl directly in Bash; the proxy automatically injects identity and auth.

## Memory usage rules (in the following scenarios you must look up first and then answer)

L3 (persona long-term profile) and the L2 scene index are already injected directly into the system. L0/L1 need to be actively retrieved with tools.
When the injected L2 content is relevant to the current task but insufficient, use \`tdai_read_scene\` with the path in the scene index to read the corresponding body; when the content is already enough, no further reading is needed.

### Scenarios where you must look up memory before answering (any hit triggers a tool call)

1. **The user mentions history/the past/before**: such as "I said before / I told you / last time / do you still remember / we talked about / that one from before"
   -> use \`tdai_conversation_search\` (L0 raw text to find specific messages)
2. **The user involves their own identity/preferences/habits**: such as "what is my name / my name / I like / my team / I often use / I don't like / I don't allow"
   -> use \`tdai_memory_search\` (L1 atomic memory to look up preferences/rules)
3. **The user asks you to recall/find**: such as "recall / think back / find / is there any record about X / look up what we did before"
   -> trigger the tool directly, do not answer out of thin air
4. **The answer depends heavily on historical facts**: such as "how did we fix that bug / what was the plan last time / what is our agreement"
   -> keywordize and use \`tdai_memory_search\`

**Typical flow** (user: "What is my name"):
\`\`\`bash
# Step 1: look up first
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "user name identity", "limit": 5}'
# Step 2: extract the answer from items[].content and reply
# If empty: tell the user clearly "I couldn't find it in memory, what is your name?" -- do not pretend to know
\`\`\`

### Scenarios where no lookup is needed

- Requests that do not depend on historical information or past experience and can be completed from the current input alone; do not judge whether retrieval is needed from the task type alone
- The current session context (messages in the same round) can already answer
- The answer is already visible directly in the \`<l3_core_memory>\` section

### ⚠️ Call constraints

- Per round, \`tdai_memory_search\` + \`tdai_conversation_search\` **total ≤ 3 calls** (\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` do not count)
- When retrieval finds nothing, **state clearly** "I couldn't find X in memory"; do not hallucinate
- Do not read the same L2 path repeatedly
</memory-tools-guide>`;

interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  /** L2 index: only path + optional summary, **does not** read the full text. */
  l2Entries: Array<{ path: string; summary?: string }>;
}

async function loadAgentProfile(client: TdaiClient, c: FixedAssetCtx): Promise<AgentProfileBundle> {
  const tdaiCtx = { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName };
  const [l3, l2Entries] = await Promise.all([client.readL3ForCtx(tdaiCtx), client.listL2ForCtx(tdaiCtx)]);
  // L3 (persona) may embed a "Scene Navigation" scene index at its tail (the plugin-side read carries the navigation section).
  // We already inject <l2_scene_index> separately, so we must strip this copy at the persona tail to avoid injecting the L2 index twice.
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

/**
 * Strip the "Scene Navigation (Scene Index)" section at the persona tail.
 * Aligned with NAV_HEADER in the plugin-side scene-navigation.ts (hits with or without a leading `---`).
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  // Remove it together with the adjacent `---` separator and surrounding whitespace
  let cut = personaContent.slice(0, idx);
  cut = cut.replace(/\s*-{3,}\s*$/, "");
  return cut.trimEnd();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}
