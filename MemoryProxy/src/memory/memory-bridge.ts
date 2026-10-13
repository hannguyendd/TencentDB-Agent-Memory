/**
 * memory-bridge — reverse proxy for `<proxy>/memory-bridge/v3/*` → tdai gateway.
 *
 * Design idea is isomorphic with src/skill/skill-bridge.ts:
 *   - Do not stuff native tool definitions into body.tools (the agent host does not recognize them)
 *   - Inject the text `<tdai_memory_tools>` to guide the LLM to use Bash curl against this bridge
 *   - The bridge forcibly injects session IdFields + serviceToken auth, then forwards to tdai
 *
 * Behavior:
 *   1. The path must be /memory-bridge/v3/{sub}; sub must be within ALLOWED_SUBPATHS
 *   2. Force POST + Content-Type application/json
 *   3. The session must be identifiable (x-conversation-id / x-session-id ...), otherwise 401
 *   4. team_id/user_id/agent_id/session_id in the body are always overwritten by the session values (anti-forgery)
 *   5. Forward to ${coreSkill.endpoint}/v3/{sub}, adding the Bearer + service-id headers
 *   6. Pass through status and JSON body
 *
 * Security:
 *   - The allowlist restricts to read-only search / read subpaths; mutations go through the main path
 *   - Write operations such as atomic/update / scenario/write / core/write are not accepted
 *   - v3 strict isolation: forcibly inject session_id to satisfy the L0/L1 required fields
 */

import type { Context } from "hono";
import { getSessionStore } from "../session/store.js";
import type { BindingRepo } from "../db/binding-repo.js";
import type { ProxyConfig } from "../types.js";
import { getMetadataClient } from "../meta/client.js";
import type { AgentContext } from "../injection/types.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "../injection/injectors/tdai-fixed-asset.js";
import type { TdaiIdentity } from "../tdai/types.js";
import { emitBridgeToolCallTelemetry, emitBridgeRejectTelemetry, agentSourceFromSessionKey } from "./bridge-telemetry.js";

const TAG = "[memory-bridge]";

/**
 * Tdai subpaths allowed to be forwarded through the bridge (**read-only**, invoked by the LLM on demand via the Bash tool).
 *
 * Design trade-offs:
 *   - L0/L1 are no longer auto-recalled every turn; instead they are retrieved on demand via static tools (cache-friendly), so
 *     the search/query of atomic/* and conversation/* are allowed.
 *   - L2: the system provides the index `<l2_scene_index>`, and the full text is read on demand → scenario/ls + scenario/read are allowed.
 *   - L3 (persona): injected directly into the system, no tool needed → **core/read is not allowed**.
 *
 * Write operations (write / rm / add / update / delete) are never in the allowlist; writes go through the main path.
 */
const ALLOWED_SUBPATHS = new Set<string>([
  "atomic/search",        // L1 atomic memory hybrid search
  "atomic/query",         // L1 by type/time/pagination
  "conversation/search",  // L0 conversation hybrid search
  "conversation/query",   // L0 fetch history by session
  "scenario/ls",          // L2 scenario list (path index)
  "scenario/read",        // L2 read full text by path
]);

interface SessionIdFields {
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  task_id?: string;
  user_key?: string;
  /**
   * Kernel tenant/instance ID for `x-tdai-service-id`. Extracted from
   * `SessionInfo.space_id` (originally from the request path `/{agent}/{spaceId}/...`).
   * Using it for tenant routing is the correct form; `config.tdai.serviceId` /
   * `config.coreSkill.serviceId` serve only as a fallback for old sessions (cached before the migration).
   */
  space_id?: string;
  /**
   * Composite key actually used to load state from SessionStore
   * (`${agentSource}:${sessionId}`). Used so telemetry aligns with the session_key in session_init_logs
   * -- telemetry must not guess the prefix; it must use the key that was actually hit.
   */
  composite_key?: string;
  /**
   * Client family label (claude-code / codebuddy / codex / workbuddy / dsh / opencode / pi).
   * Taken from the prefix of the session composite key → used for the `agent_source` field of emitBridgeRejectTelemetry,
   * aligning with the client dimension on the session_init_logs side.
   * Not required: for old sessions whose key was not split it is undefined, and an empty value in telemetry is acceptable.
   */
  agent_source?: string;
}

/**
 * The curl template fixes 2 headers:
 *   - x-conversation-id → sessionId
 *   - x-tdai-service-id → spaceId
 *
 * No longer takes Authorization. See docs/design/2026-08-03-binding-flatten.md.
 */
function deriveSessionId(c: Context): string | null {
  // subagent normalization: when x-parent-conversation-id is present, prefer the parent id, so that a subagent
  // calling the bridge tool hits the main session's binding, avoiding session_not_initialized
  // (aligned with session/session-key.ts, 2026-09-20 WorkBuddy subagent fix).
  const parentId = c.req.header("x-parent-conversation-id");
  if (parentId && parentId.length > 0) return parentId;
  return (
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    c.req.header("x-claude-code-session-id") ??
    null
  );
}

function toIdFields(
  state: import("../session/types.js").SessionInitState | undefined,
  compositeKey: string,
): SessionIdFields | null {
  if (!state || state.status !== "initialized" || !state.sessionInfo) return null;
  const s = state.sessionInfo;
  if (!s.user_id || !s.team_id || !s.agent_id || !s.session_id) return null;
  return {
    user_id: s.user_id,
    team_id: s.team_id,
    agent_id: s.agent_id,
    session_id: s.session_id,
    task_id: s.task_id,
    user_key: s.user_key,
    space_id: s.space_id,
    composite_key: compositeKey,
  };
}

function bindingToIdFields(
  binding: import("../db/binding-repo.js").SessionBinding,
  spaceId: string,
  sessionId: string,
): SessionIdFields | null {
  if (binding.outcome !== "initialized") return null;
  if (!binding.userId || !binding.teamId || !binding.agentId) return null;
  const agentSource = binding.agentSource || "claude-code";
  return {
    user_id: binding.userId,
    team_id: binding.teamId,
    agent_id: binding.agentId,
    session_id: sessionId,
    task_id: binding.taskId,
    user_key: binding.userKey,
    space_id: spaceId,
    composite_key: `${agentSource}:${sessionId}`,
  };
}

/**
 * L1 fast path — try in-memory Map with prefix fallback.
 * Returns null on miss (caller decides whether to probe L2).
 */
function loadSessionIdsL1(sessionId: string): SessionIdFields | null {
  // The L1 key stored by the handler layer looks like `${agentSource}:${sessionId}`; what curl gets
  // is usually a bare sessionId. Probe in candidate-prefix order and return on the first hit.
  const candidates = sessionId.includes(":")
    ? [sessionId]
    : [sessionId, `codebuddy:${sessionId}`, `claude-code:${sessionId}`];
  for (const k of candidates) {
    const state = getSessionStore().get(k);
    if (state) {
      const fields = toIdFields(state, k);
      if (fields) return fields;
    }
  }
  return null;
}

/**
 * L2 fallthrough -- after flattening, only takes (spaceId, sessionId). See
 * docs/design/2026-08-03-binding-flatten.md。
 *
 * No longer goes through the verifyUserKey + getOrRecover 4-segment path:
 *   1) the bridge curl template has no bearer, so verify cannot get userId
 *   2) after flattening, binding.json already stores user_id/team_id/agent_id/agent_source/user_key,
 *      a single GET collects the IdFields directly
 */
async function loadSessionIdsL2(
  bindingRepo: BindingRepo | null,
  spaceId: string,
  sessionId: string,
): Promise<SessionIdFields | null> {
  if (!bindingRepo) return null;
  try {
    const binding = await bindingRepo.getBinding(spaceId, sessionId);
    if (!binding) return null;
    return bindingToIdFields(binding, spaceId, sessionId);
  } catch (err) {
    console.warn(`${TAG} L2 getBinding error space=${spaceId} sid=${sessionId}: ${(err as Error).message}`);
    return null;
  }
}

function envelope(code: number, message: string, httpStatus = 200): Response {
  return new Response(
    JSON.stringify({ code, message, request_id: `mem-bridge-${Date.now()}` }),
    { status: httpStatus, headers: { "content-type": "application/json" } },
  );
}

function extractSubpath(path: string): string | null {
  const m = path.match(/^\/memory-bridge\/v3\/(.+)$/);
  if (!m) return null;
  return m[1].replace(/\/+$/, "");
}

function selfCtx(ids: SessionIdFields): FixedAssetCtx {
  return { teamId: ids.team_id, userId: ids.user_id, agentId: ids.agent_id, agentName: ids.agent_id, isSelf: true };
}

async function resolveMemoryCtxs(config: ProxyConfig, ids: SessionIdFields, sessionKey: string): Promise<FixedAssetCtx[]> {
  if (!ids.user_key) return [selfCtx(ids)];
  try {
    const serviceId = ids.space_id || config.tdai?.serviceId || config.coreSkill.serviceId;
    const metadataClient = getMetadataClient(config.coreSkill, serviceId, ids.user_key);
    const identity: TdaiIdentity = {
      teamId: ids.team_id,
      userId: ids.user_id,
      agentId: ids.agent_id,
      sessionId: ids.session_id,
      taskId: ids.task_id,
      userKey: ids.user_key,
    };
    const fakeCtx: AgentContext = {
      messages: [],
      tools: [],
      requestParams: {},
      metadata: {
        protocol: "anthropic",
        traceId: `memory-bridge:${sessionKey}`,
        keyId: sessionKey,
        modelId: "memory-bridge",
        stream: false,
        agentSource: "memory-bridge",
        custom: { session: ids, userKey: ids.user_key },
      },
    };
    return await resolveFixedAssetCtxs(fakeCtx, identity, metadataClient);
  } catch (err) {
    console.warn(`${TAG} fixed asset ctx resolve failed: ${(err as Error).message}`);
    return [selfCtx(ids)];
  }
}

function selectTargetCtx(ctxs: FixedAssetCtx[], requestedAgentId: unknown): FixedAssetCtx {
  if (typeof requestedAgentId === "string" && requestedAgentId.trim()) {
    const found = ctxs.find((ctx) => ctx.agentId === requestedAgentId.trim());
    if (found) return found;
  }
  return ctxs.find((ctx) => ctx.isSelf) ?? ctxs[0];
}

const MULTI_SEARCH_SUBPATHS = new Set(["atomic/search", "conversation/search"]);

function limitFromBody(body: Record<string, unknown>, fallback = 5): number {
  const n = typeof body.limit === "number" ? body.limit : fallback;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : fallback;
}

export interface MemoryBridgeDeps {
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createMemoryBridgeHandler(
  config: ProxyConfig,
  deps: MemoryBridgeDeps = {},
): (c: Context) => Promise<Response> {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);

  return async (c: Context): Promise<Response> => {
    const t0 = (deps.now ?? Date.now)();

    const path = new URL(c.req.url).pathname;
    const sub = extractSubpath(path);
    // Early-exit telemetry for pre-validation: before every return, record a bridge_call with a non-empty reject_reason, symmetric with skill-bridge.
    if (!sub) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "memory-bridge",
        rejectReason: "unknown_path", httpStatus: 404,
      });
      return envelope(40401, `${TAG} unknown path ${path}`, 404);
    }
    if (!ALLOWED_SUBPATHS.has(sub)) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "memory-bridge",
        rejectReason: "subpath_forbidden", httpStatus: 403,
        executedEndpoint: sub,
      });
      return envelope(40301, `${TAG} subpath '${sub}' not allowed via bridge`, 403);
    }
    if (c.req.method !== "POST") {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "memory-bridge",
        rejectReason: "method_not_allowed", httpStatus: 405,
        executedEndpoint: sub,
      });
      return envelope(40501, `${TAG} method ${c.req.method} not allowed`, 405);
    }

    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("application/json")) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "memory-bridge",
        rejectReason: "content_type_invalid", httpStatus: 415,
        executedEndpoint: sub,
      });
      return envelope(41501, `${TAG} content-type must be application/json`, 415);
    }

    const sessionKey = deriveSessionId(c);
    if (!sessionKey) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "memory-bridge",
        rejectReason: "missing_conversation_id", httpStatus: 401,
        executedEndpoint: sub,
      });
      return envelope(40101, `${TAG} missing x-conversation-id (or x-session-id / x-chat-id / x-thread-id) header`, 401);
    }
    const spaceId = c.req.header("x-tdai-service-id")
      ?? config.tdai?.serviceId
      ?? config.coreSkill?.serviceId
      ?? "";
    const bindingRepo = getSessionStore().getBindingRepo() ?? null;

    let ids = loadSessionIdsL1(sessionKey);
    if (!ids && bindingRepo && spaceId) {
      console.log(`${TAG} session=${sessionKey} L1 miss → L2 binding lookup (space=${spaceId})`);
      ids = await loadSessionIdsL2(bindingRepo, spaceId, sessionKey);
    }
    if (!ids) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "memory-bridge",
        rejectReason: "session_not_initialized", httpStatus: 401,
        executedEndpoint: sub, spaceId,
      });
      return envelope(40101, `${TAG} session not initialized; cannot derive identity`, 401);
    }

    let inboundBody: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          inboundBody = parsed as Record<string, unknown>;
        } else {
          emitBridgeRejectTelemetry({
            sessionKey, bridgeSource: "memory-bridge",
            rejectReason: "body_not_object", httpStatus: 400,
            executedEndpoint: sub, requestBody: raw.slice(0, 512),
            spaceId: ids.space_id, userId: ids.user_id, teamId: ids.team_id,
            agentId: ids.agent_id, agentSource: ids.agent_source,
          });
          return envelope(40001, `${TAG} body must be a JSON object`, 400);
        }
      }
    } catch (err) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "memory-bridge",
        rejectReason: "invalid_json_body", httpStatus: 400,
        executedEndpoint: sub,
        spaceId: ids.space_id, userId: ids.user_id, teamId: ids.team_id,
        agentId: ids.agent_id, agentSource: ids.agent_source,
      });
      return envelope(40001, `${TAG} invalid JSON body: ${(err as Error).message}`, 400);
    }

    // Forcibly inject session IdFields — the LLM cannot forge identity.
    // search types by default query both self + borrowed chat_memory; non-search types default to self, and body.agent_id can
    // choose the imported agent_id exposed in <tdai_profile_memory>.
    const modelSessionId =
      typeof inboundBody.session_id === "string" && inboundBody.session_id.trim()
        ? inboundBody.session_id.trim()
        : undefined;
    const modelTaskId =
      typeof inboundBody.task_id === "string" && inboundBody.task_id.trim()
        ? inboundBody.task_id.trim()
        : undefined;

    const upstreamUrl = `${config.coreSkill.endpoint.replace(/\/$/, "")}/v3/${sub}`;
    const upstreamToken =
      config.tdai?.apiKey || config.coreSkill.serviceToken || "local-proxy";
    const upstreamServiceId =
      ids.space_id || config.tdai?.serviceId || config.coreSkill.serviceId;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${upstreamToken}`,
      "x-tdai-service-id": upstreamServiceId,
      "Content-Type": "application/json",
    };

    const ctxs = await resolveMemoryCtxs(config, ids, sessionKey);
    // task_id priority: caller explicit > session injection. session_id stays "caller explicit only",
    // because search types want to span sessions by default (agent dimension); task_id is an identity dimension and should still be enforced.
    const effectiveTaskId = modelTaskId ?? ids.task_id;
    const makeOutbound = (target: FixedAssetCtx): Record<string, unknown> => ({
      ...inboundBody,
      user_id: target.userId,
      team_id: target.teamId,
      agent_id: target.agentId,
      ...(modelSessionId ? { session_id: modelSessionId } : {}),
      ...(effectiveTaskId ? { task_id: effectiveTaskId } : {}),
    });

    const callUpstream = async (target: FixedAssetCtx): Promise<{ status: number; text: string; contentType: string }> => {
      const outboundBody = JSON.stringify(makeOutbound(target));
      const callStart = (deps.now ?? Date.now)();
      let status = 0;
      let text = "";
      let contentType = "application/json";
      try {
        const resp = await fetcher(upstreamUrl, {
          method: "POST",
          headers,
          body: outboundBody,
          signal: AbortSignal.timeout(Math.max(5000, config.coreSkill.timeoutMs * 4)),
        });
        status = resp.status;
        text = await resp.text().catch(() => "");
        contentType = resp.headers.get("content-type") ?? "application/json";
        return { status, text, contentType };
      } finally {
        // Telemetry: record one for every actual upstream call (success/failure both count, plan section 5.1)
        // Prefer the compositeKey actually hit in loadSessionIdsL1, aligning with session_init_logs;
        // only fall back to the raw sessionKey if unavailable (L1/L2 miss paths should not get here, but as a safeguard).
        const emitKey = ids.composite_key ?? sessionKey;
        emitBridgeToolCallTelemetry({
          sessionKey: emitKey,
          spaceId: ids.space_id,
          userId: target.userId,
          teamId: target.teamId,
          agentId: target.agentId,
          agentSource: agentSourceFromSessionKey(emitKey),
          bridgeSource: "memory-bridge",
          executedEndpoint: sub,
          requestBody: outboundBody.slice(0, 512),
          upstreamStatus: status,
          elapsedMs: (deps.now ?? Date.now)() - callStart,
        });
      }
    };

    if (MULTI_SEARCH_SUBPATHS.has(sub) && typeof inboundBody.agent_id !== "string") {
      const limit = limitFromBody(inboundBody);
      // The response shapes of the two kinds of search differ:
      //   - /v3/atomic/search       → data.items[]（L1 hit）
      //   - /v3/conversation/search → data.messages[]（L0 hit）
      // Early code always read data.items, causing conversation/search in the multi branch
      // to always return empty (a historical bug). Here fields are read/written dispatched by sub, keeping pass-through semantics.
      const isConversationSearch = sub === "conversation/search";
      const resultKey: "items" | "messages" = isConversationSearch ? "messages" : "items";
      const settled = await Promise.allSettled(ctxs.map(async (target) => ({ target, ...(await callUpstream(target)) })));
      const collected: Record<string, unknown>[] = [];
      let okCount = 0;
      for (const r of settled) {
        if (r.status !== "fulfilled" || r.value.status < 200 || r.value.status >= 300) continue;
        okCount++;
        try {
          const env = JSON.parse(r.value.text) as {
            data?: { items?: unknown[]; messages?: unknown[] };
          };
          const rows = (isConversationSearch ? env.data?.messages : env.data?.items) ?? [];
          for (const item of rows) {
            if (!item || typeof item !== "object") continue;
            collected.push({
              ...(item as Record<string, unknown>),
              source_agent_id: r.value.target.agentId,
              source_agent_name: r.value.target.agentName,
              source_agent_role: r.value.target.isSelf ? "self" : "imported_from",
            });
          }
        } catch {
          // ignore malformed upstream response from this target
        }
      }
      collected.sort((a, b) => (typeof b.score === "number" ? b.score : 0) - (typeof a.score === "number" ? a.score : 0));
      const elapsed = (deps.now ?? Date.now)() - t0;
      console.log(`${TAG} sub=${sub} multi targets=${ctxs.length} ok=${okCount} ${resultKey}=${collected.length} elapsed=${elapsed}ms`);
      const truncated = collected.slice(0, limit);
      const searchedAgents = ctxs.map((x) => ({
        agent_id: x.agentId,
        name: x.agentName,
        role: x.isSelf ? "self" : "imported_from",
      }));
      // Keep pass-through semantics: return field names consistent with upstream (items vs messages).
      const responseData: Record<string, unknown> = isConversationSearch
        ? { messages: truncated, searched_agents: searchedAgents }
        : { items: truncated, searched_agents: searchedAgents };
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        request_id: `mem-bridge-${Date.now()}`,
        data: responseData,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    let upstream;
    try {
      upstream = await callUpstream(selectTargetCtx(ctxs, inboundBody.agent_id));
    } catch (err) {
      console.warn(
        `${TAG} upstream fetch failed sub=${sub} err=${(err as Error).message}`,
      );
      return envelope(50301, `${TAG} upstream unavailable: ${(err as Error).message}`, 502);
    }

    const respText = upstream.text;
    const elapsed = (deps.now ?? Date.now)() - t0;
    console.log(`${TAG} sub=${sub} status=${upstream.status} elapsed=${elapsed}ms`);

    return new Response(respText, {
      status: upstream.status,
      headers: {
        "content-type": upstream.contentType,
      },
    });
  };
}
