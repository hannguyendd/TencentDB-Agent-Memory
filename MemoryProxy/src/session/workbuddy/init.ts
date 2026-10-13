/**
 * WorkBuddy session-init -- **header-preselect-only** standalone implementation.
 *
 * ⚠️ Independence rule: this file does not import any sibling handler / sibling session module
 * (session/codebuddy/*, session/codex/*, session/claude-code/*). It depends only on
 * **generic infrastructure shared by multiple clients**:
 *   - session/store.ts        (generic KV store)
 *   - session/preset.ts       (header parsing + validation, client-agnostic)
 *   - session/registrar.ts    (SessionInfo construction)
 *   - session/context-injector.ts (session_context XML generation)
 *   - session/types.ts (generic types)
 *   - meta/client.ts          (TDAI kernel API client)
 *
 * ============================================================================
 * WorkBuddy client semantics
 * ============================================================================
 * Packet-capture conclusions (see docs/workbuddy-recon/ for details):
 *   - Wire protocol: OpenAI Responses API (same underlying protocol as codex)
 *   - **The system prompt contains no request_user_input-style form tool** (confirmed by real packet capture)
 *   - The client cannot show an interactive selection form for the user to pick team/agent/task
 *
 * So this session-init degrades to a pure **entry gatekeeper**:
 *   - Request headers contain complete team+agent+task IDs → validate, register directly → continue to inject
 *   - Any one missing → **silent bypass** (pass through upstream, no assets injected)
 *   - Existing session state (same sessionKey reused) → take the recovered fast path
 *
 * **Key differences** from the CB/codex/CC session-init state machines:
 *   1. Does not return `intercepted=true` (this client cannot receive a form response)
 *   2. No Default gate detection (the client itself sends no gate signal)
 *   3. No MORE pagination (no interaction needed)
 *   4. No form interception (the client has no form tool)
 * ============================================================================
 */

import type { SessionInitConfig } from "../../types.js";
import type { MetadataClient } from "../../meta/client.js";
import type { SessionStore, SessionIdentity } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import type {
  AgentDetail,
  SessionInfo,
  SessionInitState,
  TaskDetail,
} from "../types.js";
import { buildSessionContextBlockWithToggles } from "../context-injector.js";
import {
  parsePresetIdentity,
  resolvePresetIdentity,
  type PresetIdentity,
} from "../preset.js";

// ── Result type ──────────────────────────────────────────────────────────────

/**
 * WorkBuddy session-init result. Semantics aligned with the SessionInitResult of CB/CC/codex
 * (sessionInfo/agentDetail/taskDetail/systemAppend/bypassed field names are identical),
 * but a **separate type** to avoid sharing types across handlers.
 */
export interface WorkbuddySessionInitResult {
  /**
   * Whether the session was registered successfully. When false, the caller should skip injection and pass through upstream directly.
   */
  bypassed: boolean;
  /** SessionInfo on successful registration; null on the bypass branch. */
  sessionInfo: SessionInfo | null;
  /** Agent details (including prompt / persona); null on the bypass branch. */
  agentDetail: AgentDetail | null;
  /** Task details (including description / goal); null on the bypass branch. */
  taskDetail: TaskDetail | null;
  /**
   * Pre-built `<session_context>` block; used to pre-fill the system message when the injection stage composes the body.
   * null on the bypass branch.
   */
  systemAppend: string | null;
  /**
   * Whether this turn is a **new registration** (recovered fast-path reuse = false, first registration = true).
   * Used to decide whether to trigger injection prewarm.
   */
  justRegistered: boolean;
  /**
   * Reason for taking bypass, for log/telemetry analysis:
   *   - "no-header": the request has no x-tdai-team-id header (the client has no form fallback → bypass directly)
   *   - "incomplete-header": the header has team but lacks agent or task
   *   - "mismatch": the header values are inconsistent with the team/agent lists returned by the kernel
   *   - "kernel-error": the kernel API call failed
   *   - "config-disabled": sessionInit.enabled=false or headerAutoSelect.enabled=false
   */
  bypassReason?:
    | "no-header"
    | "incomplete-header"
    | "mismatch"
    | "kernel-error"
    | "config-disabled";
}

// ── Request context ──────────────────────────────────────────────────────────

/**
 * Runtime context passed through when calling handleWorkbuddySessionInit (parameters unrelated to the request
 * go through separate arguments).
 */
export interface WorkbuddyRequestContext {
  /** SSE stream flag -- for future form scenarios; this handler currently builds no form response. */
  stream: boolean;
  /** Model ID requested by the client; passed through to logs/telemetry. */
  modelId: string;
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * WorkBuddy session-init entry point.
 *
 * Flow (see the module doc at the top for details):
 *   1. sessionInit.enabled=false → bypass(config-disabled)
 *   2. Reuse existing state from the store → go straight to the recovered fast path
 *   2.5 **DEBUG**: when `sessionInit.debugForceIdentity` is complete (team+agent+task) →
 *      skip header and kernel listTeams validation, register directly with the fixed triple (local/e2e only)
 *   3. Parse the preset identity (three headers):
 *      - no team header → bypass(no-header)
 *      - team header present but agent or task missing → bypass(incomplete-header)
 *      - team+agent+task complete → fetch the kernel team list to validate
 *        - resolvePresetIdentity.canRegister=true → complete registration
 *        - validation fails → bypass(mismatch)
 *   4. After successful registration, persist to the store (the next turn takes the recovered branch)
 *
 * @param sessionKey     dedup key (usually the client session_id or fallback keyId:traceId)
 * @param userId         user ID resolved from the apiKey (may be null)
 * @param config         SessionInitConfig (including headerAutoSelect config)
 * @param store          generic SessionStore (shared by multiple clients, isolated by the `workbuddy:` prefix)
 * @param reqCtx         request runtime context
 * @param headers        lower-cased request header map
 * @param agentSource    fixed as "workbuddy" (compositeKey prefix)
 * @param metadataClient TDAI kernel client; may be undefined on the bypass branch
 * @param userKey        raw apiKey, stored into SessionInfo.user_key
 * @param spaceId        spaceId from the URL path
 */
export async function handleWorkbuddySessionInit(
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: WorkbuddyRequestContext,
  headers: Record<string, string>,
  agentSource: string,
  metadataClient: MetadataClient | undefined,
  userKey: string | undefined,
  spaceId: string | undefined,
): Promise<WorkbuddySessionInitResult> {
  void reqCtx; // reserved for future extension (stream/modelId will be used for form / MORE pagination)

  // ── 1. Config gating ──────────────────────────────────────────────────────
  if (!config.enabled) {
    return bypassResult("config-disabled");
  }

  const compositeKey = `${agentSource}:${sessionKey}`;
  const identity: SessionIdentity = {
    userId: userId || "anonymous",
    agentSource,
    sessionId: sessionKey,
    spaceId: spaceId || "",
  };

  // ── 2. Reuse existing state (recovered fast path) ─────────────────────────
  // getOrRecover automatically binds the identity internally; no separate store.bind call needed
  const recovered = await store.getOrRecover(compositeKey, identity, {
    metadataClient,
    messages: [], // WorkBuddy has no form → no history scan recovery needed
  });

  if (recovered && recovered.status === "initialized") {
    const sessionInfo = recovered.sessionInfo ?? null;
    const agentDetail = recovered.agentDetail ?? null;
    const taskDetail = recovered.taskDetail ?? null;
    const bypassed = Boolean(recovered.bypassed);

    const systemAppend = bypassed
      ? null
      : buildSessionContextBlockWithToggles(
          agentDetail,
          taskDetail,
          config,
          sessionKey,
        );

    return {
      bypassed,
      sessionInfo: bypassed ? null : sessionInfo,
      agentDetail: bypassed ? null : agentDetail,
      taskDetail: bypassed ? null : taskDetail,
      systemAppend,
      justRegistered: false,
    };
  }

  // ── 2.5 DEBUG BYPASS: debugForceIdentity forced injection (local dev / e2e) ─────
  // Purpose: bypass header parsing + kernel listTeams validation, and complete registration directly with the fixed triple
  //       (team_id, agent_id, task_id) specified in config. For local bring-up / integration testing only.
  // Semantics aligned with the CC version: team+agent+task must all be present to take this path (if any is missing, the
  // debug config is ignored and the normal preset flow resumes), ensuring the task needed by injection always exists.
  if (
    config.debugForceIdentity &&
    config.debugForceIdentity.team_id &&
    config.debugForceIdentity.agent_id &&
    config.debugForceIdentity.task_id
  ) {
    // Hoisted into a local constant so TS narrows task_id to string (the original type is string | undefined)
    const forcedTeamId: string = config.debugForceIdentity.team_id;
    const forcedAgentId: string = config.debugForceIdentity.agent_id;
    const forcedTaskId: string = config.debugForceIdentity.task_id;
    const forcedUserId = identity.userId;
    console.log(
      `[workbuddy-init] session=${compositeKey} DEBUG bypass — force identity ` +
        `team=${forcedTeamId} agent=${forcedAgentId} task=${forcedTaskId} user=${forcedUserId}`,
    );

    // Try to fill in agent/task detail (degrade to empty on failure) -- consistent with section 5 of the main path
    let agentDetail: AgentDetail | null = null;
    let taskDetail: TaskDetail | null = null;
    if (metadataClient) {
      try {
        const agent = await metadataClient.getAgent(forcedAgentId);
        agentDetail = {
          id: agent.agent_id,
          name: agent.name,
          description: agent.description ?? undefined,
          prompt: agent.prompt ?? undefined,
        };
      } catch (err) {
        console.warn(
          `[workbuddy-init] DEBUG getAgent(${forcedAgentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const task = await metadataClient.getTask(forcedTaskId);
        taskDetail = {
          id: task.task_id,
          name: task.title,
          description: task.description ?? undefined,
        };
      } catch (err) {
        console.warn(
          `[workbuddy-init] DEBUG getTask(${forcedTaskId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const sessionInfo = buildSessionInfo(
      {
        session_id: sessionKey,
        team_id: forcedTeamId,
        agent_id: forcedAgentId,
        task_id: forcedTaskId,
        user_id: forcedUserId,
      },
      userKey,
      spaceId,
    );

    await store.set(compositeKey, {
      status: "initialized",
      keyId: compositeKey,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: false,
      sessionInfo,
      userId: identity.userId,
      agentDetail,
      taskDetail,
    } as SessionInitState);

    const systemAppend = buildSessionContextBlockWithToggles(
      agentDetail,
      taskDetail,
      config,
      sessionKey,
    );

    return {
      bypassed: false,
      sessionInfo,
      agentDetail,
      taskDetail,
      systemAppend,
      justRegistered: true,
    };
  }

  // ── 3. Parse preset identity ───────────────────────────────────────────────
  const preset: PresetIdentity | undefined = parsePresetIdentity(config, headers);
  if (!preset || !preset.teamId) {
    // No team header → the WorkBuddy client has no form fallback → bypass directly
    await persistBypass(store, compositeKey, identity);
    return bypassResult("no-header");
  }
  if (!preset.agentId || !preset.taskId) {
    // Team present but agent or task missing → cannot register fully, bypass directly
    // (resolvePresetIdentity would also return canRegister=false; returning early here reduces kernel calls)
    await persistBypass(store, compositeKey, identity);
    return bypassResult("incomplete-header");
  }

  // ── 4. Fetch kernel team list to validate preset ──────────────────────────
  if (!metadataClient) {
    // No kernel client (config lacks tdai.endpoint / apiKey incomplete) → bypass
    // without persisting the bypass to the store -- it can recover automatically once the config is fixed
    return bypassResult("kernel-error");
  }

  // Fetch the team list visible to the current user via the kernel, and fan out to fill in agents / tasks
  // (resolvePresetIdentity needs the TeamOption[] structure)
  let teams: import("../types.js").TeamOption[];
  try {
    const teamsRaw = await metadataClient.listTeams(identity.userId);
    teams = await Promise.all(
      teamsRaw.map(async (t) => {
        const [agentsRaw, tasksRaw] = await Promise.all([
          metadataClient.listAgents(t.team_id).catch(() => []),
          metadataClient.listTasks(t.team_id).catch(() => []),
        ]);
        return {
          team_id: t.team_id,
          team_name: t.name ?? t.team_id,
          agents: agentsRaw.map((a) => ({
            agent_id: a.agent_id,
            agent_name: a.name ?? a.agent_id,
          })),
          tasks: tasksRaw.map((tk) => ({
            task_id: tk.task_id,
            task_name: tk.title ?? tk.task_id,
          })),
        };
      }),
    );
  } catch (err) {
    console.warn(
      `[workbuddy-init] session=${sessionKey} listTeams failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Do not persist the bypass to the store -- the kernel error may be transient; the next request can retry
    return bypassResult("kernel-error");
  }

  const resolution = resolvePresetIdentity(teams, preset);
  if (!resolution.canRegister) {
    // Validation failed: header values are inconsistent with the user-visible team/agent/task → long-term bypass
    // (the client will send the same header on the next request, so retrying is pointless)
    await persistBypass(store, compositeKey, identity);
    return bypassResult("mismatch");
  }

  // ── 5. Fetch agent / task detail ──────────────────────────────────────────
  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;
  try {
    if (resolution.agentId) {
      const agent = await metadataClient.getAgent(resolution.agentId);
      agentDetail = {
        id: agent.agent_id,
        name: agent.name,
        description: agent.description ?? undefined,
        prompt: agent.prompt ?? undefined,
      };
    }
  } catch (err) {
    console.warn(
      `[workbuddy-init] getAgent(${resolution.agentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    if (resolution.taskId) {
      const task = await metadataClient.getTask(resolution.taskId);
      taskDetail = {
        id: task.task_id,
        name: task.title,
        description: task.description ?? undefined,
      };
    }
  } catch (err) {
    console.warn(
      `[workbuddy-init] getTask(${resolution.taskId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 6. Build SessionInfo & persist to store ───────────────────────────────
  const sessionInfo = buildSessionInfo(
    {
      session_id: sessionKey,
      team_id: resolution.teamId!,
      agent_id: resolution.agentId!,
      task_id: resolution.taskId,
      user_id: userId || "anonymous",
    },
    userKey,
    spaceId,
  );

  const initState: SessionInitState = {
    status: "initialized",
    keyId: compositeKey,
    startedAt: Date.now(),
    attemptCount: 0,
    bypassed: false,
    sessionInfo,
    userId: identity.userId,
    agentDetail,
    taskDetail,
  };
  await store.set(compositeKey, initState);

  const systemAppend = buildSessionContextBlockWithToggles(
    agentDetail,
    taskDetail,
    config,
    sessionKey,
  );

  return {
    bypassed: false,
    sessionInfo,
    agentDetail,
    taskDetail,
    systemAppend,
    justRegistered: true,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function bypassResult(
  reason: WorkbuddySessionInitResult["bypassReason"],
): WorkbuddySessionInitResult {
  return {
    bypassed: true,
    sessionInfo: null,
    agentDetail: null,
    taskDetail: null,
    systemAppend: null,
    justRegistered: false,
    bypassReason: reason,
  };
}

/**
 * Persist the bypass decision into the SessionStore (terminal `initialized` + `bypassed=true`);
 * the next request takes the recovered fast path and returns the bypass directly.
 *
 * bypassReason is not persisted in the store (SessionInitState has no such field); it is carried only
 * on this handler's return value side.
 */
async function persistBypass(
  store: SessionStore,
  compositeKey: string,
  identity: SessionIdentity,
): Promise<void> {
  store.bind(compositeKey, identity);
  try {
    await store.set(compositeKey, {
      status: "initialized",
      keyId: compositeKey,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: true,
      sessionInfo: null,
      userId: identity.userId,
      agentDetail: null,
      taskDetail: null,
    });
  } catch (err) {
    console.warn(
      `[workbuddy-init] persistBypass failed for key=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
