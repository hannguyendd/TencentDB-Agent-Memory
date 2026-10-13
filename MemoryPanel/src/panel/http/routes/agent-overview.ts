import type { Hono } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import type { MetaCallContext } from "../../kernel/types.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import {
  ASSET_TYPE_CODE_GRAPH,
  ASSET_TYPE_WIKI,
  buildCtx,
  fetchAllMetaListItems,
  isActiveMetaAsset,
  joinKnowledgeAssetsWithKs,
  okEnvelope,
  readJson,
  requireTeamMember,
  str,
  strArray,
  type KnowledgeAssetMetaRaw,
} from "./knowledge/common.js";

interface MetaAssetRaw {
  asset_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  team_id: string;
  owner_user_id: string;
  visibility: string;
  status: string;
  created_at: string;
  updated_at: string;
  version?: number;
}

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  status?: string;
  metadata_json?: string;
}

interface SkillSummaryRaw {
  skill_id: string;
  owner_agent_id?: string;
  status?: string;
}

interface FixedAssetTypeCounts {
  skill: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

interface AgentFixedAssetSummary {
  agent_id: string;
  counts: FixedAssetTypeCounts;
  total: number;
}

export interface AgentMountedCounts {
  skills: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

function isActiveStatus(status: string | undefined): boolean {
  return (
    status !== "archived" &&
    status !== "deprecated" &&
    status !== "failed" &&
    status !== "inactive"
  );
}

function toMountable(asset: {
  id: string;
  title: string;
  group: string;
  slug?: string;
  status?: string;
}) {
  return {
    key: asset.id,
    title: asset.title,
    group: asset.group,
    slug: asset.slug ?? asset.id,
    status: asset.status,
  };
}

function emptyFixedCounts(): FixedAssetTypeCounts {
  return { skill: 0, code_graph: 0, llm_wiki: 0, chat_memory: 0 };
}

function ownChatMemoryCount(
  agentId: string,
  selfMemoryAgentIds: Set<string>,
): number {
  return selfMemoryAgentIds.has(agentId) ? 1 : 0;
}

/**
 * 1x summary-by-agents (kernel) + skills come from the Skill list (semantics unchanged).
 * The frontend counts path depends on this result; bootstrap.counts is kept for compatibility.
 */
export async function buildMountedCounts(
  deps: PanelDeps,
  ctx: MetaCallContext,
  agentIds: string[],
  skillCounts: Map<string, number>,
  selfMemoryAgentIds = new Set(agentIds),
): Promise<Record<string, AgentMountedCounts>> {
  const counts: Record<string, AgentMountedCounts> = {};
  for (const agentId of agentIds) {
    counts[agentId] = {
      skills: skillCounts.get(agentId) ?? 0,
      code_graph: 0,
      llm_wiki: 0,
      chat_memory: ownChatMemoryCount(agentId, selfMemoryAgentIds),
    };
  }
  if (agentIds.length === 0) return counts;

  const env = await deps.metaKernel.invoke(
    "agent-fixed-asset/summary-by-agents",
    { agent_ids: agentIds },
    ctx,
  );
  if (env.code !== 0 || !env.data || typeof env.data !== "object")
    return counts;

  const items = Array.isArray((env.data as { items?: unknown }).items)
    ? (env.data as { items: AgentFixedAssetSummary[] }).items
    : [];

  for (const row of items) {
    const fc = row.counts ?? emptyFixedCounts();
    counts[row.agent_id] = {
      skills:
        counts[row.agent_id]?.skills ?? skillCounts.get(row.agent_id) ?? 0,
      code_graph: fc.code_graph ?? 0,
      llm_wiki: fc.llm_wiki ?? 0,
      chat_memory: Math.max(
        fc.chat_memory ?? 0,
        ownChatMemoryCount(row.agent_id, selfMemoryAgentIds),
      ),
    };
  }
  return counts;
}

export function registerAgentOverviewRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post("/agent-overview/bootstrap", mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, "team_id");
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ("error" in gate) return gate.error;

    const requestedAgentIds = strArray(body, "agent_ids");

    const [
      skillAssetsRes,
      codeAssetsRes,
      wikiAssetsRes,
      chatTeamAssetsRes,
      agentsRes,
      skillListRes,
    ] = await Promise.allSettled([
      fetchAllMetaListItems<MetaAssetRaw>(deps, ctx, "asset/list-accessible", {
        user_id: gate.userId,
        team_id: teamId,
        asset_type: "skill",
        action: "read",
        // Consistent with the SkillsPanel "Team assets" tab: the asset selector at initialization only lists
        // team-shared skills, excluding private ones (including the caller's own private ones).
        visibility: "team",
      }),
      fetchAllMetaListItems<KnowledgeAssetMetaRaw>(
        deps,
        ctx,
        "asset/list-accessible",
        {
          user_id: gate.userId,
          team_id: teamId,
          asset_type: ASSET_TYPE_CODE_GRAPH,
          action: "read",
          visibility: "team",
        },
      ),
      fetchAllMetaListItems<KnowledgeAssetMetaRaw>(
        deps,
        ctx,
        "asset/list-accessible",
        {
          user_id: gate.userId,
          team_id: teamId,
          asset_type: ASSET_TYPE_WIKI,
          action: "read",
          visibility: "team",
        },
      ),
      fetchAllMetaListItems<MetaAssetRaw>(deps, ctx, "asset/list-accessible", {
        user_id: gate.userId,
        team_id: teamId,
        asset_type: "chat_memory",
        action: "read",
        // Do not restrict visibility: list-accessible already filters by the caller's read permission
        // (private is visible only to the owner, team to all members). This way:
        //   - the Owner sees all their own chat_memory (including private, for picking their own memory to attach to another agent)
        //   - other members only see team-visible ones
        //   - memory the owner has withdrawn to private -> other members cannot see it (list-accessible filters it)
        // Previously hardcoding visibility='team' wrongly hit the "owner's own private" -- when creating/editing an
        // agent the user could not see their own memory pool; and after others borrowed these private ones, even once released they would linger in
        // the selection list and cause confusion.
      }),
      // Page through everything: limit caps at 100; with more than 100 team agents a bare invoke would truncate
      // (the new-Agent "attach to which agent" selector and the self memory check would both miss entries)
      fetchAllMetaListItems<AgentRaw>(deps, ctx, "agent/list", { team_id: teamId }),
      // True skill ownership: the skill kernel list (counted by owner_agent_id); runtime injection of
      // <available_skills> reads this table, so it is the authoritative source.
      deps.skillKernel.invoke(
        "list",
        {
          user_id: gate.userId,
          team_id: teamId,
          filters: { status: ["active"] },
          pagination: { limit: 1000, offset: 0 },
        },
        ctx,
      ),
    ]);

    const skillAssets =
      skillAssetsRes.status === "fulfilled"
        ? skillAssetsRes.value.filter((a) => isActiveStatus(a.status))
        : [];
    const codeMeta =
      codeAssetsRes.status === "fulfilled"
        ? codeAssetsRes.value.filter((a) => isActiveMetaAsset(a.status))
        : [];
    const wikiMeta =
      wikiAssetsRes.status === "fulfilled"
        ? wikiAssetsRes.value.filter((a) => isActiveMetaAsset(a.status))
        : [];
    // chat_memory asset pool = result of asset/list with visibility='team' (already limited to "shared").
    // No longer filter self memory by id prefix chat_memory-{team}-* -- that prefix can only tell
    // "whether it is some agent's own memory", and cannot distinguish "an unshared self memory" from
    // "an agent memory the user explicitly shared to the team". self memory defaults to visibility=private
    // (see the memory-block construction below in this file: default 'private'), so it is never matched by the visibility='team'
    // query; it only becomes team after the user shares it actively -- and that is exactly the scenario where other agents should be allowed to bind it.
    // The old prefix filter would also kill such "shared agent memory", so it could not be selected when creating a new Agent
    // and team-shared memory could not be bound (inconsistent with the "Team assets" tab on the Chat_Memory page).
    // "The current agent's own self memory is bound by default and cannot be unbound" is handled by the frontend via selfChatMemoryId,
    // unrelated to the team-level asset pool.
    const chatTeamAssets =
      chatTeamAssetsRes.status === "fulfilled"
        ? chatTeamAssetsRes.value.filter((a) => isActiveStatus(a.status))
        : [];
    const agents =
      agentsRes.status === "fulfilled"
        ? agentsRes.value.filter((a) => isActiveStatus(a.status))
        : [];
    const agentIds =
      requestedAgentIds.length > 0
        ? requestedAgentIds
        : agents.map((a) => a.agent_id);
    const selfMemoryAgentIds = new Set(agents.map((a) => a.agent_id));

    // skillCounts are counted from the skill kernel list by owner_agent_id (including fork copies).
    // This is the true skill ownership source; runtime injection of <available_skills> reads it.
    const skillCounts = new Map<string, number>();
    if (skillListRes.status === "fulfilled" && skillListRes.value.code === 0) {
      const items =
        (skillListRes.value.data as { items?: SkillSummaryRaw[] } | null)
          ?.items ?? [];
      for (const item of items) {
        if (!item.owner_agent_id || item.status === "archived") continue;
        skillCounts.set(
          item.owner_agent_id,
          (skillCounts.get(item.owner_agent_id) ?? 0) + 1,
        );
      }
    }

    const [codeItems, wikiItems, counts] = await Promise.all([
      joinKnowledgeAssetsWithKs(
        deps,
        ctx,
        codeMeta,
        ASSET_TYPE_CODE_GRAPH,
      ).catch(() => []),
      joinKnowledgeAssetsWithKs(deps, ctx, wikiMeta, ASSET_TYPE_WIKI).catch(
        () => [],
      ),
      // counts all read from real sources: skills from the skill table; code_graph/llm_wiki/chat_memory
      // from the agent-fixed-asset table (summary-by-agents). No longer reads metadata_json.ui.
      buildMountedCounts(
        deps,
        ctx,
        agentIds,
        skillCounts,
        selfMemoryAgentIds,
      ).catch(() => {
        const fallback: Record<string, AgentMountedCounts> = {};
        for (const agentId of agentIds) {
          fallback[agentId] = {
            skills: skillCounts.get(agentId) ?? 0,
            code_graph: 0,
            llm_wiki: 0,
            chat_memory: ownChatMemoryCount(agentId, selfMemoryAgentIds),
          };
        }
        return fallback;
      }),
    ]);

    // assets.chatMemories only contains truly team-shared chat_memory (chatTeamAssets has already filtered self memory).
    // No longer inject myAgents' self memory: the frontend AgentEditDialog injects the current agent's self memory itself,
    // and backend injection would also stuff in "self memory of other agents I own as owner", polluting other agents' asset pools.
    const memoryItems = new Map<string, ReturnType<typeof toMountable>>();
    for (const asset of chatTeamAssets) {
      memoryItems.set(
        asset.asset_id,
        toMountable({ id: asset.asset_id, title: asset.name, group: "MEMORY" }),
      );
    }

    return respondEnvelope(
      c,
      okEnvelope(c, {
        assets: {
          skills: skillAssets.map((s) =>
            toMountable({ id: s.asset_id, title: s.name, group: "SKILL" }),
          ),
          codeGraphs: codeItems.map((item) =>
            toMountable({
              id: item.knowledge_id,
              title: item.name || item.repo_url || item.knowledge_id,
              group: "CODE",
              // slug uses knowledge_id (cg-xxx), consistent with skill/wiki in showing the asset id;
              // the repo address is already reflected in the title, so there is no need to override the subtitle with repo_url.
              slug: item.knowledge_id,
              status: item.status,
            }),
          ),
          wikis: wikiItems.map((item) =>
            toMountable({
              id: item.knowledge_id,
              title: item.name,
              group: "WIKI",
              status: item.status,
            }),
          ),
          chatMemories: Array.from(memoryItems.values()),
        },
        /** @deprecated the frontend counts may keep consuming it; internally now uses summary-by-agents, no longer N× list */
        counts,
      }),
    );
  });
}
