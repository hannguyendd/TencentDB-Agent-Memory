/**
 * /api/v1/chat-memory/* -- dedicated business routes for the Chat Memory panel (stateless panel architecture).
 *
 * Why a separate layer rather than going through /meta/{action}:
 *   - New panel §0 decision 12.3: in phase 1, `asset/*` and `agent-fixed-asset/*` return 501 (NOT_IN_SCOPE)
 *     in the meta pass-through.
 *   - But the Chat Memory panel's 3-tab page needs these asset operations. This file is the landing point of that "12.3 decision exception":
 *     it wraps only the chat_memory asset type as business operations, isolated from skill/wiki/code_graph.
 *
 * Request conventions (same as /meta/*):
 *   - all POST
 *   - Headers must carry `X-Tdai-Service-Id` (selects the instance) + `X-Tdai-User-Key` (caller identity)
 *   - returns the envelope `{ code, message, request_id, data }`
 *
 * Kernel calls:
 *   The metadata layer goes through `deps.metaKernel.invoke(action, body, ctx)` -> kernel `/v3/meta/*`.
 *   The data-plane layer (/layer, /import) goes through `deps.kernelHttp.postEnvelope('/v3/...', body, cred)`.
 *   Panel-layer responsibilities: assemble caller headers, aggregate multiple calls, permission/type/import <= 2 validation.
 *
 * 12 endpoints (corresponding to the 3 tabs of the frontend web/src/components/ChatMemoryPanel.tsx):
 *   POST /chat-memory/team-assets     Team tab (visibility=team and not owned by me)
 *   POST /chat-memory/agent-fixed     Fixed assets tab (fixed_assets of the selected agent)
 *   POST /chat-memory/my-agents       My asset allocation tab (list of agents I own)
 *   POST /chat-memory/mine            (old) asset list where owner=me
 *   POST /chat-memory/create          Create a standalone UserAsset (mem-xxx)
 *   POST /chat-memory/patch-scope     Change scope (team <-> private)
 *   POST /chat-memory/allocate        Allocate (import), including the <= 2 validation
 *   POST /chat-memory/unbind          Unbind from an agent
 *   POST /chat-memory/layer           L0/L1/L2/L3 layered lazy loading
 *   POST /chat-memory/layer-delete    Bulk delete of L0/L1 lists (Owner-only)
 *   POST /chat-memory/clear           One-click clear of content, keeping the asset (Owner-only)
 *   POST /chat-memory/import          Import historical conversations into an agent's L0
 */
import type { Hono } from "hono";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import type { PanelDeps } from "../../panel-deps.js";
import {
  toKernelCredentials,
  type MetaCallContext,
} from "../../kernel/types.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import { MAX_IMPORTED_AGENTS } from "../../domain/chat-memory-governance.js";
import { newExternalAssetId } from "../../domain/asset-id.js";
import { fetchAllMetaListItems } from "./knowledge/common.js";

/**
 * Normalize the time_start / time_end passed by the detail page's time filter.
 * Accepts any string parseable by Date (including datetime-local's `YYYY-MM-DDTHH:mm`),
 * converts it uniformly to UTC ISO8601 for the kernel; non-strings / unparseable values all return undefined (treated as no filter).
 */
function normalizeTimeInput(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Determine "the filter range is too large for the VDB to support this paginated query".
 * Basis: the kernel statistics say there is data in this range (total > 0) and the requested offset is still within the total,
 * but this page returned nothing. TCVDB's paginated queries (queryL0Paginated / queryL1Paginated)
 * catch exceptions and silently return an empty set when exceeding the supportable window (see MemoryCore/src/core/store/tcvdb.ts),
 * so this combination cannot be "truly no data"; it can only be that the query was rejected by the VDB.
 * On a hit, the frontend prompts the user to narrow the filtered time range, instead of wrongly showing "No data".
 */
function isRangeTooLarge(
  total: number,
  returned: number,
  offset: number,
): boolean {
  return total > 0 && returned === 0 && offset < total;
}

// ── Kernel raw types (only the fields used by this file, to avoid depending on the SDK) ────────────
interface AssetRaw {
  asset_id: string;
  team_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  visibility: string;
  status: string;
  updated_at: string;
}
interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
}
interface FixedAssetRaw {
  asset_id: string;
  asset_type: string;
  injection_mode?: string;
  priority?: number;
  created_by?: string;
}
interface ListEnvelopeData<T> {
  items: T[];
  total?: number;
  limit?: number;
  offset?: number;
}

// ── Output shape (aligned with the frontend MemoryBlock) ─────────────────────────
interface MemoryBlockOut {
  id: string;
  title: string;
  summary: string;
  uploaded_by_user_id: string;
  updated_at_ms: number;
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  scope?: "team" | "private";
  bound_agent_count?: number;
  agent_id?: string;
}

export function registerChatMemoryRoutes(api: Hono, deps: PanelDeps): void {
  // 4.1 Team assets tab
  //
  // Product semantics: this tab shows all shared memory assets in the current team.
  //   - visibility=team (shared)
  //   - owner is not distinguished; ones the user shared themselves should also be visible in team assets.
  api.post(
    "/chat-memory/team-assets",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const teamId = requiredTeamId(await readJson(c));
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

      // Page through everything: kernel DEFAULT_PAGINATION=20, and single-page truncation would make the list incomplete
      let listError: MetaEnvelope<unknown> | null = null;
      const items = (
        await fetchAllMetaListItems<AssetRaw>(
          deps,
          ctx,
          "asset/list",
          { team_id: teamId, asset_type: "chat_memory", visibility: "team" },
          (env) => {
            listError = env;
          },
        )
      ).filter(isActive);
      if (listError) return respondEnvelope(c, listError);

      // perf: the list endpoint no longer computes bound_agent_count (old implementation N+1: M assets x one
      // agent/list + one summary-by-agents each; measured 41 kernel calls for 20 assets,
      // and users measured 3.5s+ lag). The frontend does not show this field in the list UI (layer counts / binding counts
      // only appear in the right-hand detail panel), so it is simply dropped. If the list needs to show binding counts later, use a separate
      // lazy-loading endpoint; do not put it back in the main list loop.
      const out: MemoryBlockOut[] = items.map((a) => ({
        id: a.asset_id,
        title: a.name,
        summary: buildSummary(),
        uploaded_by_user_id: a.owner_user_id,
        updated_at_ms: toMs(a.updated_at),
        layer_counts: emptyLayers(),
      }));
      return respondEnvelope(
        c,
        okEnvelope(c, { items: out, total: out.length }),
      );
    },
  );

  // ── 4.2 Fixed assets tab ─────────────────────────────────────
  //
  // POST /chat-memory/agent-fixed  body: { agent_id }
  //
  // Returns the bindings with asset_type=chat_memory in meta_agent_fixed_assets under this agent.
  // Gets asset details in one go via /v3/meta/agent-fixed-asset/list-with-detail.
  //
  // Permissions (product definition: "fixed assets" = bound assets of agents I own):
  //   1. agent.owner_user_id === me -> can see all assets imported by their own agent
  //   2. agent.owner_user_id !== me → 403 NOT_YOUR_AGENT
  //   3. no caller identity -> 401
  api.post(
    "/chat-memory/agent-fixed",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
      if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      // Query the agent to get the owner and decide the filter strategy
      const agentEnv = await deps.metaKernel.invoke(
        "agent/get",
        { agent_id: agentId },
        ctx,
      );
      if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
        return respondControlError(c, 404, "AGENT_NOT_FOUND");
      }
      if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
      const agent = agentEnv.data as AgentRaw;
      if (agent.owner_user_id !== meUserId) {
        return respondControlError(c, 403, "NOT_YOUR_AGENT");
      }

      // Display strategy: return all physical bindings (apply_visibility_filter=false), and the frontend, based on
      // scope + owner, greys out entries "switched to private by others":
      //   - memory content/details: viewing not allowed (the frontend shows a placeholder)
      //   - unbind operation: allowed (the entry point for cleaning dirty bindings)
      // With filter=true, private entries would be removed from items outright -> users could never
      // know about / clean up these leftover bindings; filter=false + frontend marking is a better "aware + cleanable" experience.
      //
      // Type filter pushed down: core `agent-fixed-asset/list-with-detail` supports
      // the `asset_types` parameter (v3-meta-schemas.ts:fixedAssetListWithDetailSchema),
      // filtering by type at the SQL layer -- irrelevant types (skill / wiki / code_graph) do not consume pagination quota.
      // The earlier approach of "fetch everything then filter(asset_type==='chat_memory') in memory", on an agent with very
      // many skills (e.g. the real online case of 519 skills + 1 chat_memory), had the chat_memory
      // binding sorted at position 520 by priority DESC/created_at DESC and cut off by the 500 hard-limit paging
      // window; the frontend got an empty array and the "fixed assets memory" tab was completely blank (case: zcchizhang).
      // Now the kernel returns only that 1 chat_memory item directly, so pagination / hard limits no longer need consideration.
      interface FixedAssetDetailRaw {
        asset_id: string;
        asset_type: string;
        name: string;
        status: string;
        visibility: string;
        created_at: string;
      }
      let listError: MetaEnvelope<unknown> | null = null;
      const fixedAssets = await fetchAllMetaListItems<FixedAssetDetailRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list-with-detail",
        {
          agent_id: agentId,
          apply_visibility_filter: false,
          touch_usage: false,
          asset_types: ["chat_memory"],
        },
        (env) => {
          listError = env;
        },
      );
      if (listError) return respondEnvelope(c, listError);

      const items = fixedAssets.filter(
        (it) =>
          it.status !== "archived" &&
          it.status !== "deprecated" &&
          it.status !== "failed",
      );

      // Get the real owner_user_id and updated_at (list-with-detail does not return these two fields)
      const out: MemoryBlockOut[] = await Promise.all(
        items.map(async (it) => {
          let ownerUserId = "";
          let updatedAt = it.created_at; // Fallback: use created_at when asset/get fails
          try {
            const aEnv = await deps.metaKernel.invoke(
              "asset/get",
              { asset_id: it.asset_id },
              ctx,
            );
            if (aEnv.code === 0 && aEnv.data) {
              const a = aEnv.data as AssetRaw;
              ownerUserId = a.owner_user_id;
              updatedAt = a.updated_at || it.created_at;
            }
          } catch {
            /* fallback to empty */
          }
          return {
            id: it.asset_id,
            title: it.name,
            summary: buildSummary(),
            uploaded_by_user_id: ownerUserId,
            updated_at_ms: toMs(updatedAt),
            // Pass through to the frontend for greying out: team displays normally; private is greyed out and tagged "set to private by the owner"
            scope: it.visibility === "private" ? "private" : "team",
            // TEMP: for local test display; production should switch to lazy loading
            layer_counts: emptyLayers(),
            agent_id: agentId,
          };
        }),
      );
      return respondEnvelope(
        c,
        okEnvelope(c, { items: out, total: out.length }),
      );
    },
  );

  // ── 4.3b My asset allocation tab (new semantics) ─────────────────────────
  //
  // POST /chat-memory/my-agents  body: { team_id }
  //
  // Product semantics: one agent = one memory block; the "My asset allocation" tab shows all agents I own,
  // and each agent has a "visible to team" switch (scope). This returns the chat_memory
  // block view corresponding to each agent (block.id = chat_memory-{team}-{agent}, title = agent.name,
  // scope comes from the visibility of that agent's own chat_memory).
  api.post(
    "/chat-memory/my-agents",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const teamId = requiredTeamId(body);
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      // Fetch all agents under the team, then filter by owner=me at the panel layer
      // (tdai /v3/meta/agent/list ignores owner_user_id when team_id is passed, so we must filter ourselves)
      // Page through everything: single-page truncation at 20 would make the "My Agents" list incomplete when the team has > 20 agents
      let agentListError: MetaEnvelope<unknown> | null = null;
      const agents = (
        await fetchAllMetaListItems<AgentRaw & { name: string; description?: string }>(
          deps,
          ctx,
          "agent/list",
          { team_id: teamId, status: "active" },
          (env) => {
            agentListError = env;
          },
        )
      ).filter((a) => a.owner_user_id === meUserId);
      if (agentListError) return respondEnvelope(c, agentListError);

      // Each agent corresponds to one memory block: query the chat_memory asset (if already auto-minted) to get visibility
      const out: MemoryBlockOut[] = await Promise.all(
        agents.map(async (a) => {
          const assetId = `chat_memory-${teamId}-${a.agent_id}`;
          let visibility: "team" | "private" = "private";
          let updated_at_ms = 0;
          try {
            const assetEnv = await deps.metaKernel.invoke(
              "asset/get",
              { asset_id: assetId },
              ctx,
            );
            if (assetEnv.code === 0 && assetEnv.data) {
              const asset = assetEnv.data as AssetRaw;
              visibility = asset.visibility === "team" ? "team" : "private";
              updated_at_ms = toMs(asset.updated_at);
            }
          } catch {
            /* asset does not exist -> keep private + 0 */
          }
          return {
            id: assetId,
            title: a.name, // <- use the agent name as the block title, consistent with "one agent, one memory block"
            summary: buildSummary(),
            uploaded_by_user_id: meUserId,
            updated_at_ms,
            layer_counts: emptyLayers(),
            scope: visibility,
            agent_id: a.agent_id,
          };
        }),
      );
      return respondEnvelope(
        c,
        okEnvelope(c, { items: out, total: out.length }),
      );
    },
  );

  // 4.3 My assets tab
  api.post("/chat-memory/mine", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

    // caller = the user_id corresponding to the current user_key (looked up via auth/verify; frontend-passed params are not trusted)
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    // Page through everything: single-page truncation at 20 would make the list incomplete when "My assets" exceeds 20 entries
    let listError: MetaEnvelope<unknown> | null = null;
    const items = (
      await fetchAllMetaListItems<AssetRaw>(
        deps,
        ctx,
        "asset/list",
        { team_id: teamId, asset_type: "chat_memory", owner_user_id: meUserId },
        (env) => {
          listError = env;
        },
      )
    ).filter(isActive);
    if (listError) return respondEnvelope(c, listError);

    const out: MemoryBlockOut[] = await Promise.all(
      items.map(async (a) => ({
        id: a.asset_id,
        title: a.name,
        summary: buildSummary(),
        uploaded_by_user_id: a.owner_user_id,
        updated_at_ms: toMs(a.updated_at),
        // TEMP: for local test display; production should switch to lazy loading or on-demand fetching when the frontend clicks
        layer_counts: emptyLayers(),
        scope: (a.visibility === "private" ? "private" : "team") as
          | "team"
          | "private",
      })),
    );
    return respondEnvelope(c, okEnvelope(c, { items: out, total: out.length }));
  });

  // 4.7 Create UserAsset
  //
  // The tdai asset/create schema requires asset_id + owner_user_id (it does not look them up from headers),
  // so the panel layer must:
  //   1. auth/verify to get the caller user_id
  //   2. generate the mem-xxx id with newExternalAssetId('chat_memory')
  //   3. then asset/create
  api.post("/chat-memory/create", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) {
      return respondControlError(c, 400, "INVALID_TITLE");
    }
    const scope = body?.scope === "private" ? "private" : "team";
    const description =
      typeof body?.description === "string" ? body.description : undefined;

    // Look up the caller user_id
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    const createEnv = await deps.metaKernel.invoke(
      "asset/create",
      {
        asset_id: newExternalAssetId("chat_memory"),
        team_id: teamId,
        asset_type: "chat_memory",
        name: title,
        description,
        owner_user_id: meUserId,
        source_type: "uploaded",
        visibility: scope,
      },
      ctx,
    );
    if (createEnv.code !== 0) return respondEnvelope(c, createEnv);
    const asset = createEnv.data as AssetRaw;
    return respondEnvelope(
      c,
      okEnvelope(c, {
        id: asset.asset_id,
        title: asset.name,
        summary: buildSummary(),
        uploaded_by_user_id: asset.owner_user_id,
        updated_at_ms: toMs(asset.updated_at),
        layer_counts: emptyLayers(),
        scope: asset.visibility === "private" ? "private" : "team",
      } satisfies MemoryBlockOut),
    );
  });

  // ── 4.10 Import historical conversations into the agent memory pool ──────────────────────
  //
  // POST /chat-memory/import  body: { team_id, agent_id, session_id?, messages: [{role, content, ts?}] }
  //
  // Semantics: "put this historical conversation as L0 into the selected agent's memory pool", so that the tdai pipeline subsequently
  // distills L1/L2/L3 automatically. **Does not create a new asset** -- the agent's chat_memory asset was already auto-registered by
  // ensureChatMemoryAsset; this endpoint only writes data-plane L0.
  //
  // Permission: agent.owner = me (can only import into one's own agent)
  //
  // Goes through tdai /v3/conversation/add:
  //   body: { team_id, user_id (=agent.owner), agent_id, session_id, messages }
  api.post("/chat-memory/import", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
    const rawMessages = body?.messages;
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");
    if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return respondControlError(c, 400, "MISSING_MESSAGES");
    }
    // The tdai conversationAddRequestSchema limit is 100; beyond that the kernel rejects it -> the panel layer also uses 100
    if (rawMessages.length > 100) {
      return respondControlError(c, 400, "TOO_MANY_MESSAGES");
    }

    // Normalize messages
    interface Msg {
      role: string;
      content: string;
      ts?: string;
    }
    const messages: Msg[] = [];
    for (const raw of rawMessages) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const role = typeof m.role === "string" ? m.role : "";
      const content = typeof m.content === "string" ? m.content : "";
      if (!role || !content) continue;
      messages.push({
        role,
        content,
        ts: typeof m.ts === "string" ? m.ts : undefined,
      });
    }
    if (messages.length === 0) {
      return respondControlError(c, 400, "NO_VALID_MESSAGES");
    }

    // Permission: agent.owner = me
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");
    c.set('resolvedUserId', meUserId);
    // Also put user_key -> user_id into the resolver, so that subsequent instrumentation with the same user_key
    // such as skill/create, skill/conversation/add can hit immediately (asset-import cold start scenario).
    if (ctx.userKey) deps.userIdResolver.warm(ctx.userKey, meUserId, ctx.instanceId);
    const agentEnv = await deps.metaKernel.invoke(
      "agent/get",
      { agent_id: agentId },
      ctx,
    );
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, "AGENT_NOT_FOUND");
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.team_id !== teamId)
      return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
    if (agent.owner_user_id !== meUserId)
      return respondControlError(c, 403, "NOT_YOUR_AGENT");

    // session_id fallback: the caller may pass one, or generate imported-{ts}
    const sessionId =
      typeof body?.session_id === "string" && body.session_id.trim()
        ? body.session_id.trim()
        : `imported-${Date.now().toString(36)}`;

    // Goes through data-plane conversation/add; user_id uses agent.owner_user_id (the data plane isolates by owner)
    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });
    const addEnv = await deps.kernelHttp.postEnvelope<{
      accepted_ids?: string[];
    }>(
      "/v3/conversation/add",
      {
        team_id: teamId,
        user_id: agent.owner_user_id,
        agent_id: agentId,
        session_id: sessionId,
        messages,
      },
      cred,
    );
    if (addEnv.code !== 0) return respondEnvelope(c, addEnv);
    const acceptedCount =
      (addEnv.data as { accepted_ids?: string[] } | null)?.accepted_ids
        ?.length ?? 0;

    return respondEnvelope(
      c,
      okEnvelope(c, {
        imported: true,
        block_id: `chat_memory-${teamId}-${agentId}`,
        session_id: sessionId,
        accepted_count: acceptedCount,
      }),
    );
  });

  // 4.8 Change scope
  //
  // Two-layer validation:
  //   1. Panel layer: asset_type === 'chat_memory' (prevents the chat-memory route from being used to modify
  //      the visibility of other asset types; this route is chat-memory only)
  //   2. tdai layer: `updateAssetForCaller` goes through `assertCallerIsAssetOwner`, and a non-owner gets
  //      permission_denied directly
  api.post(
    "/chat-memory/patch-scope",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
      const scope =
        body?.scope === "private"
          ? "private"
          : body?.scope === "team"
            ? "team"
            : undefined;
      if (!scope) return respondControlError(c, 400, "INVALID_SCOPE");

      // Verify the target asset is chat_memory
      const preEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: blockId },
        ctx,
      );
      if (preEnv.code === 404 || (preEnv.code === 0 && !preEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (preEnv.code !== 0) return respondEnvelope(c, preEnv);
      const preAsset = preEnv.data as AssetRaw;
      if (preAsset.asset_type !== "chat_memory") {
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      }

      const env = await deps.metaKernel.invoke(
        "asset/update",
        { asset_id: blockId, visibility: scope },
        ctx,
      );
      if (env.code !== 0) return respondEnvelope(c, env);
      const asset = env.data as AssetRaw;
      // After switching to private: the backend no longer actively prunes other agents' bindings
      //   1. The kernel permission model requires caller = agent.owner to set; the owner can only set their own agents
      //   2. Keeping dirty bindings is harmless: downstream injection / memory-bridge calls
      //      apply_visibility_filter=true on the read side to filter out items with canBindAsset=false;
      //      the detail page also filters them, so they are not displayed
      //   3. When the frontend switches to private, it pops a confirm telling the user "agents that have already bound it can no longer use it"
      return respondEnvelope(
        c,
        okEnvelope(c, {
          updated: true,
          id: asset.asset_id,
          scope: asset.visibility === "private" ? "private" : "team",
        }),
      );
    },
  );

  // 4.5a Bulk set fixed memory (atomic validation + a single set, avoiding concurrent overwrite from multiple allocates)
  api.post(
    "/chat-memory/set-agent-fixed",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
      const teamId = typeof body?.team_id === "string" ? body.team_id : "";
      const rawBlockIds = Array.isArray(body?.block_ids) ? body.block_ids : [];
      if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

      const blockIds = Array.from(
        new Set(
          rawBlockIds.filter(
            (id): id is string =>
              typeof id === "string" && id.trim().length > 0,
          ),
        ),
      );
      const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
      const importedIds = blockIds.filter((id) => id !== selfChatMemoryId);
      if (importedIds.length > MAX_IMPORTED_AGENTS) {
        return respondControlError(c, 400, "IMPORT_LIMIT_EXCEEDED");
      }

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      const agentEnv = await deps.metaKernel.invoke(
        "agent/get",
        { agent_id: agentId },
        ctx,
      );
      if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
        return respondControlError(c, 404, "AGENT_NOT_FOUND");
      }
      if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
      const agent = agentEnv.data as AgentRaw;
      if (agent.team_id !== teamId)
        return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
      if (agent.owner_user_id !== meUserId)
        return respondControlError(c, 403, "NOT_YOUR_AGENT");

      for (const blockId of importedIds) {
        const assetEnv = await deps.metaKernel.invoke(
          "asset/get",
          { asset_id: blockId },
          ctx,
        );
        if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
          return respondControlError(c, 404, "BLOCK_NOT_FOUND");
        }
        if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
        const asset = assetEnv.data as AssetRaw;
        if (asset.asset_type !== "chat_memory")
          return respondControlError(c, 400, "NOT_CHAT_MEMORY");
        if (asset.team_id !== teamId)
          return respondControlError(c, 400, "TEAM_MISMATCH");
        if (asset.visibility !== "team" && asset.owner_user_id !== meUserId) {
          return respondControlError(c, 403, "ASSET_NOT_SHARED");
        }
      }

      // Page through everything: kernel DEFAULT_PAGINATION=20, and without a limit only the first 20 are returned,
      // while the set below is a full replacement -> with >= 21 entries the old bindings would be silently cleared.
      let bindListError: MetaEnvelope<unknown> | null = null;
      const existing = await fetchAllMetaListItems<FixedAssetRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list",
        { agent_id: agentId },
        (env) => {
          bindListError = env;
        },
      );
      if (bindListError) return respondEnvelope(c, bindListError);
      const nonMemoryBindings = existing.filter(
        (b) => b.asset_type !== "chat_memory",
      );
      const selfBinding = existing.find(
        (b) =>
          b.asset_type === "chat_memory" && b.asset_id === selfChatMemoryId,
      );
      const newBindings = [
        ...nonMemoryBindings.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? "direct",
          priority: b.priority ?? 50,
          created_by: b.created_by,
        })),
        ...(selfBinding
          ? [
              {
                asset_id: selfBinding.asset_id,
                asset_type: selfBinding.asset_type,
                injection_mode: selfBinding.injection_mode ?? "summary",
                priority: selfBinding.priority ?? 50,
                created_by: selfBinding.created_by ?? agent.owner_user_id,
              },
            ]
          : []),
        ...importedIds.map((blockId) => ({
          asset_id: blockId,
          asset_type: "chat_memory",
          injection_mode: "summary",
          priority: 50,
          created_by: agent.owner_user_id,
        })),
      ];

      const setEnv = await deps.metaKernel.invoke(
        "agent-fixed-asset/set",
        { agent_id: agentId, bindings: newBindings },
        ctx,
      );
      if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
      return respondEnvelope(
        c,
        okEnvelope(c, {
          updated: true,
          agent_id: agentId,
          block_ids: [selfChatMemoryId, ...importedIds],
        }),
      );
    },
  );

  // 4.5 Allocate (import) + <= 2 validation
  api.post(
    "/chat-memory/allocate",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
      const teamId = typeof body?.team_id === "string" ? body.team_id : "";
      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
      if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

      // Validate asset exists + type + team consistent
      const assetEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: blockId },
        ctx,
      );
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory") {
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      }
      if (asset.team_id !== teamId) {
        return respondControlError(c, 400, "TEAM_MISMATCH");
      }

      // Validate agent exists + same team
      const agentEnv = await deps.metaKernel.invoke(
        "agent/get",
        { agent_id: agentId },
        ctx,
      );
      if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
        return respondControlError(c, 404, "AGENT_NOT_FOUND");
      }
      if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
      const agent = agentEnv.data as AgentRaw;
      if (agent.team_id !== teamId) {
        return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
      }

      // Permission check (ordinary user view): can only import assets into "agents I own"
      // The target asset must be visibility=team (shared with the team), or owned by oneself (keeping for own use is also OK)
      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");
      if (agent.owner_user_id !== meUserId) {
        return respondControlError(c, 403, "NOT_YOUR_AGENT");
      }
      if (asset.visibility !== "team" && asset.owner_user_id !== meUserId) {
        return respondControlError(c, 403, "ASSET_NOT_SHARED");
      }

      // Forbid allocating an agent's own chat_memory back to itself; own memory is permanently present via auto-mint,
      // and the allocate entry is only for importing other agents' shared memory into the current agent.
      const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
      if (blockId === selfChatMemoryId) {
        return respondControlError(
          c,
          400,
          "Cannot allocate this Agent's own memory to itself.",
        );
      }

      // Fetch existing bindings (page through everything, same reason as 4.4 import: set is a full replacement,
      // and single-page truncation at 20 would silently clear the 21st+ bindings and also distort the imported count)
      let bindListError: MetaEnvelope<unknown> | null = null;
      const bindings = await fetchAllMetaListItems<FixedAssetRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list",
        { agent_id: agentId },
        (env) => {
          bindListError = env;
        },
      );
      if (bindListError) return respondEnvelope(c, bindListError);
      if (bindings.some((b) => b.asset_id === blockId)) {
        return respondControlError(
          c,
          409,
          "This memory has already been allocated to this Agent; no need to allocate it again.",
        );
      }

      // Import <= 2 validation: count non-own chat_memory
      const imported = bindings.filter(
        (b) =>
          b.asset_type === "chat_memory" && b.asset_id !== selfChatMemoryId,
      );
      if (imported.length >= MAX_IMPORTED_AGENTS) {
        return respondControlError(c, 400, "IMPORT_LIMIT_EXCEEDED");
      }

      // Combine: list -> append -> set (tdai has no append endpoint)
      const newBindings = [
        ...bindings.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? "summary",
          priority: b.priority ?? 50,
          created_by: b.created_by,
        })),
        {
          asset_id: blockId,
          asset_type: "chat_memory",
          injection_mode: "summary",
          priority: 50,
          created_by: agent.owner_user_id, // use the agent owner as the binding's created_by
        },
      ];
      const setEnv = await deps.metaKernel.invoke(
        "agent-fixed-asset/set",
        { agent_id: agentId, bindings: newBindings },
        ctx,
      );
      if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
      return respondEnvelope(
        c,
        okEnvelope(c, {
          allocated: true,
          agent_id: agentId,
          block_id: blockId,
        }),
      );
    },
  );

  // 4.6 Unbind
  api.post("/chat-memory/unbind", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
    const teamId = typeof body?.team_id === "string" ? body.team_id : "";
    if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
    if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

    // Forbid unbinding the agent's "own" chat_memory (created by auto-mint)
    const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
    if (blockId === selfChatMemoryId) {
      return respondControlError(c, 400, "CANNOT_UNBIND_SELF_CHAT_MEMORY");
    }

    // Permission check (ordinary user view): can only unbind imports on "agents I own"
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");
    const agentEnv = await deps.metaKernel.invoke(
      "agent/get",
      { agent_id: agentId },
      ctx,
    );
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw | null;
    if (!agent) return respondControlError(c, 404, "AGENT_NOT_FOUND");
    if (agent.team_id !== teamId) {
      return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
    }
    if (agent.owner_user_id !== meUserId) {
      return respondControlError(c, 403, "NOT_YOUR_AGENT");
    }

    // Verify the asset is chat_memory (prevents this route from being used as a generic fixed-asset unbind entry)
    const assetEnv = await deps.metaKernel.invoke(
      "asset/get",
      { asset_id: blockId },
      ctx,
    );
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, "BLOCK_NOT_FOUND");
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== "chat_memory") {
      return respondControlError(c, 400, "NOT_CHAT_MEMORY");
    }

    // Fetch the agent's bindings: when filtering, remove not only this target but also **filter out the historical dirty bindings with canBindAsset=false
    // ** (e.g. others already switched the asset to private but the binding was not cleared), otherwise the next full-replace set
    // would trigger the kernel's asset_not_bindable 409. Here list-with-detail fetches, in one go,
    // the visibility of the asset behind each binding and filters locally, avoiding N asset/get calls.
    // Page through everything: set is a full replacement, and single-page truncation at 20 would silently clear the 21st+ bindings.
    let bindListError: MetaEnvelope<unknown> | null = null;
    interface BindingWithDetail {
      asset_id: string;
      asset_type: string;
      injection_mode?: string;
      priority?: number;
      created_by?: string;
      visibility?: string;
      status?: string;
    }
    const detailBindings = await fetchAllMetaListItems<BindingWithDetail>(
      deps,
      ctx,
      "agent-fixed-asset/list-with-detail",
      { agent_id: agentId, apply_visibility_filter: true, touch_usage: false },
      (env) => {
        bindListError = env;
      },
    );
    if (bindListError) return respondEnvelope(c, bindListError);

    // If blockId is not in the filtered items, either there was no binding to begin with, or the kernel decided the caller cannot bind;
    // both are treated as "the currently unbindable bindings do not include blockId" -> 404 for clear UI semantics
    // But the scenario "the binding exists but is filtered out because of private" must also be handled -- unbinding should be allowed there too,
    // so a second confirmation with an unfiltered list is needed to confirm the original binding exists.
    const targetInFilteredList = detailBindings.some(
      (b) => b.asset_id === blockId,
    );
    if (!targetInFilteredList) {
      // The second confirmation also pages through everything: if the target binding is at 21+, a single-page list would miss it and wrongly give 404
      let rawListError: MetaEnvelope<unknown> | null = null;
      const raw = await fetchAllMetaListItems<FixedAssetRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list",
        { agent_id: agentId },
        (env) => {
          rawListError = env;
        },
      );
      if (rawListError) return respondEnvelope(c, rawListError);
      const exists = raw.some((b) => b.asset_id === blockId);
      if (!exists) return respondControlError(c, 404, "BINDING_NOT_FOUND");
      // Exists but filtered out because of visibility -- this is a "dirty binding to be cleaned", so continue
    }

    // set uses the remaining items filtered with apply_visibility_filter=true (excluding the target blockId),
    // ensuring canBindAsset all pass.
    const remaining = detailBindings.filter((b) => b.asset_id !== blockId);
    const setEnv = await deps.metaKernel.invoke(
      "agent-fixed-asset/set",
      {
        agent_id: agentId,
        bindings: remaining.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? "summary",
          priority: b.priority ?? 50,
          created_by: b.created_by ?? meUserId,
        })),
      },
      ctx,
    );
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(
      c,
      okEnvelope(c, { unbound: true, agent_id: agentId, block_id: blockId }),
    );
  });

  // ── 4.4 Layered lazy loading ─────────────────────────────────────────
  //
  // POST /chat-memory/layer  body: { block_id, layer, limit?, offset? }
  //   layer ∈ 'L0' | 'L1' | 'L2' | 'L3'
  //
  // Reverse-parse team_id/agent_id from asset_id and call the tdai data plane (not /v3/meta/*):
  //   L0 → /v3/conversation/query
  //   L1 → /v3/atomic/query
  //   L2 → /v3/scenario/ls
  //   L3 → /v3/core/read
  //
  // Only supports the system auto-registered chat_memory-{team}-{agent} (agent_id can be reverse-parsed);
  // a user-created UserAsset (mem-xxx) has no associated agent and directly returns empty.
  api.post("/chat-memory/layer", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const layerRaw =
      typeof body?.layer === "string" ? body.layer.toUpperCase() : "";
    const limit =
      typeof body?.limit === "number" && body.limit > 0 && body.limit <= 200
        ? body.limit
        : 50;
    const offset =
      typeof body?.offset === "number" && body.offset >= 0 ? body.offset : 0;
    // before_ts: L0 cursor pagination parameter (ISO8601). From the second page on, the frontend passes "the created_at of the last message",
    // and the backend converts it to time_end (-1ms exclusive) for the kernel /v3/conversation/query, with offset reset to zero.
    // This way the VDB only needs to filter recorded_at_ms < cursor and does not need to skip a large number of records.
    const beforeTs =
      typeof body?.before_ts === "string" ? body.before_ts.trim() : undefined;
    // time_start / time_end: the detail page's time filter (ISO8601), only applied to time-stored L0 / L1;
    // L2 (scenario/ls) and L3 (core/read) are aggregated products with no time dimension in the kernel, so this filter is ignored.
    const timeStart = normalizeTimeInput(body?.time_start);
    const timeEnd = normalizeTimeInput(body?.time_end);

    if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
    if (!["L0", "L1", "L2", "L3"].includes(layerRaw))
      return respondControlError(c, 400, "INVALID_LAYER");
    const layer = layerRaw as "L0" | "L1" | "L2" | "L3";

    // Reverse-parse team_id / agent_id
    const parsed = parseChatMemoryAssetId(blockId);
    if (!parsed) {
      // User-created UserAsset -- no associated agent, no layer data to pull, directly return empty
      return respondEnvelope(
        c,
        okEnvelope(c, { layer, items: [], total: 0, limit, offset }),
      );
    }

    // Data-plane calls need additional team_id / agent_id / user_id / session_id
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    // ── ACL check: prevent reading private content just by knowing the asset_id ─────────────
    // Read is allowed if (any one of):
    //   a) the caller is the asset owner (keeping for own use)
    //   b) asset.visibility='team' (shared with the team)
    //   c) the asset is bound to some agent owned by the caller (import relationship)
    //
    // Asset metadata comes from asset/get; c requires iterating the fixed-list of the caller's agents.
    const assetEnv = await deps.metaKernel.invoke(
      "asset/get",
      { asset_id: blockId },
      ctx,
    );
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, "BLOCK_NOT_FOUND");
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== "chat_memory") {
      return respondControlError(c, 400, "NOT_CHAT_MEMORY");
    }

    // Read permission (any of owner / team-shared / borrowed) -- extracted into
    // authorizeChatMemoryRead for reuse, sharing the same ACL with /chat-memory/search, avoiding
    // permission-standard inconsistency caused by two diverging pieces of logic.
    const canRead = await authorizeChatMemoryRead(
      deps,
      ctx,
      asset,
      meUserId,
      blockId,
    );
    if (!canRead) return respondControlError(c, 403, "ASSET_NOT_ACCESSIBLE");

    // chat_memory data is written by the asset owner (isolated by their user_id), and the caller is not necessarily the owner
    // (import scenario). Use asset.owner_user_id as the data-plane user_id.
    const ownerUserId = asset.owner_user_id;

    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });

    // v3 strict isolation: session_id is required. Aggregation scenarios of the management plane pass 'default'
    const idFields = {
      team_id: parsed.teamId,
      agent_id: parsed.agentId,
      user_id: ownerUserId,
      session_id: "default",
    };

    try {
      if (layer === "L0") {
        // Key: without session_id, tdai aggregates all (team,user,agent) messages across sessions
        // tdai returns { messages: [...], total } rather than { items: [...] }
        const { session_id: _drop, ...noSid } = idFields;
        void _drop;

        // Cursor pagination: before_ts -> time_end (-1ms exclusive).
        // The kernel /v3/conversation/query time_end means recorded_at_ms <= timeEndMs (inclusive),
        // while the cursor semantics need exclusive (< beforeTs), otherwise the last item would be returned again.
        // Subtracting 1ms turns inclusive into exclusive. Millisecond precision is sufficient (duplicates within the same ms are rare and the frontend dedups by id as a fallback).
        const l0Query: Record<string, unknown> = { ...noSid };
        if (timeStart) l0Query.time_start = timeStart;
        // Take the earlier of the cursor upper bound (before_ts) and the filter upper bound (time_end) (intersection): paging must not go beyond the user-selected time range.
        let l0TimeEnd = timeEnd;
        if (beforeTs) {
          const d = new Date(beforeTs);
          if (Number.isFinite(d.getTime())) {
            const cursorEnd = new Date(d.getTime() - 1).toISOString();
            l0TimeEnd =
              !l0TimeEnd || cursorEnd < l0TimeEnd ? cursorEnd : l0TimeEnd;
            l0Query.offset = 0; // offset reset to zero in cursor mode
          }
        } else {
          l0Query.offset = offset;
        }
        if (l0TimeEnd) l0Query.time_end = l0TimeEnd;
        l0Query.limit = limit;

        const env = await deps.kernelHttp.postEnvelope<{
          messages?: unknown[];
          total?: number;
        }>("/v3/conversation/query", l0Query, cred);
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as {
          messages?: Array<Record<string, unknown>>;
          total?: number;
        } | null) ?? { messages: [] };
        // Range-too-large detection: total > 0 and offset is still within the total, but this page returned empty -- TCVDB paginated queries silently return an empty set when exceeding
        // the supportable window (see MemoryCore tcvdb.ts); this combination cannot be "truly no data",
        // it can only be that the query was rejected by the VDB, so prompt the user to narrow the filtered time range.
        if (
          isRangeTooLarge(data.total ?? 0, (data.messages ?? []).length, offset)
        ) {
          return respondControlError(c, 400, "RANGE_TOO_LARGE");
        }
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: (data.messages ?? []).map((m) => ({
              id: m.id ?? "",
              role: typeof m.role === "string" ? m.role : "msg",
              title: `${m.role ?? "msg"} @ ${m.session_id ?? ""}`,
              body:
                typeof m.content === "string"
                  ? m.content
                  : JSON.stringify(m.content ?? ""),
              tags: m.role ? [String(m.role)] : [],
              refs: [],
              // L0 time sources (actually returned by the v3 kernel):
              //   - timestamp (ISO string) -- the standard field of kernel conversation/query
              //   - recorded_at_ms / timestamp numeric ms -- some old data / internal fields
              created_at:
                (typeof m.timestamp === "string" && m.timestamp) ||
                msToIso(m.recorded_at_ms) ||
                msToIso(m.timestamp) ||
                undefined,
            })),
            total: data.total ?? (data.messages ?? []).length,
            limit,
            offset,
          }),
        );
      }

      if (layer === "L1") {
        const l1Query: Record<string, unknown> = { ...idFields, limit, offset };
        if (timeStart) l1Query.time_start = timeStart;
        if (timeEnd) l1Query.time_end = timeEnd;
        const env = await deps.kernelHttp.postEnvelope<{
          items?: unknown[];
          total?: number;
        }>("/v3/atomic/query", l1Query, cred);
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as {
          items?: Array<Record<string, unknown>>;
          total?: number;
        } | null) ?? { items: [] };
        // Same as L0: total > 0 but this page empty = filter range too large, and the VDB cannot support this query.
        if (
          isRangeTooLarge(data.total ?? 0, (data.items ?? []).length, offset)
        ) {
          return respondControlError(c, 400, "RANGE_TOO_LARGE");
        }
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: (data.items ?? []).map((r) => ({
              id: r.record_id ?? r.id,
              title: (r.type ?? "atomic") as string,
              body: r.content ?? "",
              tags: r.tags ?? [],
              refs: [],
              // L1 time sources (actually returned by the v3 kernel):
              //   - created_at (ISO string) -- the standard field of kernel atomic/query
              //   - created_time_ms (numeric ms) / timestamp_str -- old data compatibility
              created_at:
                (typeof r.created_at === "string" && r.created_at) ||
                msToIso(r.created_time_ms) ||
                (typeof r.timestamp_str === "string" && r.timestamp_str
                  ? r.timestamp_str
                  : undefined),
            })),
            total: data.total ?? (data.items ?? []).length,
            limit,
            offset,
          }),
        );
      }

      if (layer === "L2") {
        const requestedPath =
          typeof body?.path === "string" ? body.path.trim() : "";
        if (requestedPath) {
          const readEnv = await deps.kernelHttp.postEnvelope<{
            content?: string | null;
          }>("/v3/scenario/read", { ...idFields, path: requestedPath }, cred);
          if (readEnv.code !== 0) return respondEnvelope(c, readEnv);
          const readData = readEnv.data as { content?: string | null } | null;
          const content =
            typeof readData?.content === "string" ? readData.content : "";
          const readTime =
            (
              readData as
                | {
                    updated_at?: string;
                    modified_at?: string;
                    created_at?: string;
                  }
                | null
                | undefined
            )?.updated_at ??
            (readData as { modified_at?: string } | null | undefined)
              ?.modified_at ??
            (readData as { created_at?: string } | null | undefined)
              ?.created_at;
          return respondEnvelope(
            c,
            okEnvelope(c, {
              layer,
              items: [
                {
                  id: requestedPath,
                  title: requestedPath,
                  body: content,
                  tags: content ? ["markdown"] : [],
                  refs: [],
                  created_at: readTime,
                },
              ],
              total: content ? 1 : 0,
              limit: 1,
              offset: 0,
            }),
          );
        }

        // scenario/ls only returns the L2 title list; the specific Markdown source is fetched when the frontend
        // clicks a single entry and comes back to this endpoint with a path to trigger scenario/read, avoiding opening all md at once.
        const env = await deps.kernelHttp.postEnvelope<{
          entries?: unknown[];
          total?: number;
        }>("/v3/scenario/ls", idFields, cred);
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as {
          entries?: Array<Record<string, unknown>>;
          total?: number;
        } | null) ?? { entries: [] };
        const entries = data.entries ?? [];
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: entries.map((r) => {
              const path =
                typeof r.path === "string" ? r.path : String(r.id ?? "");
              // L2 time sources (scenario/ls): updated_at / modified_at / updated_time_ms
              const t =
                (typeof r.updated_at === "string" && r.updated_at) ||
                (typeof r.modified_at === "string" && r.modified_at) ||
                msToIso(r.updated_time_ms) ||
                undefined;
              return {
                id: path,
                title: path,
                body: "",
                tags: [],
                refs: [],
                created_at: t,
              };
            }),
            total: data.total ?? entries.length,
            limit,
            offset,
          }),
        );
      }

      // L3
      const env = await deps.kernelHttp.postEnvelope<{
        content?: string;
        version?: string;
        updated_at?: string;
      }>("/v3/core/read", idFields, cred);
      if (env.code !== 0) return respondEnvelope(c, env);
      const data =
        (env.data as {
          content?: string;
          version?: string;
          updated_at?: string;
        } | null) ?? {};
      const content = stripL3SceneTail(data.content ?? "");
      return respondEnvelope(
        c,
        okEnvelope(c, {
          layer,
          items: content
            ? [
                {
                  id: "core",
                  title: "core memory",
                  body: content,
                  tags: [],
                  refs: [],
                  created_at: data.updated_at,
                },
              ]
            : [],
          total: content ? 1 : 0,
          limit,
          offset,
        }),
      );
    } catch (err) {
      return respondControlError(
        c,
        500,
        `LAYER_FETCH_ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ==========================================================================
  // POST /chat-memory/clear  body: { memory_ids: string[] }
  //
  // One-click clear of **all content** of several chat_memory, while keeping the asset itself: asset_id,
  // Team/Agent ownership, Agent bindings, ACL, Owner, name, and visibility are all unchanged; after clearing
  // the Agent keeps writing with the original memory_id, with no need to recreate it.
  //
  // Permission: asset Owner only. The panel only does a quick pre-check of "must be chat_memory and the caller is the owner"
  // (giving a readable error code); the final authoritative validation is in the kernel
  // `/v3/chat-memory/clear` (also Owner-only there, and if any id is invalid the whole batch is rejected).
  //==========================================================================
  api.post("/chat-memory/clear", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);

    const rawIds = body?.memory_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return respondControlError(c, 400, "MISSING_MEMORY_IDS");
    }
    // Dedup + drop empty strings; the limit is aligned with the kernel CHAT_MEMORY_CLEAR_MAX.
    const memoryIds = [
      ...new Set(
        rawIds
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      ),
    ];
    if (memoryIds.length === 0)
      return respondControlError(c, 400, "MISSING_MEMORY_IDS");
    if (memoryIds.length > MAX_CLEAR_MEMORY_IDS) {
      return respondControlError(c, 400, "TOO_MANY_MEMORY_IDS");
    }

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    // Pre-validate the whole batch: if any id does not exist / is not chat_memory / is not owned -> reject the whole batch,
    // and clear nothing. Consistent with the kernel semantics, avoiding "erroring out after clearing half".
    for (const memoryId of memoryIds) {
      const assetEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: memoryId },
        ctx,
      );
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory") {
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      }
      if (asset.owner_user_id !== meUserId) {
        return respondControlError(c, 403, "NOT_ASSET_OWNER");
      }
    }

    const cred = toKernelCredentials(ctx, { timeoutMs: 60_000 });
    try {
      const env = await deps.kernelHttp.postEnvelope<unknown>(
        "/v3/chat-memory/clear",
        { memory_ids: memoryIds },
        cred,
      );
      return respondEnvelope(c, env);
    } catch (err) {
      return respondControlError(
        c,
        500,
        `CLEAR_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ==========================================================================
  // POST /chat-memory/layer-delete
  //   body: { block_id, layer: 'L0' | 'L1', message_ids?, session_ids?, ids? }
  //
  // Bulk delete entry of the detail page lists:
  //   L0 -> /v3/conversation/delete (message_ids up to 5000 / session_ids up to 100)
  //   L1 -> /v3/atomic/delete       (ids up to 5000)
  //
  // Permission: asset Owner only -- reading can be imported (see the ACL of /chat-memory/layer),
  // but deleting content is allowed for the Owner only, to prevent the importer from wiping others' memory.
  // ==========================================================================
  api.post(
    "/chat-memory/layer-delete",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      const layerRaw =
        typeof body?.layer === "string" ? body.layer.toUpperCase() : "";

      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
      if (layerRaw !== "L0" && layerRaw !== "L1")
        return respondControlError(c, 400, "INVALID_LAYER");
      const layer = layerRaw as "L0" | "L1";

      const parsed = parseChatMemoryAssetId(blockId);
      // A user-created UserAsset (mem-xxx) has no associated agent and no data-plane content to delete.
      if (!parsed) return respondControlError(c, 400, "NOT_AGENT_MEMORY");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      const assetEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: blockId },
        ctx,
      );
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory")
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      if (asset.owner_user_id !== meUserId)
        return respondControlError(c, 403, "NOT_ASSET_OWNER");

      // The data plane isolates by the asset owner's user_id (consistent with /chat-memory/layer).
      const idFields = {
        team_id: parsed.teamId,
        agent_id: parsed.agentId,
        user_id: asset.owner_user_id,
        session_id: "default",
      };

      const cred = toKernelCredentials(ctx, { timeoutMs: 60_000 });
      try {
        if (layer === "L0") {
          const messageIds = normalizeIdList(
            body?.message_ids,
            MAX_L0_DELETE_MESSAGE_IDS,
          );
          const sessionIds = normalizeIdList(
            body?.session_ids,
            MAX_L0_DELETE_SESSION_IDS,
          );
          if (messageIds === null || sessionIds === null) {
            return respondControlError(c, 400, "TOO_MANY_IDS");
          }
          if (messageIds.length === 0 && sessionIds.length === 0) {
            return respondControlError(c, 400, "MISSING_IDS");
          }
          // No session_id: takes effect across sessions by (team, user, agent),
          // consistent with the aggregation standard of reading L0 in /chat-memory/layer.
          const { session_id: _drop, ...noSid } = idFields;
          void _drop;
          const env = await deps.kernelHttp.postEnvelope<{
            deleted_count?: number;
          }>(
            "/v3/conversation/delete",
            {
              ...noSid,
              ...(messageIds.length > 0 ? { message_ids: messageIds } : {}),
              ...(sessionIds.length > 0 ? { session_ids: sessionIds } : {}),
            },
            cred,
          );
          return respondEnvelope(c, env);
        }

        const ids = normalizeIdList(body?.ids, MAX_L1_DELETE_IDS);
        if (ids === null) return respondControlError(c, 400, "TOO_MANY_IDS");
        if (ids.length === 0) return respondControlError(c, 400, "MISSING_IDS");
        const env = await deps.kernelHttp.postEnvelope<{
          deleted_count?: number;
        }>("/v3/atomic/delete", { ...idFields, ids }, cred);
        return respondEnvelope(c, env);
      } catch (err) {
        return respondControlError(
          c,
          500,
          `LAYER_DELETE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ==========================================================================
  // POST /chat-memory/layer-update
  //   body: { block_id, layer: 'L1'|'L2'|'L3', id?, content, summary? }
  //
  // Edit single-layer memory content (Owner-only -- same standard as layer-delete / clear: reading can be imported,
  // but modifying content is allowed for the asset Owner only, to prevent the importer from altering others' memory):
  //   L1 -> /v3/atomic/update   { id, content }         (id = record primary key record_id)
  //   L2 -> /v3/scenario/write  { path, content, summary? } (path = file path; content
  //        has the META header stripped first, and the kernel rebuilds it from the existing META)
  //   L3 -> /v3/core/write      { content }              (the kernel strips scene navigation automatically)
  // ==========================================================================
  api.post(
    "/chat-memory/layer-update",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      const layerRaw =
        typeof body?.layer === "string" ? body.layer.toUpperCase() : "";
      const content = typeof body?.content === "string" ? body.content : null;
      const itemId = typeof body?.id === "string" ? body.id.trim() : "";
      const summary =
        typeof body?.summary === "string" ? body.summary : undefined;

      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
      if (layerRaw !== "L1" && layerRaw !== "L2" && layerRaw !== "L3")
        return respondControlError(c, 400, "INVALID_LAYER");
      const layer = layerRaw as "L1" | "L2" | "L3";
      if (content === null) return respondControlError(c, 400, "MISSING_CONTENT");
      // L1 (record primary key) / L2 (file path) both need to locate a single entry; L3 is the whole persona and needs no id.
      if ((layer === "L1" || layer === "L2") && !itemId)
        return respondControlError(c, 400, "MISSING_ITEM_ID");

      const parsed = parseChatMemoryAssetId(blockId);
      // A user-created UserAsset (mem-xxx) has no associated agent and no data-plane content to modify.
      if (!parsed) return respondControlError(c, 400, "NOT_AGENT_MEMORY");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      const assetEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: blockId },
        ctx,
      );
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory")
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      if (asset.owner_user_id !== meUserId)
        return respondControlError(c, 403, "NOT_ASSET_OWNER");

      // The data plane isolates by the asset owner's user_id (consistent with /chat-memory/layer).
      const idFields = {
        team_id: parsed.teamId,
        agent_id: parsed.agentId,
        user_id: asset.owner_user_id,
        session_id: "default",
      };

      const cred = toKernelCredentials(ctx, { timeoutMs: 30_000 });
      try {
        if (layer === "L1") {
          const env = await deps.kernelHttp.postEnvelope<unknown>(
            "/v3/atomic/update",
            { ...idFields, id: itemId, content },
            cred,
          );
          return respondEnvelope(c, env);
        }
        if (layer === "L2") {
          const env = await deps.kernelHttp.postEnvelope<unknown>(
            "/v3/scenario/write",
            {
              ...idFields,
              path: itemId,
              content: stripScenarioMeta(content),
              ...(summary !== undefined ? { summary } : {}),
            },
            cred,
          );
          return respondEnvelope(c, env);
        }
        // L3
        const env = await deps.kernelHttp.postEnvelope<unknown>(
          "/v3/core/write",
          { ...idFields, content },
          cred,
        );
        return respondEnvelope(c, env);
      } catch (err) {
        return respondControlError(
          c,
          500,
          `LAYER_UPDATE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ==========================================================================
  // POST /chat-memory/search
  //   body: { block_id, layer: 'L0'|'L1', query, limit?, type? }
  //
  // Layered semantic / keyword retrieval (agent-dimension cross-session recall):
  //   L0 -> kernel /v3/conversation/search (conversation messages, returns messages with score)
  //   L1 -> kernel /v3/atomic/search (atomic memory, returns items with score)
  // Permission: read permission (owner / team-shared / borrowed, consistent with /chat-memory/layer,
  // searching is a read operation). Uniformly returns { items, total }, with each item carrying a score (relevance).
  // ==========================================================================
  api.post("/chat-memory/search", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const layerRaw =
      typeof body?.layer === "string" ? body.layer.toUpperCase() : "L1";
    // Currently only L0 (conversation) / L1 (atomic memory) are supported; everything else is treated as L1.
    const layer: "L0" | "L1" = layerRaw === "L0" ? "L0" : "L1";
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    const rawLimit = typeof body?.limit === "number" ? body.limit : 30;
    const limit = Math.min(100, Math.max(1, Math.floor(rawLimit)));
    const type =
      typeof body?.type === "string" && body.type.trim()
        ? body.type.trim()
        : undefined;

    if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
    if (!query) return respondControlError(c, 400, "MISSING_QUERY");

    const parsed = parseChatMemoryAssetId(blockId);
    // A self-created UserAsset has no associated agent -> no L1 data to search, directly return empty (consistent with layer semantics).
    if (!parsed)
      return respondEnvelope(c, okEnvelope(c, { items: [], total: 0 }));

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    const assetEnv = await deps.metaKernel.invoke(
      "asset/get",
      { asset_id: blockId },
      ctx,
    );
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, "BLOCK_NOT_FOUND");
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== "chat_memory")
      return respondControlError(c, 400, "NOT_CHAT_MEMORY");

    const canRead = await authorizeChatMemoryRead(
      deps,
      ctx,
      asset,
      meUserId,
      blockId,
    );
    if (!canRead) return respondControlError(c, 403, "ASSET_NOT_ACCESSIBLE");

    const idFields = {
      team_id: parsed.teamId,
      agent_id: parsed.agentId,
      user_id: asset.owner_user_id,
      session_id: "default",
    };
    const cred = toKernelCredentials(ctx, { timeoutMs: 30_000 });
    try {
      if (layer === "L0") {
        // L0: conversation message retrieval. The kernel returns { messages }, mapped to the unified { items }.
        // No session_id (global cross-session recall, consistent with reading L0 in /chat-memory/layer).
        const { session_id: _drop, ...noSid } = idFields;
        void _drop;
        const env = await deps.kernelHttp.postEnvelope<{
          messages?: unknown[];
        }>("/v3/conversation/search", { ...noSid, query, limit }, cred);
        if (env.code !== 0) return respondEnvelope(c, env);
        const data =
          (env.data as { messages?: Array<Record<string, unknown>> } | null) ??
          { messages: [] };
        const items = (data.messages ?? []).map((m) => ({
          id: (m.id ?? "") as string,
          role: typeof m.role === "string" ? m.role : "msg",
          title: (typeof m.role === "string" ? m.role : "msg") as string,
          body:
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content ?? ""),
          tags: typeof m.role === "string" ? [m.role] : [],
          refs: [] as string[],
          score: typeof m.score === "number" ? m.score : undefined,
          created_at:
            (typeof m.timestamp === "string" && m.timestamp) ||
            msToIso(m.recorded_at) ||
            msToIso(m.timestamp) ||
            undefined,
        }));
        return respondEnvelope(
          c,
          okEnvelope(c, { items, total: items.length }),
        );
      }

      // L1: atomic memory retrieval
      const env = await deps.kernelHttp.postEnvelope<{ items?: unknown[] }>(
        "/v3/atomic/search",
        { ...idFields, query, limit, ...(type ? { type } : {}) },
        cred,
      );
      if (env.code !== 0) return respondEnvelope(c, env);
      const data =
        (env.data as { items?: Array<Record<string, unknown>> } | null) ?? {
          items: [],
        };
      const items = (data.items ?? []).map((r) => ({
        // The search result id is the L1 record primary key (can be used directly for /chat-memory/layer-update).
        id: (r.id ?? r.record_id ?? "") as string,
        title: (r.type ?? "atomic") as string,
        body: (r.content ?? "") as string,
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
        refs: [] as string[],
        score: typeof r.score === "number" ? r.score : undefined,
        created_at:
          (typeof r.created_at === "string" && r.created_at) ||
          msToIso(r.created_time_ms) ||
          (typeof r.updated_at === "string" ? r.updated_at : undefined),
      }));
      return respondEnvelope(
        c,
        okEnvelope(c, { items, total: items.length }),
      );
    } catch (err) {
      return respondControlError(
        c,
        500,
        `SEARCH_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Parse team_id / agent_id from chat_memory-{team_id}-{agent_id}
 * Relies on the stable prefix that agent ids start with `agt`.
 */ function parseChatMemoryAssetId(
  assetId: string,
): { teamId: string; agentId: string } | null {
  if (!assetId.startsWith("chat_memory-")) return null;
  const idx = assetId.lastIndexOf("-agt");
  if (idx < 0) return null;
  const inner = assetId.slice("chat_memory-".length);
  const dashAgt = inner.lastIndexOf("-agt");
  if (dashAgt < 0) return null;
  return {
    teamId: inner.slice(0, dashAgt),
    agentId: inner.slice(dashAgt + 1),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function buildCtx(c: import("hono").Context): MetaCallContext {
  const panelMeta = c.get("panelMeta");
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get("reqId"),
  };
}

async function readJson(
  c: import("hono").Context,
): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function requiredTeamId(body: Record<string, unknown>): string | null {
  const t = body?.team_id;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

function requiredBlockId(body: Record<string, unknown>): string | null {
  const t = body?.block_id;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

// ── Bulk delete limits (kept consistent with the kernel MemoryCore/src/gateway/v2-schemas.ts) ──
/** Number of memories /chat-memory/clear can clear at a time. */
const MAX_CLEAR_MEMORY_IDS = 100;
/** L0 bulk delete: message_ids limit. */
const MAX_L0_DELETE_MESSAGE_IDS = 5000;
/** L0 bulk delete: session_ids limit. */
const MAX_L0_DELETE_SESSION_IDS = 100;
/** L1 bulk delete: ids limit. */
const MAX_L1_DELETE_IDS = 5000;

/**
 * Normalize the id list passed from the frontend: keep only non-empty strings, dedupe, preserve original order.
 *
 * @returns the normalized array; returns null when it exceeds max (the caller converts it to 400).
 *          Non-array / omitted is treated as "none selected", returning an empty array.
 */
function normalizeIdList(raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw)) return [];
  const ids = [
    ...new Set(
      raw
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  ];
  return ids.length > max ? null : ids;
}

function extractListItems<T>(env: MetaEnvelope<unknown>): T[] {
  const d = env.data as unknown;
  if (
    d &&
    typeof d === "object" &&
    Array.isArray((d as ListEnvelopeData<T>).items)
  ) {
    return (d as ListEnvelopeData<T>).items;
  }
  return [];
}

function isActive(a: AssetRaw): boolean {
  return (
    a.status !== "archived" &&
    a.status !== "deprecated" &&
    a.status !== "failed"
  );
}

function emptyLayers(): MemoryBlockOut["layer_counts"] {
  return { L0_messages: 0, L1: 0, L2: 0, L3: 0 };
}

function buildSummary(): string {
  return "0 L1 · 0 L2 · 0 L3";
}

/**
 * Strip the META header from scenario markdown.
 * The content returned by `scenario/read` carries a `-----META-START-----...-----META-END-----`
 * header (system fields such as created / updated / summary), while `scenario/write` expects the body
 * to **not contain** META (the kernel rebuilds it from the existing META). Strip META before writing back an edit, to avoid
 * META being treated as body and wrapped again, causing nesting.
 */
function stripScenarioMeta(content: string): string {
  return content
    .replace(/^-----META-START-----\n[\s\S]*?\n-----META-END-----\n?/, "")
    .replace(/^\n+/, "");
}

function stripL3SceneTail(content: string): string {
  const withFooter = content.search(
    /\n---\s*\n\s*> \*\*(?:最后更新|Last updated)\*\*[\s\S]*?\n---\s*\n## 🗺️ Scene Navigation/,
  );
  if (withFooter >= 0) return content.slice(0, withFooter).trimEnd();
  const sceneIndex = content.search(
    /\n---\s*\n## 🗺️ Scene Navigation|\n## 🗺️ Scene Navigation/,
  );
  if (sceneIndex >= 0) return content.slice(0, sceneIndex).trimEnd();
  return content;
}

function toMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * The kernel chat_memory L0/L1 layers store millisecond timestamps (recorded_at_ms / created_time_ms);
 * the frontend display needs ISO strings (renderable via Date.toLocaleString), converted uniformly here.
 * Only accepts numbers that "look like ms epoch" (> 10^12, roughly after 2001-09); anything else returns undefined
 * so the caller falls back to other fields (such as timestamp_str / updated_at).
 */
function msToIso(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1e12)
    return undefined;
  try {
    return new Date(v).toISOString();
  } catch {
    return undefined;
  }
}

function okEnvelope<T>(c: import("hono").Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: "ok", request_id: c.get("reqId") ?? "", data };
}

/**
 * Look up the caller's user_id via auth/verify.
 * Returns null if envelope.data.user.user_id is empty or invalid.
 */
async function resolveCallerUserId(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<string | null> {
  if (!ctx.userKey) return null;
  const env = await deps.metaKernel.invoke(
    "auth/verify",
    { user_key: ctx.userKey },
    ctx,
  );
  if (env.code !== 0) return null;
  const data = env.data as {
    valid?: boolean;
    user?: { user_id?: string };
  } | null;
  if (!data?.valid) return null;
  const uid = data.user?.user_id;
  return typeof uid === "string" && uid.length > 0 ? uid : null;
}

/**
 * Verify whether the user is a team member.
 * Goes through tdai `/v3/meta/team-member/get` (exists -> member; 404 -> non-member).
 * When the kernel throws, conservatively returns false (reject) to avoid fail-open.
 */
async function isTeamMember(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
): Promise<boolean> {
  if (!teamId || !userId) return false;
  try {
    const env = await deps.metaKernel.invoke(
      "team-member/get",
      { team_id: teamId, user_id: userId },
      ctx,
    );
    if (env.code === 0 && env.data) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * **Read permission** check for chat_memory assets (any of owner / team-shared / borrowed):
 *   a) the caller is the asset owner (keeping for own use)
 *   b) asset.visibility='team' and caller is in the team (shared with the team; a user outside the team is not readable even if they know the
 *      asset_id, preventing unauthorized reads of chat_memory content)
 *   c) the asset is bound to some agent owned by the caller (import relationship)
 * Reused by /chat-memory/layer and /chat-memory/search to keep the read standard consistent.
 */
async function authorizeChatMemoryRead(
  deps: PanelDeps,
  ctx: MetaCallContext,
  asset: AssetRaw,
  meUserId: string,
  blockId: string,
): Promise<boolean> {
  if (asset.owner_user_id === meUserId) return true;
  if (asset.visibility === "team") {
    if (await isTeamMember(deps, ctx, asset.team_id, meUserId)) return true;
  }
  // Borrow check: iterate the agents the caller owns in this team and see whether any has bound this asset.
  try {
    // Page through everything: single-page truncation at 20 would make the borrow check miss agents ranked 21+, wrongly judging no permission
    const myAgents = (
      await fetchAllMetaListItems<AgentRaw>(
        deps,
        ctx,
        "agent/list",
        { team_id: asset.team_id, status: "active" },
      )
    ).filter((a) => a.owner_user_id === meUserId);
    for (const a of myAgents) {
      // Page through everything: if this asset ranks 21+ in an agent's bindings, a single-page list would miss it and wrongly judge no permission.
      // On error, same as before (continue to skip that agent), not blocking the judgement of the other agents.
      const bindings = await fetchAllMetaListItems<FixedAssetRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list",
        { agent_id: a.agent_id },
      );
      if (bindings.some((b) => b.asset_id === blockId)) return true;
    }
  } catch {
    /* fallthrough → deny */
  }
  return false;
}

// countBindings was retired along with the N+1 optimization of team-assets; if the right-hand detail panel later needs to fetch
// a single binding count on demand, implement it via a separate endpoint (body: {team_id, block_id}); do not put it back in the list loop.
