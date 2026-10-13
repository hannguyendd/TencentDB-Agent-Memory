/**
 * POST /v3/session/refresh-cache
 *
 * Core logic: re-run prewarmFromConfig based on the session init info, refreshing the injection cache on COS.
 * Besides the hook-side cache, it also re-fetches the Agent/Task detail and overwrites it into SessionStore,
 * so that fields snapshotted at session-init time, such as "task description / Agent description", are refreshed too.
 *
 * Two ways to use it:
 *   1. Function call (used inside mem:sync) — import refreshSessionCache()
 *   2. HTTP endpoint (used by the panel frontend) — createSessionRefreshHandler() registers the route
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { getSessionStore } from "../session/store.js";
import { prewarmFromConfig } from "../injection/index.js";
import type { SessionInitState, AgentDetail, TaskDetail } from "../session/types.js";
import { getMetadataClient } from "../meta/client.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RefreshInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  callerUserKey?: string;
}

export interface RefreshResult {
  success: boolean;
  /** List of hookIds whose hook cache was refreshed (the ids of the skill/memory/knowledge/... injectors). */
  refreshed: string[];
  skipped: string[];
  /** Whether the agent detail was successfully re-fetched (overwritten into SessionStore). */
  agentRefreshed: boolean;
  /** Whether the task detail was successfully re-fetched (overwritten into SessionStore). */
  taskRefreshed: boolean;
  tookMs: number;
  error?: string;
}

// ── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Re-fetch the Agent + Task detail and overwrite it into SessionStore.
 *
 * Failures only warn and do not throw: failing to fetch the agent/task detail is a "degradation" scenario, and the hook cache refresh should
 * still continue. The return value tells the caller which items succeeded so the message text can explain it.
 */
async function refreshAgentTaskDetail(
  state: SessionInitState,
  compositeKey: string,
  config: ProxyConfig,
  spaceIdFromCaller: string,
  callerUserKey: string | undefined,
): Promise<{ agentRefreshed: boolean; taskRefreshed: boolean }> {
  const sessionInfo = state.sessionInfo;
  if (!sessionInfo) return { agentRefreshed: false, taskRefreshed: false };

  // ServiceId (space) is taken from sessionInfo; the spaceId passed by the caller serves as a fallback.
  const serviceId = sessionInfo.space_id || spaceIdFromCaller || "";
  // MetadataClient needs x-tdai-user-key; prefer sessionInfo, then fall back to the caller's.
  const userKey = sessionInfo.user_key || callerUserKey || "";

  if (!serviceId || !userKey || !config.coreSkill?.endpoint) {
    // Missing the elements needed for a kernel call → skip the detail refresh directly, not treated as an error.
    return { agentRefreshed: false, taskRefreshed: false };
  }

  const client = getMetadataClient(config.coreSkill, serviceId, userKey);

  const agentId = sessionInfo.agent_id;
  const taskId = sessionInfo.task_id;
  const shouldFetchTask = !!taskId && taskId !== (config as any).defaultTaskId;

  const [agentRes, taskRes] = await Promise.allSettled([
    agentId
      ? client.getAgent(agentId).then((a) => ({
          id: a.agent_id,
          name: a.name,
          description: a.description ?? undefined,
          prompt: a.prompt ?? undefined,
        } as AgentDetail))
      : Promise.resolve(null as AgentDetail | null),
    shouldFetchTask
      ? client.getTask(taskId!).then((t) => ({
          id: t.task_id,
          name: t.title,
          description: t.description ?? undefined,
        } as TaskDetail))
      : Promise.resolve(null as TaskDetail | null),
  ]);

  let agentRefreshed = false;
  let taskRefreshed = false;
  let nextAgent: AgentDetail | null | undefined = state.agentDetail;
  let nextTask: TaskDetail | null | undefined = state.taskDetail;

  if (agentRes.status === "fulfilled" && agentRes.value) {
    nextAgent = agentRes.value;
    agentRefreshed = true;
  } else if (agentRes.status === "rejected") {
    console.warn(
      `[session-refresh] getAgent failed for ${compositeKey}: ` +
        (agentRes.reason instanceof Error ? agentRes.reason.message : String(agentRes.reason)),
    );
  }

  if (taskRes.status === "fulfilled" && taskRes.value) {
    nextTask = taskRes.value;
    taskRefreshed = true;
  } else if (taskRes.status === "rejected") {
    console.warn(
      `[session-refresh] getTask failed for ${compositeKey}: ` +
        (taskRes.reason instanceof Error ? taskRes.reason.message : String(taskRes.reason)),
    );
  }

  if (agentRefreshed || taskRefreshed) {
    const nextState: SessionInitState = {
      ...state,
      agentDetail: nextAgent ?? null,
      taskDetail: nextTask ?? null,
    };
    try {
      await getSessionStore().set(compositeKey, nextState);
    } catch (err) {
      console.warn(
        `[session-refresh] store.set failed for ${compositeKey}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return { agentRefreshed, taskRefreshed };
}

/**
 * Refresh all injection caches of the current session.
 *
 * Get sessionInfo from SessionStore → re-fetch Agent/Task detail and overwrite the store →
 * build PrewarmInput → call prewarmFromConfig()
 */
export async function refreshSessionCache(input: RefreshInput): Promise<RefreshResult> {
  const { sessionKey, agentSource, config, spaceId, callerUserKey } = input;

  // Parameter validation
  if (!sessionKey) {
    return {
      success: false, refreshed: [], skipped: [],
      agentRefreshed: false, taskRefreshed: false,
      tookMs: 0, error: "session_key is required",
    };
  }

  // Get the session state from SessionStore
  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state: SessionInitState | undefined = store.get(compositeKey);

  if (!state) {
    return {
      success: false, refreshed: [], skipped: [],
      agentRefreshed: false, taskRefreshed: false,
      tookMs: 0, error: `Session not found: ${sessionKey}`,
    };
  }

  if (!state.sessionInfo) {
    return {
      success: false, refreshed: [], skipped: [],
      agentRefreshed: false, taskRefreshed: false,
      tookMs: 0, error: `Session not initialized: ${sessionKey}`,
    };
  }

  const t0 = Date.now();

  // Step 1: try to re-fetch the agent/task detail and overwrite SessionStore.
  //         A failure does not block the hook cache refresh; only agentRefreshed/taskRefreshed in the final return value are false.
  const { agentRefreshed, taskRefreshed } = await refreshAgentTaskDetail(
    state, compositeKey, config, spaceId, callerUserKey,
  );

  // Step 2: build PrewarmInput from the agent/task detail in the latest state.
  const latestState = store.get(compositeKey) ?? state;
  const sessionInfo = latestState.sessionInfo!;
  const agentDetail = latestState.agentDetail ?? null;
  const taskDetail = latestState.taskDetail ?? null;

  try {
    const result = await prewarmFromConfig(
      config,
      {
        keyId: compositeKey,
        userId: sessionInfo.user_id || "anonymous",
        agentSource,
        spaceId,
        sessionInfo,
        agentDetail,
        taskDetail,
        callerUserKey,
      },
      // The refresh scenario must use clearBefore=true -- the first session_init reuses the same entry point without
      // this option, preserving the semantics of "cache miss is handled by the pipeline's execute() self-heal";
      // when enabled during a refresh, any hook that gets []/timeout/exception also clears the old cache along with it, preventing
      // the scenario of "the asset has been unbound but the injection still carries the old snapshot" (especially when all of knowledge's wiki/code-graph
      // are unbound → prewarm returns empty → the default logic does not write → the old <knowledge_tools> on COS
      // lives on forever). See the PrewarmOptions.clearBefore comment in `injection/prewarm.ts`.
      { clearBefore: true },
    );
    const tookMs = Date.now() - t0;
    return {
      success: true,
      refreshed: result.cachedHookIds,
      skipped: result.skipped.map((s) => (typeof s === "string" ? s : s.hookId)),
      agentRefreshed,
      taskRefreshed,
      tookMs,
    };
  } catch (err) {
    const tookMs = Date.now() - t0;
    return {
      success: false, refreshed: [], skipped: [],
      agentRefreshed, taskRefreshed,
      tookMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── HTTP Handler ───────────────────────────────────────────────────────────

/**
 * Create the HTTP handler, registered into server.ts.
 * Uses admin auth (reusing the pattern of admin-auth.ts).
 */
export function createSessionRefreshHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `refresh-${Date.now()}` }, 400);
    }

    const sessionKey = typeof body.session_key === "string" ? body.session_key : "";
    const agentSource = typeof body.agent_source === "string" ? body.agent_source : "claude-code";
    const callerUserKey = typeof body.user_key === "string" ? body.user_key : undefined;
    const spaceId = typeof body.space_id === "string" ? body.space_id : "";

    const result = await refreshSessionCache({
      sessionKey,
      agentSource,
      config,
      spaceId,
      callerUserKey,
    });

    const requestId = `refresh-${Date.now()}`;

    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ code: status === 404 ? 40401 : 40001, message: result.error, request_id: requestId }, status);
    }

    return c.json({
      code: 0,
      message: "ok",
      request_id: requestId,
      data: {
        refreshed: result.refreshed,
        skipped: result.skipped,
        agent_refreshed: result.agentRefreshed,
        task_refreshed: result.taskRefreshed,
        took_ms: result.tookMs,
      },
    });
  };
}
