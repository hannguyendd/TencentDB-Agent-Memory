/**
 * Knowledge Tools Injector — injects a `<knowledge_tools>` block listing
 * team knowledge resources (wiki / code-graph) with a two-step self-discovery
 * flow (tools/list → tools/call).
 *
 * v7 progressive exposure: prompt only contains resource list + discovery
 * entry points. Agent calls tools/list to discover available tools, then
 * tools/call to execute. Tool definitions live in the knowledge service,
 * not in the proxy.
 *
 * Strategy:
 *   - cacheStrategy: "session_init" — knowledge list fetched once at prewarm,
 *     reused for all turns in the session.
 *   - **Per-agent** (design §0.6): read the meta agent-fixed-asset bindings (filter
 *     llm_wiki/code_graph) -> asset_ids (=knowledge_id) -> join-query entity_knowledge by id
 *     to get the render fields. The binding authority is in meta; if details are missing (not ready), nothing is injected.
 *   - Fallback: no caller user-key / no agent -> fall back to the full team list (transitional compatibility).
 *   - Failure / empty → 0 blocks (graceful degradation).
 *
 * See `docs/design/knowledge-injection-v7.md`.
 */

import type {
  AgentContext,
  AnchorTarget,
  AssetCapabilityFlags,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import {
  CoreKnowledgeClient,
  getCoreKnowledgeClient,
  type KnowledgeItem,
} from "../../knowledge/core-client.js";
import type { CoreSkillConfig } from "../../types.js";

const TAG = "[knowledge-tools-injector]";

export interface KnowledgeToolsInjectorConfig {
  /** Core kernel config (same endpoint as skill — 8420). */
  coreSkill: CoreSkillConfig;
}

export interface KnowledgeTelemetryContext {
  sessionKey?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource?: string;
  spaceId?: string;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function renderHeader(name: string, value: string): string {
  return "  -H " + shellQuote(`${name}: ${value}`) + " \\";
}

function toCompositeSessionKey(sessionKey?: string, agentSource?: string): string | undefined {
  if (!sessionKey) return undefined;
  if (!agentSource) return sessionKey;
  const prefix = `${agentSource}:`;
  return sessionKey.startsWith(prefix) ? sessionKey : `${prefix}${sessionKey}`;
}

/**
 * Render the `<knowledge_tools>` block from a list of knowledge resources.
 * Pure function for ease of testing.
 *
 * `service_url` is the tools self-discovery base (already includes the API
 * prefix, e.g. `http://host:8421/v3`). The tools endpoints are service-level
 * (`{service_url}/tools/list` | `/tools/call`); the target resource is selected
 * via the `knowledge_id` field in the body, NOT via the URL path.
 *
 * `serviceId` is the tenant identity (= `x-tdai-service-id`, unified with the
 * kernel routing key). The knowledge service REQUIRES it as a header on every
 * tools call, so we bake it into the curl examples the agent runs. Optional
 * telemetry context headers let the service attribute calls without embedding
 * secrets; all header values are shell-quoted before rendering.
 */
function filterResourcesByCapabilities(
  resources: KnowledgeItem[],
  caps: AssetCapabilityFlags | undefined,
): KnowledgeItem[] {
  if (!caps) return resources;
  return resources.filter((r) => {
    if (r.type === "wiki") return caps.llm_wiki !== false;
    if (r.type === "code-graph") return caps.code_graph !== false;
    return true;
  });
}

/**
 * Escape a value for use inside a double-quoted XML attribute. Resource names
 * and repo slugs are operator-supplied, so a stray `"` would otherwise break
 * the `<knowledge .../>` tag structure the agent parses.
 */
function xmlAttrEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render `\n  name="escaped"`, or "" when the value is absent/blank. */
function attr(name: string, value: string | undefined | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `\n  ${name}="${xmlAttrEscape(trimmed)}"`;
}

/**
 * Derive a repo slug (`<org>/.../<repo>`) from a clone URL, used as the anchor
 * hint the agent matches against the local workspace's git remote.
 *
 * Handles both `https://host/a/b/c.git` and `git@host:a/b/c.git`. Returns
 * undefined when the URL is absent or yields no usable path (e.g. wiki
 * resources, which have no repo).
 */
function deriveRepoSlug(repoUrl: string | undefined): string | undefined {
  if (!repoUrl) return undefined;
  const withoutScheme = repoUrl.replace(/^[a-z0-9+.-]+:\/\//i, "");
  // scp-like syntax (`git@host:org/repo.git`) — split on the first colon.
  const afterHost = withoutScheme.includes(":")
    ? withoutScheme.slice(withoutScheme.indexOf(":") + 1)
    : withoutScheme.slice(withoutScheme.indexOf("/") + 1);
  const slug = afterHost.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return slug.length > 0 ? slug : undefined;
}

export function renderKnowledgeToolsBlock(
  resources: KnowledgeItem[],
  serviceId: string,
  telemetryContext: KnowledgeTelemetryContext = {},
): string | null {
  if (!resources || resources.length === 0) return null;

  const telemetryHeaders: Array<[string, string | undefined]> = [
    ["x-conversation-id", telemetryContext.sessionKey],
    ["x-tdai-user-id", telemetryContext.userId],
    ["x-tdai-team-id", telemetryContext.teamId],
    ["x-tdai-agent-id", telemetryContext.agentId],
    ["x-tdai-agent-source", telemetryContext.agentSource],
    ["x-tdai-space-id", telemetryContext.spaceId],
  ];
  const requestHeaderLines = [
    renderHeader("x-tdai-service-id", serviceId),
    ...telemetryHeaders
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([name, value]) => renderHeader(name, value)),
  ];

  const resourceTags = resources
    .map((r) => {
      // `match` is the anchor criterion for code-graph: the agent compares it against the current workspace's git
      // remote and only calls on a hit. Prefer the repo_slug sent by the backend; if missing, degrade by extracting
      // `<org>/.../<repo>` from repo_url. A wiki has no repo, so this attribute is not rendered.
      const matchAttr = attr("match", r.repo_slug ?? deriveRepoSlug(r.repo_url));
      const branchAttr = attr("branch", r.repo_url ? (r.branch ?? "main") : undefined);
      // A wiki's summary is a content overview generated by the LLM from page titles, and is the only clue for the agent to decide "whether to
      // query this wiki", so it must be kept. A code-graph's summary is merely a count such as
      // "N files, M symbol nodes", which does not help call decisions, so it is not injected.
      const summaryAttr = r.type === "wiki" ? attr("about", r.summary) : "";
      return `<knowledge type="${r.type}" id="${r.knowledge_id}"\n  url="${r.service_url}"\n  name="${xmlAttrEscape(r.name)}"${matchAttr}${branchAttr}${summaryAttr} />`;
    })
    .join("\n\n");

  return [
    "<knowledge_tools>",
    "**Team knowledge base resources**: a code-graph is a prebuilt code index of a repository (symbols / call graph / structure), and a wiki is engineering design documentation. Each of the two has its own criteria, see below.",
    "",
    "## code-graph: when to call",
    "**Precondition**: the resource's match lines up with the current workspace (compare git remote / repo name). If it does not -> that index is not for this repo; use local search and do not call it speculatively.",
    "",
    "Once matched, **use it for any cross-file structure / relationship / breadth information**; typical scenarios:",
    "- Getting familiar with a project, understanding module architecture, finding entry points (cold start)",
    "- Locating where a symbol, file, or concept is implemented",
    "- Tracing call chains, dependencies, data flow",
    "- Assessing change impact, refactoring scope, whether something can be safely deleted (**even if you are already editing code, these questions still call for it**)",
    "- Finding suspicious code paths when troubleshooting production issues, finding related implementations during review",
    "- Not remembering the name of a capability, or unsure whether an implementation already exists (avoid reinventing)",
    "",
    "**There is only one case where it should not be used**: you need the **exact current content** of a piece of code -- editing by line number/character, code you just changed, reviewing uncommitted changes. The index is a branch snapshot and lags behind the workspace; in that case the workspace source is authoritative.",
    "Using it first to build global understanding and then dropping to specific files for precise confirmation is the normal combination, with no conflict.",
    "",
    "## wiki: when to call",
    "A wiki is design documentation, **has no correspondence to the workspace, and needs no anchor matching** (having no match attribute is normal and does not mean it does not line up). Just judge by the about attribute whether the content is relevant.",
    "Use it when asking \"why was it designed this way / background and trade-offs / how a concept is defined in the team / historical decisions and pitfalls hit / the design intent of this module\" -- these answers cannot be found in the code.",
    "How code is written -> use code-graph; the current content of a piece of code -> read the source.",
    "",
    "## Intent -> starting move",
    "Architecture / getting familiar with a project -> explore (returns source along the way in one call); where is X -> search; only need a single symbol's definition -> node; who calls X / what X calls -> callers / callees; impact of changing X -> search then impact; why was it designed this way -> wiki search then read_page.",
    "Combination: refactoring assessment = search -> callers -> impact.",
    "The source returned by explore / node is verbatim, **no need to Read the same spot again** (except in the case above where you need to confirm the latest content).",
    "",
    "## Bound resources",
    resourceTags,
    "",
    "## How to call (service-level unified endpoint; build the URL directly from the resource's url)",
    "The target resource is specified by knowledge_id in the body; **do not** put knowledge_id into the URL path.",
    `**Every request must carry the request header** \`x-tdai-service-id: ${serviceId}\` (tenant identifier; requests missing it are rejected).`,
    "",
    "### Step 1: Get the tool list (call once per resource, the **first** time you use it)",
    "curl -sSk -X POST <url>/tools/list \\",
    "  -H 'content-type: application/json' \\",
    ...requestHeaderLines,
    "  -d '{\"knowledge_id\":\"<knowledge id>\"}'",
    "",
    "Returns: {code, message, data:{knowledge_id, type, name, summary, status, tools:[{name, description, params}, ...]}}",
    "Remember the returned tool name / params and **reuse them within this session**; do not repeatedly call list on the same resource (call again if you forget).",
    "",
    "### Step 2: Execute a tool",
    "curl -sSk -X POST <url>/tools/call \\",
    "  -H 'content-type: application/json' \\",
    ...requestHeaderLines,
    "  -d '{\"knowledge_id\":\"<knowledge id>\", \"tool_name\":\"<name returned by Step 1>\", \"params\":{...}}'",
    "",
    "Returns: {code, message, data}; code=0 means success.",
    "",
    "## Conventions",
    "- tool_name must be **exactly the same** as the name returned by tools/list, with no prefix. params must be a JSON object; pass {} even if there are no params.",
    "- To find files use explore / search (query directly supports file names, e.g. \"session-manager.ts\"); files is only for a one-time overview of the directory structure, at most once per resource per session.",
    "- For a wiki, search first and then read_page; do not list_pages in full.",
    "- Multiple resources can be called in parallel, with no need to wait serially. Give up after 2 consecutive failures of the same call and fall back to local search.",
    "- The response format is uniformly {code, message, data}; code=0 means success.",
    "</knowledge_tools>\n",
  ].join("\n");
}

/**
 * Knowledge tools injector.
 *
 * Anchor: lands in the `knowledge` semantic slot, co-located just AFTER the
 * memory region on each profile — CodeBuddy's <memories> tag / Claude Code's
 * # Memory section. Knowledge tools (wiki + code-graph) are a "cloud reference"
 * pairing naturally with memory, not with executable skills, so we deliberately
 * avoid sharing the `skills` slot.
 * Priority: HOOK_PRIORITY.WIKI (300).
 */
export class KnowledgeToolsInjector implements InjectionHook {
  id = "knowledge-tools-injector";
  point = "system.before_tools" as const;
  anchor: AnchorTarget = { slot: "knowledge", relation: "after" };
  priority: HookPriority = HOOK_PRIORITY.WIKI;
  description = "Inject the <knowledge_tools> block with team knowledge resources.";
  cacheStrategy: CacheStrategy = "session_init";

  constructor(
    private config: KnowledgeToolsInjectorConfig,
    /** Optional override (tests). */
    private clientOverride?: CoreKnowledgeClient,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const ids = this.resolveSession(ctx);
    if (!ids.teamId) return [];
    return this.fetchBlocks(
      ids.teamId,
      ids.agentId,
      ids.userKey,
      ids.spaceId,
      ids.assetCapabilities,
      "execute",
      {
        sessionKey: toCompositeSessionKey(ctx.metadata.sessionKey, ctx.metadata.agentSource),
        userId: ids.userId ?? undefined,
        teamId: ids.teamId,
        agentId: ids.agentId ?? undefined,
        agentSource: ctx.metadata.agentSource,
        spaceId: ids.spaceId ?? undefined,
      },
    );
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    const teamId = input.sessionInfo.team_id;
    if (!teamId) return [];
    return this.fetchBlocks(
      teamId,
      input.sessionInfo.agent_id ?? null,
      input.callerUserKey ?? null,
      input.sessionInfo.space_id ?? null,
      input.assetCapabilities,
      "prewarm",
      {
        sessionKey: toCompositeSessionKey(input.keyId, input.agentSource),
        userId: input.sessionInfo.user_id || input.userId,
        teamId,
        agentId: input.sessionInfo.agent_id,
        agentSource: input.agentSource,
        spaceId: input.sessionInfo.space_id,
      },
    );
  }

  private resolveSession(ctx: AgentContext): {
    teamId: string | null;
    agentId: string | null;
    userId: string | null;
    userKey: string | null;
    spaceId: string | null;
    assetCapabilities?: AssetCapabilityFlags;
  } {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const session = custom?.session as Record<string, unknown> | undefined;
    const teamId = typeof session?.team_id === "string" && session.team_id.length > 0 ? session.team_id : null;
    const agentId = typeof session?.agent_id === "string" && session.agent_id.length > 0 ? session.agent_id : null;
    const userId = typeof session?.user_id === "string" && session.user_id.length > 0 ? session.user_id : null;
    const userKey = typeof custom?.userKey === "string" && custom.userKey.length > 0 ? custom.userKey : null;
    const spaceId = typeof session?.space_id === "string" && session.space_id.length > 0 ? session.space_id : null;
    const assetCapabilities = custom?.assetCapabilities as AssetCapabilityFlags | undefined;
    return { teamId, agentId, userId, userKey, spaceId, assetCapabilities };
  }

  private async fetchBlocks(
    teamId: string,
    agentId: string | null,
    userKey: string | null,
    spaceId: string | null,
    assetCapabilities: AssetCapabilityFlags | undefined,
    phase: "prewarm" | "execute",
    telemetryContext: KnowledgeTelemetryContext,
  ): Promise<ContextBlock[]> {
    try {
      const client = this.clientOverride ?? getCoreKnowledgeClient(this.config.coreSkill);

      console.log(`${TAG} ${phase} team=${teamId} agent=${agentId ?? "(none)"} userKey=${userKey ? "(set)" : "(none)"} space=${spaceId ?? "(none)"}`);

      // Per-agent (preferred): meta binding -> asset_ids -> join-query details by id.
      // serviceId passes through spaceId (same as SkillInjector: `/{agent}/{spaceId}/...`).
      let resources: KnowledgeItem[];
      let scope: string;
      if (agentId && userKey) {
        const ids = await client.listAgentKnowledgeIds(agentId, userKey, { serviceId: spaceId ?? undefined });
        console.log(`${TAG} ${phase} per-agent path: listAgentKnowledgeIds → ${ids.length} ids [${ids.join(",")}]`);
        resources = ids.length > 0 ? await client.listKnowledgeByIds(teamId, ids, { serviceId: spaceId ?? undefined }) : [];
        console.log(`${TAG} ${phase} per-agent path: listKnowledgeByIds → ${resources.length} resources`);
        scope = `agent:${agentId}`;
      } else {
        // Fallback: no caller identity -> full team.
        // Pass space_id as the kernel tenant routing header (same as SkillInjector).
        resources = await client.listKnowledge(teamId, { serviceId: spaceId ?? undefined });
        console.log(`${TAG} ${phase} fallback path: listKnowledge → ${resources.length} resources`);
        scope = `team:${teamId}`;
      }

      resources = filterResourcesByCapabilities(resources, assetCapabilities);
      // The service-id in the injected prompt for the LLM must also be the spaceId (the LLM uses it to call KS's tools/list|call).
      const injectionServiceId = spaceId || this.config.coreSkill.serviceId;
      const content = renderKnowledgeToolsBlock(resources, injectionServiceId, telemetryContext);
      if (!content) return [];
      return [{
        type: "text",
        content,
        metadata: {
          source: this.id,
          cacheKey: `knowledge-tools-injector:${scope}`,
        },
      }];
    } catch (err) {
      console.warn(`${TAG} ${phase} failed: ${(err as Error).message}`);
      return [];
    }
  }
}
