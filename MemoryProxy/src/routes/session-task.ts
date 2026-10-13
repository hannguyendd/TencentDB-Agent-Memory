/**
 * Core business of mem:create-task / mem:update-task:
 * starting from the current session context, generate a Task, write it into metadata, and bind it to the session.
 *
 * Interaction model (the "user confirmation" gate -- destructive operations must draft first, then confirm):
 *   - createTaskFromSession
 *       no real task bound → LLM generates title+description → persist and bind directly (one step)
 *       real task already bound → generate a new draft → write pending → return pending, wait for the user's confirm/cancel
 *   - updateTaskFromSession
 *       no task_id bound → intercept and return an error, guiding the user to run mem:create-task first
 *       bound: fetch the current task → generate a draft (including a status suggestion) → write pending → return pending
 *              a non-creator is no longer rejected; instead a warning is attached to pending and the user is told at confirm time
 *   - confirmPendingTaskAction / cancelPendingTaskAction
 *       take the payload out of pending-store and perform the real create / update / overwrite-binding / clear pending
 *
 * Key constraints (aligned with kernel):
 *   - pass agent_id on create, so the kernel associates the current Agent (original TAPD requirement text)
 *   - **do not change the title** when persisting (aligned with the existing product convention; the kernel allows it but the product does not)
 *   - on update, status is proposed by the LLM and passed through by the proxy directly to the kernel, with no enum validation
 *   - creator_user_id / team_id are taken strictly from sessionInfo, to prevent privilege escalation
 *   - taskDraft not configured = directly return "config missing" (no local fallback)
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import type { MemCommandMessage } from "../mem-command/types.js";
import { getSessionStore } from "../session/store.js";
import type { SessionInitState, SessionInfo } from "../session/types.js";
import { getMetadataClient } from "../meta/client.js";
import type { TaskEntity } from "../meta/client.js";
import { generateTaskDraft, type TaskDraftConfig } from "../mem-command/task-draft-generator.js";
import {
  clearPending,
  getPending,
  makePendingKey,
  setPending,
  type PendingCreatePayload,
  type PendingUpdatePayload,
} from "../mem-command/pending-store.js";

// -- Input / output types ---------------------------------------------------------

/**
 * taskDraft LLM main-model following (plan D): the model / upstream / key actually used by the client's current request.
 * The handler has already resolved them by per-agent rules; session-task only passes them through to task-draft-generator.
 *
 * If any one of the three fields is missing → resolveTaskDraftConfig returns "not configured",
 * and the command layer assembles the error text for the user (no fallback, and no longer depends on config.memCommand.taskDraft).
 */
export interface TaskDraftUpstream {
  /** The model of the client's current request (the real model_id after body.model normalization). */
  model?: string;
  /** The per-agent resolved upstream base url (without the concrete endpoint). */
  upstreamUrl?: string;
  /** The upstream API family, determines the generator request shape. */
  protocol?: "openai" | "anthropic" | "responses";
  /** The apiKey used when forwarding (the user key passed through by the client). */
  apiKey?: string;
}

export interface CreateTaskFromSessionInput extends TaskDraftUpstream {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  /** User hint (free text after mem:create-task), may be empty */
  hint?: string;
  /** Recent conversation (used to generate the draft) */
  recentMessages: MemCommandMessage[];
  /**
   * The title the user wrote after mem:create-task (original text; truncation to 40 characters is the caller's responsibility).
   *   - Has a value: the title is locked and the LLM only generates the description; if the LLM fails, it degrades to an empty desc and the task is still persisted.
   *   - No value: both title + description are inferred by the LLM from the conversation; if the LLM fails, an error is returned directly.
   */
  lockedTitle?: string;
}

export interface UpdateTaskFromSessionInput extends TaskDraftUpstream {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  hint?: string;
  recentMessages: MemCommandMessage[];
  /**
   * The description the user wrote after mem:update-task (original text).
   *   - Has a value: description is replaced with that text directly, without calling the LLM.
   *   - No value: call the LLM to diff out the new description (not persisted when changed=false).
   */
  directDescription?: string;
}

/** confirm/cancel input (without recentMessages, since the draft is already in pending) */
export interface PendingActionInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
}

/** Pending summary on the first call of the create command (for the command layer to assemble preview text) */
export interface PendingCreateInfo {
  kind: "create";
  draftTitle: string;
  draftDescription: string;
  currentTaskId: string;
  currentTaskTitle?: string;
}

/** Pending summary on the first call of the update command */
export interface PendingUpdateInfo {
  kind: "update";
  taskId: string;
  currentTitle?: string;
  currentDescription?: string;
  currentStatus?: string;
  draftDescription: string;
  statusSuggestion?: string;
}

export type PendingInfo = PendingCreateInfo | PendingUpdateInfo;

export interface TaskFromSessionResult {
  success: boolean;
  /** taskId on success */
  taskId?: string;
  /** Final title on success */
  title?: string;
  /** Final description on success */
  description?: string;
  /** Final status on success */
  status?: string;
  /** update mode: true when the LLM judged "no update needed" -- not persisted */
  noUpdateNeeded?: boolean;
  /**
   * create mode: the session already has a task_id bound; a legacy compat slot, and under the new interaction pending is given at the same time.
   * The field name is kept for compatibility with the HTTP handler's response shell (respond() reads it to decide 409).
   */
  alreadyBound?: boolean;
  /**
   * The first call generated a pending draft awaiting user confirmation. Not persisted; the command layer must assemble preview text,
   * guiding the next reply to `mem:create-task confirm` / `mem:update-task confirm` or `... cancel`.
   */
  pending?: PendingInfo;
  /** confirm branch: there is no corresponding pending on the session (may have timed out / been cancelled / never generated) */
  noPending?: boolean;
  /** cancel branch: whether pending was hit and cleaned up */
  cancelled?: boolean;
  /** create overwrite branch: the previously bound old task_id (used in the returned text) */
  previousTaskId?: string;
  /** Failure reason, for the caller to assemble user-visible text */
  error?: string;
}

// -- Internal: common checks for fetching session state ----------------------------

interface ResolvedSession {
  state: SessionInitState;
  sessionInfo: SessionInfo;
  teamId: string;
  userId: string;
  currentTaskId?: string;
}

function resolveSession(
  sessionKey: string,
  agentSource: string,
  config: ProxyConfig,
): ResolvedSession | { error: string } {
  if (!sessionKey) return { error: "session_key is required" };

  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state = store.get(compositeKey);

  if (!state || !state.sessionInfo) {
    return { error: `Session not found: ${sessionKey}` };
  }

  const sessionInfo = state.sessionInfo;
  const teamId = sessionInfo.team_id ?? "";
  const userId = sessionInfo.user_id ?? "";
  if (!teamId || !userId) {
    return { error: "session missing team_id/user_id (initialization incomplete)" };
  }

  // "暂时跳过" (skip for now) goes through config.sessionInit.defaultTaskId (a virtual value that does not exist in the kernel),
  // treated as **no real task bound** -- create-task is allowed, update-task is forbidden (the latter returns an error via the no-task branch).
  const rawTaskId = sessionInfo.task_id;
  const defaultTaskId = config.sessionInit?.defaultTaskId;
  const isVirtualDefault = !!rawTaskId && !!defaultTaskId && rawTaskId === defaultTaskId;
  const currentTaskId = isVirtualDefault ? undefined : rawTaskId;

  return { state, sessionInfo, teamId, userId, ...(currentTaskId ? { currentTaskId } : {}) };
}

// -- Internal: check and fetch the taskDraft config ---------------------------------

const DEFAULT_TASK_DRAFT_TIMEOUT_MS = 20000;

/**
 * Resolve the upstream apiKey used by the taskDraft LLM. **Strictly replicates the main path's per-agent three-tier semantics**
 * (authoritative definition in the upstream.agents table of config.example.yaml / anthropicHandler.ts:1293),
 * avoiding inconsistent auth behavior caused by taskDraft using a different key from the main path:
 *
 *   ┌──────────────────────────────┬────────────────────────────────────┐
 *   │ agent config                 │ apiKey used                        │
 *   ├──────────────────────────────┼────────────────────────────────────┤
 *   │ not in the agents table      │ upstream.apiKey (outer fallback)   │
 *   │ in the table, apiKey set     │ agent.apiKey                       │
 *   │ in the table, url only (no apiKey) │ pass through client key (outer fallback is cut off!) │
 *   └──────────────────────────────┴────────────────────────────────────┘
 *
 * WARNING: key point: use the ternary judgment "is the agent in the table", **do not use `||` as a fallback** -- otherwise
 * "in the table but no key configured" (which should pass through the client key) would wrongly fall back to the outer upstream.apiKey,
 * inconsistent with the main path (exactly the bug exposed in the test environment on 2026-09-21).
 *
 * @param clientKey the raw key passed through by the client (input.apiKey in the handler)
 */
function resolveUpstreamApiKeyForAgent(
  config: ProxyConfig,
  agentSource: string,
  clientKey: string,
): string {
  // value may not declare apiKey in the type; a narrowing assertion safely takes the value; upstream uses optional chaining to guard against an empty-shell config.
  const agents = config.upstream?.agents as
    | Record<string, { url?: string; apiKey?: string }>
    | undefined;
  const entry = agents?.[agentSource];
  if (entry) {
    // In the table: use apiKey if present; if no apiKey is configured → pass through the client key (no fallback to the outer one)
    const agentKey = entry.apiKey ?? "";
    return agentKey || clientKey;
  }
  // Not in the table: use the outer upstream.apiKey; if the outer one is empty, likewise pass through the client key
  // (aligned with the main path's buildUpstreamHeaders: when `if (config.upstream.apiKey)` is empty it does not override,
  //  and the client's original Authorization is passed through as-is -- see config.example.yaml:35-36).
  return (config.upstream?.apiKey ?? "") || clientKey;
}

/**
 * Resolve the taskDraft LLM config. Value priority (high to low):
 *
 *   1) Environment variable override (ops escape hatch, fully taking over in ops deployments):
 *        MEMORY_LLM_PROTOCOL / MEMORY_LLM_API_KEY / MEMORY_LLM_BASE_URL / MEMORY_LLM_MODEL
 *   2) Main path upstream (truly following the main model, plan D):
 *        key   = resolveUpstreamApiKeyForAgent (strictly replicates the main path's per-agent three-tier semantics)
 *        url   = the upstreamUrl passed through by the handler (already resolved per-agent)
 *        model = the client's current model passed through by the handler
 *   3) taskDraft dedicated config (credentials ops configured separately for draft generation): config.memCommand.taskDraft.*
 *
 * If the required fields cannot be obtained → return "not configured".
 *
 * WARNING: why the key follows the main path rather than the client entry key:
 *   The key in the client request header is the "entry auth key" (used by verifyUserKey). The main path forward
 *   decides by the three-tier semantics whether to use upstream.apiKey / agent.apiKey / the passed-through client key, and taskDraft must
 *   use the same one, otherwise the upstream auth behavior is inconsistent (historical bug: all 401 in production → "Untitled task_").
 *
 * Environment variable scenario: when deployed behind an OpenAI-compatible gateway (such as rcaaitoken), if the protocol passed by the client
 * does not match the actual upstream protocol and causes 401, ops can override with MEMORY_LLM_*, with no code change.
 */
export function resolveTaskDraftConfig(
  input: TaskDraftUpstream & { config: ProxyConfig; agentSource: string },
): { cfg: TaskDraftConfig } | { error: string } {
  const { config, agentSource } = input;
  const td = config.memCommand?.taskDraft;

  // Environment variable override (highest priority; ops can fully take over the LLM config of task-draft)
  const envProtocol = process.env.MEMORY_LLM_PROTOCOL as "openai" | "anthropic" | "responses" | undefined;
  const envApiKey = process.env.MEMORY_LLM_API_KEY;
  const envBaseUrl = process.env.MEMORY_LLM_BASE_URL;
  const envModel = process.env.MEMORY_LLM_MODEL;

  // Main path upstream key (replicating the three-tier semantics) → taskDraft dedicated key
  const upstreamKey = resolveUpstreamApiKeyForAgent(config, agentSource, input.apiKey ?? "");

  // Priority: env override > main path three tiers > taskDraft dedicated
  const apiKey = envApiKey || upstreamKey || td?.apiKey || "";
  const url = envBaseUrl || input.upstreamUrl || td?.url || "";
  const model = envModel || input.model || td?.model || "";
  const protocol = envProtocol || input.protocol;

  if (!model || !url || !apiKey) {
    return {
      error:
        "task_draft is not configured (missing model / upstream url / apiKey). " +
        "Checked: env (MEMORY_LLM_*), main upstream (config.upstream[.agents], per-agent three-tier semantics), " +
        "config.memCommand.taskDraft — all empty. Set MEMORY_LLM_* env or check handler wiring / config.",
    };
  }

  return {
    cfg: {
      enabled: true,
      model,
      url,
      apiKey,
      timeoutMs: td?.timeoutMs ?? DEFAULT_TASK_DRAFT_TIMEOUT_MS,
      ...(protocol ? { protocol } : {}),
    },
  };
}

function getClientFromResolved(resolved: ResolvedSession, config: ProxyConfig, fallbackSpaceId: string) {
  return getMetadataClient(
    config.coreSkill,
    resolved.sessionInfo.space_id ?? fallbackSpaceId,
    resolved.sessionInfo.user_key ?? "",
  );
}

function normalizeDesc(d: string | null | undefined): string | undefined {
  return d == null ? undefined : d;
}

/** Generate the pending key from the resolved session (including the team/agent/session triple). */
function pendingKeyOf(resolved: ResolvedSession, agentSource: string, sessionKey: string): string {
  return makePendingKey({
    team_id: resolved.teamId,
    // pending-store's agent uses sessionInfo.agent_id (a kernel-side concept), falling back to agentSource when missing
    agent_id: resolved.sessionInfo.agent_id ?? agentSource,
    session_id: sessionKey,
  });
}

// -- Internal: the two atomic operations that actually persist (direct on first call / also used at confirm) --

/**
 * Execute create: call kernel createTask, then bind the session.
 * agent_id is taken from sessionInfo if possible; if missing it is not passed (the kernel decides).
 */
async function doCreateAndBind(
  resolved: ResolvedSession,
  input: { sessionKey: string; agentSource: string; config: ProxyConfig; spaceId: string },
  title: string,
  description: string,
): Promise<{ ok: true; task: TaskEntity; bindWarning?: string } | { ok: false; error: string }> {
  let created: TaskEntity;
  try {
    const client = getClientFromResolved(resolved, input.config, input.spaceId);
    created = await client.createTask({
      team_id: resolved.teamId,
      creator_user_id: resolved.userId,
      title,
      description,
      ...(resolved.sessionInfo.agent_id ? { agent_id: resolved.sessionInfo.agent_id } : {}),
    });
  } catch (err) {
    return { ok: false, error: `metadata createTask failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await bindTaskIdToSession(input.sessionKey, input.agentSource, created.task_id);
  } catch (err) {
    return {
      ok: true,
      task: created,
      bindWarning: `task created but session bind failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, task: created };
}

// -- Core: create-task -----------------------------------------------------------
//
// Interaction layering:
//   unbound + any arguments → LLM generates a draft → persist immediately (no confirm needed)
//   real task already bound → LLM generates a draft → write pending, wait for confirm/cancel

export async function createTaskFromSession(
  input: CreateTaskFromSessionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const draftCfg = resolveTaskDraftConfig(input);
  if ("error" in draftCfg) return { success: false, error: draftCfg.error };

  // Step 1: LLM generates the draft (when lockedTitle is set only the description is produced)
  const draft = await generateTaskDraft(draftCfg.cfg, {
    mode: "create",
    hint: input.hint,
    recentMessages: input.recentMessages,
    ...(input.lockedTitle ? { lockedTitle: input.lockedTitle } : {}),
  });

  // Step 1a: result normalization
  //
  // Three-tier degradation (fix of 2026-08-18 for the excessive failure rate):
  //   1) draft.ok=true          → use the LLM result
  //   2) draft.ok=false + lockedTitle → title=lockedTitle, desc=""
  //   3) draft.ok=false + no arguments → fall back to "Untitled task_yyMMdd_HHmm", desc="", letting the user fill in later with mem:update-task
  //
  // Previously tier 3 was "strictly return an error", so any LLM hiccup forced the user to retry 3 times -- a terrible UX.
  // Now a default name is given and bound, and the user can add a description at any time after getting the taskId;
  // the fallback error message is passed through to the upper layer via bindWarning, and the UI layer may optionally hint "AI naming failed, default name used".
  let finalTitle: string;
  let finalDescription: string;
  let draftFallbackWarning: string | undefined;
  if (draft.ok) {
    finalTitle = draft.title;
    finalDescription = draft.description;
  } else if (input.lockedTitle) {
    // With arguments + LLM failure → degrade: title uses the argument, desc left empty
    finalTitle = input.lockedTitle;
    finalDescription = "";
    draftFallbackWarning = `AI description failed (${draft.error}); saved with empty description`;
  } else {
    // No arguments + LLM failure → fallback: "Untitled task_yyMMdd_HHmm"
    finalTitle = buildFallbackTaskTitle();
    finalDescription = "";
    draftFallbackWarning = `AI draft failed (${draft.error}); saved with default title, use mem:update-task to refine`;
  }

  // Step 2a: real task already bound → write pending, wait for confirm to overwrite the binding
  if (resolved.currentTaskId) {
    let boundTitle: string | undefined;
    try {
      const client = getClientFromResolved(resolved, input.config, input.spaceId);
      const t = await client.getTask(resolved.currentTaskId);
      boundTitle = t.title;
    } catch {
      // Failing to fetch the old task title does not block either (only affects preview display)
    }
    const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
    const payload: PendingCreatePayload = {
      kind: "create",
      draft: {
        title: finalTitle,
        description: finalDescription,
        ...(input.hint ? { hint: input.hint } : {}),
      },
      currentTaskId: resolved.currentTaskId,
      ...(boundTitle ? { currentTaskTitle: boundTitle } : {}),
    };
    setPending(key, payload);
    return {
      success: true,
      alreadyBound: true,
      taskId: resolved.currentTaskId,
      ...(boundTitle ? { title: boundTitle } : {}),
      pending: {
        kind: "create",
        draftTitle: finalTitle,
        draftDescription: finalDescription,
        currentTaskId: resolved.currentTaskId,
        ...(boundTitle ? { currentTaskTitle: boundTitle } : {}),
      },
      ...(draftFallbackWarning ? { error: draftFallbackWarning } : {}),
    };
  }

  // Step 2b: unbound → persist directly
  const persisted = await doCreateAndBind(resolved, input, finalTitle, finalDescription);
  if (!persisted.ok) return { success: false, error: persisted.error };
  const created = persisted.task;
  // Merge two kinds of warnings: AI fallback + binding failure, both passed through to the upper layer via the error field
  // (the field name error is a historical leftover; the semantics are "success=true but with a warning")
  const combinedWarning = [draftFallbackWarning, persisted.bindWarning]
    .filter((w): w is string => !!w)
    .join("; ");
  return {
    success: true,
    taskId: created.task_id,
    title: created.title,
    description: normalizeDesc(created.description),
    status: created.status,
    ...(combinedWarning ? { error: combinedWarning } : {}),
  };
}

/**
 * Generate "Untitled task_yyyyMMdd_HHmm" as the LLM fallback title.
 *
 * The timestamp is accurate to the minute, balancing readability & searchability:
 *   - the user seeing "Untitled task_260818_1710" can immediately locate when it was created
 *   - seconds are not used, to avoid duplicate names on consecutive creation -- and opening two tasks within a minute is an abnormal operation
 * Guarantees ≤ MAX_TITLE_LEN(40) characters.
 */
function buildFallbackTaskTitle(): string {
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `Untitled task_${yy}${MM}${dd}_${HH}${mm}`;
}

// -- Core: update-task -----------------------------------------------------------
//
// Interaction layering (confirm is required every time):
//   unbound → intercept and return an error, letting the user create-task first
//   bound → fetch the current task → generate a draft (including a status suggestion) → write pending → return pending
//          a non-creator is rejected directly (the kernel also does not support cross-user update; the proxy side gives the create-task guidance up front)

export async function updateTaskFromSession(
  input: UpdateTaskFromSessionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  if (!resolved.currentTaskId) {
    return {
      success: false,
      error:
        "no task bound to this session (session is in \"暂时跳过\" mode or task_id missing); " +
        "use mem:create-task to create and bind a new task first",
    };
  }

  // Only the no-argument branch needs the LLM config
  if (!input.directDescription) {
    const draftCfg = resolveTaskDraftConfig(input);
    if ("error" in draftCfg) return { success: false, error: draftCfg.error };
  }

  // Step 1: fetch the current task
  const client = getClientFromResolved(resolved, input.config, input.spaceId);
  let current: TaskEntity;
  try {
    current = await client.getTask(resolved.currentTaskId);
  } catch (err) {
    return {
      success: false,
      error: `metadata getTask failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // A non-creator is rejected directly (the kernel side still rejects cross-user update with its owner-check; the proxy side blocks it early to give clear guidance)
  if (current.creator_user_id && current.creator_user_id !== resolved.userId) {
    return {
      success: false,
      error: "not_creator",
    };
  }

  // Step 2: decide the new description + statusSuggestion
  let newDescription: string;
  let statusSuggestion: string | undefined;
  if (input.directDescription !== undefined) {
    // With arguments: replace directly, without calling the LLM or giving a status suggestion
    newDescription = input.directDescription;
  } else {
    const draftCfg = resolveTaskDraftConfig(input);
    if ("error" in draftCfg) return { success: false, error: draftCfg.error };

    const draft = await generateTaskDraft(draftCfg.cfg, {
      mode: "update",
      hint: input.hint,
      recentMessages: input.recentMessages,
      currentTask: {
        title: current.title,
        description: current.description ?? "",
        status: current.status ?? "running",
      },
    });
    if (!draft.ok) return { success: false, error: `draft failed: ${draft.error}` };
    if (!draft.changed) {
      // The LLM judged no change → do not write pending, return noUpdateNeeded directly
      return {
        success: true,
        noUpdateNeeded: true,
        taskId: current.task_id,
        title: current.title,
        description: normalizeDesc(current.description),
        status: current.status,
      };
    }
    newDescription = draft.description;
    statusSuggestion = draft.suggestedStatus;
  }

  // Step 3: write pending, wait for confirm
  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const payload: PendingUpdatePayload = {
    kind: "update",
    draft: {
      taskId: current.task_id,
      description: newDescription,
      ...(statusSuggestion ? { statusSuggestion } : {}),
      ...(current.title ? { currentTitle: current.title } : {}),
      ...(current.status ? { currentStatus: current.status } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
    },
  };
  setPending(key, payload);

  return {
    success: true,
    taskId: current.task_id,
    title: current.title,
    description: normalizeDesc(current.description),
    status: current.status,
    pending: {
      kind: "update",
      taskId: current.task_id,
      ...(current.title ? { currentTitle: current.title } : {}),
      ...(current.description ? { currentDescription: current.description } : {}),
      ...(current.status ? { currentStatus: current.status } : {}),
      draftDescription: newDescription,
      ...(statusSuggestion ? { statusSuggestion } : {}),
    },
  };
}

// -- Core: confirm / cancel ------------------------------------------------------

/**
 * Called when the user replies `mem:create-task confirm` or `mem:update-task confirm`.
 * Dispatches by the kind in pending:
 *   - create → doCreateAndBind (overwriting the original binding)
 *   - update → kernel updateTask (description + status passed through)
 * On successful persistence, pending is cleared; on failure pending is kept (the user can retry).
 */
export async function confirmPendingTaskAction(
  input: PendingActionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const payload = getPending(key);
  if (!payload) {
    return { success: false, noPending: true, error: "no pending task action (may have expired or been cancelled)" };
  }

  if (payload.kind === "create") {
    const previousTaskId = payload.currentTaskId;
    const persisted = await doCreateAndBind(
      resolved,
      input,
      payload.draft.title,
      payload.draft.description,
    );
    if (!persisted.ok) {
      // On persistence failure keep pending so the user can retry
      return { success: false, error: persisted.error };
    }
    clearPending(key);
    const t = persisted.task;
    return {
      success: true,
      taskId: t.task_id,
      title: t.title,
      description: normalizeDesc(t.description),
      status: t.status,
      previousTaskId,
      ...(persisted.bindWarning ? { error: persisted.bindWarning } : {}),
    };
  }

  // update branch
  const client = getClientFromResolved(resolved, input.config, input.spaceId);
  let updated: TaskEntity;
  try {
    updated = await client.updateTask(payload.draft.taskId, {
      description: payload.draft.description,
      ...(payload.draft.statusSuggestion ? { status: payload.draft.statusSuggestion } : {}),
    });
  } catch (err) {
    return {
      success: false,
      error: `metadata updateTask failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  clearPending(key);
  return {
    success: true,
    taskId: updated.task_id,
    title: updated.title,
    description: normalizeDesc(updated.description),
    status: updated.status,
  };
}

/**
 * Called when the user replies `mem:create-task cancel` or `mem:update-task cancel`:
 * clear pending, do not persist. Returns cancelled=true for the command layer to assemble the hint text.
 */
export async function cancelPendingTaskAction(
  input: PendingActionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const existed = clearPending(key);
  return { success: true, cancelled: existed };
}

// -- Internal: write taskId back into sessionInfo ------------------------------------

async function bindTaskIdToSession(
  sessionKey: string,
  agentSource: string,
  taskId: string,
): Promise<void> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state = store.get(compositeKey);
  if (!state || !state.sessionInfo) {
    throw new Error(`session ${sessionKey} vanished during bind`);
  }
  const newSessionInfo: SessionInfo = { ...state.sessionInfo, task_id: taskId };
  const newState: SessionInitState = { ...state, sessionInfo: newSessionInfo };
  await store.set(compositeKey, newState);
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────

/**
 * POST /v3/session/create-task
 *
 * For the panel frontend / e2e. The body looks like:
 *   { session_key, agent_source, space_id, hint?, locked_title?, recent_messages?: [...] }
 * If recent_messages is not included, it returns "no recent messages" -- the panel must pass it actively (pulling the most recent N items from
 * conversation/query).
 */
export function createSessionCreateTaskHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `create-task-${Date.now()}` }, 400);
    }

    const parsed = parseCreateTaskBody(body);
    if ("error" in parsed) {
      return c.json({ code: 40001, message: parsed.error, request_id: `create-task-${Date.now()}` }, 400);
    }

    const result = await createTaskFromSession({ ...parsed, config });
    return respond(c, result, "create-task");
  };
}

/**
 * POST /v3/session/update-task -- same as above, but takes the update branch.
 */
export function createSessionUpdateTaskHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `update-task-${Date.now()}` }, 400);
    }

    const parsed = parseUpdateTaskBody(body);
    if ("error" in parsed) {
      return c.json({ code: 40001, message: parsed.error, request_id: `update-task-${Date.now()}` }, 400);
    }

    const result = await updateTaskFromSession({ ...parsed, config });
    return respond(c, result, "update-task");
  };
}

// -- HTTP body parsing ------------------------------------------------------------

function parseCommonBody(
  body: Record<string, unknown>,
):
  | { sessionKey: string; agentSource: string; spaceId: string; hint?: string; recentMessages: MemCommandMessage[] }
  | { error: string } {
  const sessionKey = typeof body.session_key === "string" ? body.session_key : "";
  if (!sessionKey) return { error: "session_key is required" };
  const agentSource = typeof body.agent_source === "string" ? body.agent_source : "claude-code";
  const spaceId = typeof body.space_id === "string" ? body.space_id : "";
  const hint = typeof body.hint === "string" ? body.hint : undefined;

  const rawMsgs = Array.isArray(body.recent_messages) ? body.recent_messages : [];
  const recentMessages: MemCommandMessage[] = [];
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const role = obj.role;
    const content = obj.content;
    if (
      (role === "user" || role === "assistant" || role === "system") &&
      typeof content === "string" &&
      content.length > 0
    ) {
      recentMessages.push({ role, content });
    }
  }

  return { sessionKey, agentSource, spaceId, hint, recentMessages };
}

function parseCreateTaskBody(
  body: Record<string, unknown>,
):
  | {
      sessionKey: string;
      agentSource: string;
      spaceId: string;
      hint?: string;
      recentMessages: MemCommandMessage[];
      lockedTitle?: string;
    }
  | { error: string } {
  const base = parseCommonBody(body);
  if ("error" in base) return base;
  const lockedTitle = typeof body.locked_title === "string" && body.locked_title.trim().length > 0
    ? body.locked_title.trim()
    : undefined;
  return { ...base, ...(lockedTitle ? { lockedTitle } : {}) };
}

function parseUpdateTaskBody(
  body: Record<string, unknown>,
):
  | {
      sessionKey: string;
      agentSource: string;
      spaceId: string;
      hint?: string;
      recentMessages: MemCommandMessage[];
      directDescription?: string;
    }
  | { error: string } {
  const base = parseCommonBody(body);
  if ("error" in base) return base;
  const directDescription = typeof body.direct_description === "string"
    ? body.direct_description
    : undefined;
  return { ...base, ...(directDescription !== undefined ? { directDescription } : {}) };
}

function respond(c: Context, result: TaskFromSessionResult, tag: string): Response {
  const requestId = `${tag}-${Date.now()}`;
  if (!result.success) {
    const isNoPending = result.noPending === true;
    const isNotFound = result.error?.includes("not found") || result.error?.includes("no task bound");
    const status = isNoPending ? 404 : isNotFound ? 404 : 500;
    const code = isNoPending ? 40402 : isNotFound ? 40401 : 50001;
    return c.json(
      {
        code,
        message: result.error,
        request_id: requestId,
      },
      status,
    );
  }
  return c.json({
    code: 0,
    message: "ok",
    request_id: requestId,
    data: {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      no_update_needed: result.noUpdateNeeded ?? false,
      ...(result.pending ? { pending: result.pending } : {}),
      ...(result.cancelled !== undefined ? { cancelled: result.cancelled } : {}),
      ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
    },
  });
}
