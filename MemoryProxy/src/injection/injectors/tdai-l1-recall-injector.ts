import type { AgentContext, ContextBlock, InjectionHook, HookPriority } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import type { TdaiClient } from "../../tdai/client.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs } from "./tdai-fixed-asset.js";

/**
 * L1 recall ("own + borrowed" cross-agent merged top-K):
 *   1. Get the current (team, user, agent) identity from ctx (derived from ProxyConfig)
 *   2. Call the control plane /fixed-asset-agents to get [self, ...borrowed <=2]
 *   3. For each ctx concurrently /atomic/search (query=last user message)
 *   4. Merge all hits -> sort by score descending -> take the top globalTopK
 *   5. Inject into user.before, each item tagged [from <agent_name>]
 *
 * Degradation when the control plane is unreachable: only query the current agent's L1 (same as the behavior before the change).
 */
export class TdaiL1RecallInjector implements InjectionHook {
  id = "tdai-l1-recall-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY;
  description = "Recall TDAI L1 memories from self + imported agents and prepend them to the current user turn";

  /**
   * @param sessionInitConfig used to call the control plane for fixed-asset-agents; if null,
   *        the injector degrades to "only query the current agent" mode, staying backward compatible.
   * @param perAgentLimit how many items to recall from tdai per agent (default = client config)
   * @param globalTopK how many items to keep after merging (default 5)
   */
  constructor(
    private client: TdaiClient,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
    private perAgentLimit: number | undefined = undefined,
    private globalTopK = 5,
    /**
     * ACL check client, usually the same TdaiClient instance as `client`. When passed, every
     * fixed-asset ctx goes through acl/check(read) filtering. When null the old behavior is kept.
     */
    private aclClient: TdaiClient | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const lastUser = getLastUserMessage(ctx);
    if (!lastUser) return [];
    // Use the "clean real user_query" as the search term, rather than the whole raw message blob
    // (the latter contains noise such as <user_info>/<additional_data>/<question_answer>,
    //  which makes the FTS5/vector hit rate extremely low or even 0, so L1 cannot be recalled).
    const query = extractUserQueryText(getMessageText(lastUser)).trim().slice(0, 2048);
    if (!query) return [];

    // Get the ctx list of self + up to 2 borrowed
    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId comes from `/proxy/<spaceId>/...` in the URL path saved at session registration;
    // used as the kernel's `x-tdai-service-id` header for tenant routing.
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Concurrently search L1 for each ctx
    const groups = await Promise.all(
      ctxs.map(async (c) => {
        const items = await this.client.searchL1ForCtx(
          { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName },
          query,
          identity.sessionId,
          identity.taskId,
          this.perAgentLimit,
        );
        return items.map((m) => ({
          ...m,
          fromAgentId: c.agentId,
          fromAgentName: c.agentName,
        }));
      }),
    );
    // Merge all hits, sort by score descending (those missing score go last)
    const merged = ([] as Array<(typeof groups)[number][number]>)
      .concat(...groups)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, this.globalTopK);

    if (merged.length === 0) return [];

    const lines: string[] = [
      "<tdai_recalled_l1_memories>",
      "Below are TDAI L1 memories relevant to the user's question this round (own + borrowed combined, sorted by relevance); use them only to assist with answering the current round, and do not treat them as permanent system rules:",
    ];
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      const fromTag =
        m.fromAgentId === identity.agentId
          ? "self"
          : `from ${m.fromAgentName ?? m.fromAgentId}`;
      const score = typeof m.score === "number" ? ` score=${m.score.toFixed(3)}` : "";
      lines.push(`${i + 1}. [${m.type ?? "memory"}] [${fromTag}${score}] ${m.content}`);
    }
    lines.push("</tdai_recalled_l1_memories>");

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          count: merged.length,
          sources: ctxs.map((c) => c.agentId),
        },
      },
    ];
  }
}
