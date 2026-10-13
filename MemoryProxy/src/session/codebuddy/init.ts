/**
 * CodeBuddy Session Initialization — state machine entry.
 *
 * Flow:
 *   1. uninitialized → kernel fetches teams[], sends the `ask_followup_question` form
 *   2. pending_team_select → parse the user's team choice, send the agent_task form
 *   3. pending_agent_task → parse agent+task, fetch details, register, inject
 *   4. initialized → strip + inject on every request
 */

import type { SessionInitConfig } from "../../types.js";
import type {
  AgentDetail,
  SessionInitData,
  SessionInitState,
  SessionRegistrationData,
  TaskDetail,
  TaskInTeam,
  TeamOption,
} from "../types.js";
import { DEFAULT_TASK_LABEL } from "../types.js";
import { SessionStore } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import { injectSessionContextWithToggles } from "../context-injector.js";
import type { MetadataClient } from "../../meta/client.js";
import { isHeaderOnlyAgent, resolvePresetIdentity, type PresetIdentity } from "../preset.js";

import { buildFormResponse, FormData } from "./form.js";
import { buildBypassNoticeResponse } from "../workbuddy/text-form.js";
import {
  extractFromOptionText,
  extractTeamFromOptionText,
  extractAssetConfirm,
  extractStructured,
  extractAgentOnly,
  extractTaskOnly,
  resolveAgent,
  resolveTask,
  BYPASS_MARKER,
} from "./extractor.js";
import { getLastUserMessageText } from "./cleaner.js";
import { emitSessionInitTelemetryIfCompleted } from "../init-telemetry.js";
import { isDshRuntimeContextSnapshot } from "../../common/user-query-extractor.js";
import {
  CODEX_MORE_LABEL,
  DEFAULT_GATE_PREFIX,
  detectCodexMore,
} from "../codex/form.js";
// WorkBuddy reuses CC's AskUserQuestion form + CC's pagination layout (workbuddy/form.ts directly
// imports computePagination + MORE_LABEL="More →"). When WorkBuddy goes through the CB state machine, the
// MORE page-turn interception must use the same MORE_LABEL check + computePagination out-of-range check to stay aligned with the
// form-side slicing. CC's MORE_LABEL value is identical to workbuddy/form.ts.
import { MORE_LABEL as WB_MORE_LABEL } from "../claude-code/form.js";
import { computePagination as computeCCPagination } from "../claude-code/pagination.js";
import type { ClientCapabilities } from "../client-capabilities.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionRequestContext {
  stream: boolean;
  modelId: string;
  protocol?: "openai" | "anthropic";
  /**
   * Client capability flags (detected at the handler layer and passed through).
   *
   * Currently the only consumer is the workbuddy branch:
   *   - `askUserQuestion === false` → no card capability, use text mode (content chunk + plain-text parsing)
   *   - `askUserQuestion === true` / `undefined` → use the original card mode
   *
   * When unset it is equivalent to `{ askUserQuestion: true }` (aligned with existing behavior).
   */
  capabilities?: ClientCapabilities;
  /**
   * codex client only: codex answers do not go through CB-compatible messages[]; they are placed in
   * `function_call_output` items inside `body.input[]`. codexHandler already uses
   * `codexFormAnswersAsMessages` to produce a `messages` copy for the CB state machine to do normal
   * option matching, but the state machine internally still needs the **raw** input[] in order to:
   *   1. detect the Default-mode gate string (the client replays historical gate output on every request)
   *   2. precisely locate, by question id, which of team/agent/task the MORE hit belongs to
   *
   * CC / plain CB scenarios never pass this field.
   */
  codexAnswerInput?: unknown[];
  /**
   * The CB v1.106+ ask_followup_question schema requires questions to be a real array;
   * older versions expect a JSON string. The handler detects this from body.tools and fills this field,
   * and the form builder uses it to decide whether to JSON.stringify(questions).
   * Defaults to true when unset (aligned with the new version).
   */
  questionsAsArray?: boolean;
}

export interface SessionInitResult {
  intercepted: boolean;
  response?: Response;
  messages?: Record<string, unknown>[];
  sessionInfo?: import("../types.js").SessionInfo | null;
  justRegistered?: boolean;
  agentDetail?: AgentDetail | null;
  taskDetail?: TaskDetail | null;
  /**
   * Display name of the bound team (from cachedTeams[selected].team_name).
   * Used by display layers such as the mem:session-reset completion confirmation; only has a value once session-init completes.
   */
  teamName?: string | null;
  /** User chose "No" to linking team assets → bypass path; all injection hooks should be skipped. */
  bypassed?: boolean;
  /**
   * This registration was triggered by session-reset (the pre-hook sets state.resetFlow=true →
   * preserved into the return value of completeRegistration). Mirrors the field of the same name in claude-code/init.ts
   * — both sides must keep the same shape, otherwise the union
   * type exported from session/index.ts (`CBSessionInitResult`) cannot read this property, and the runner side's
   * `initResult.resetFlow` would all be TS2339.
   */
  resetFlow?: boolean;
  /**
   * Reason the bypass was triggered (only meaningful when `bypassed === true`). codexHandler uses it to decide
   * whether the first gate hit should return a "Plan mode hint" rather than pass through directly.
   *
   * - "default-gate"  → the codex client's Default mode intercepted our request_user_input
   *                     and forged the string "request_user_input is unavailable in Default mode";
   *                     codexHandler should return a Plan mode hint once and then enter the bypass
   *                     steady state.
   * - undefined       → other bypass paths (user explicitly chose "No", no-agents, preset
   *                     mismatch, etc.), which follow each handler's default bypass behavior.
   *
   * CC/CB clients cannot trigger default-gate themselves (the client never forges the gate string); the constant is kept
   * only for cross-handler checks.
   */
  bypassReason?: "default-gate";
  /**
   * Anthropic-only: pre-built `<session_context>` string the caller must
   * append to `body.system` (the ClaudeCode init module populates this;
   * CodeBuddy stays OpenAI so it is always undefined here). Kept in this
   * interface so `session/index.ts`'s union type stays uniform.
   */
  systemAppend?: string | null;
  /**
   * Raw FormData — **always** populated when `intercepted === true`.
   *
   * After the codex handler gets it, it re-renders with `session/codex/form.ts::buildFormResponse` into the
   * OpenAI Responses API SSE format (`response.output_item.added` +
   * `function_call` item). CB / CC themselves never read this field — `response` is already the complete response
   * in their respective protocols.
   */
  formData?: FormData;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type MessageArr = Record<string, unknown>[];

/**
 * codex-only: determine whether the last function_call_output in `body.input[]` is a
 * client Default-mode gate interception. The client carries historical gate output on every turn, so
 * "is this the first hit" is decided by the caller via sessionStore.bypassed; this only does structural recognition.
 *
 * CB/CC clients never send this string, so opting in to detect this codex-specific scenario inside the CB state machine
 * (agentSource==="codex" + non-empty reqCtx.codexAnswerInput) is still safe.
 */
function detectCodexDefaultGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // Only recognize the case where "the last item of input is the gate output", i.e. this turn the codex client
  // intercepted the tool_call and replayed the gate directly.
  //
  // Why we must look at the **last item** instead of "the newest function_call_output":
  // the codex client replays the whole historical input every turn; once a Default-mode
  // gate output appears in history, it stays in input forever. After the user switches from Default to Plan and resends the command,
  // the client **appends a new user message** at the end of input (that mem:session-reset
  // or the user's reply to the form), while the old gate output remains in the middle. If we scanned for the "newest function_call_output",
  // we would always hit the old gate and loop forever stuck on the "please switch to Plan mode" text.
  //
  // Only when the tail is a function_call_output (meaning the client just replayed the gate and the user has not typed yet)
  // is it judged Default; if the tail is a user message / tool_use / anything else → it is a new turn,
  // ignore the stale historical gate.
  const last = input[input.length - 1] as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return false;
  if (last.type !== "function_call_output") return false;
  const output = last.output;
  return typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX);
}

/**
 * codex-only: based on recovered.status + detectCodexMore().perQuestion decide
 * the pageIndex (team/agent/task) that should be bumped. Returns the bump result and the already filled
 * new codexPageIndex object; the caller writes state with it and resends the form of the same stage.
 *
 * partialMore scenario (agent really chosen, task=more): bump the task side pageIndex+1 directly
 * then hand over to the CB state machine to continue consuming — CB only hits the really chosen agent to advance the big state; the task side relies on
 * the taskPage value of the next stage form to re-ask the question.
 */
function computeCodexPageBumps(
  cur: { teamPage?: number; agentPage?: number; taskPage?: number } | undefined,
  perQuestion: { team_select: boolean; agent_select: boolean; task_select: boolean },
  fallbackStage: "team" | "agent" | "task" | null,
): { next: { teamPage: number; agentPage: number; taskPage: number }; bumped: Array<"team" | "agent" | "task"> } {
  const teamPage = cur?.teamPage ?? 0;
  const agentPage = cur?.agentPage ?? 0;
  const taskPage = cur?.taskPage ?? 0;
  const bumped: Array<"team" | "agent" | "task"> = [];
  let nextTeam = teamPage;
  let nextAgent = agentPage;
  let nextTask = taskPage;
  if (perQuestion.team_select) { nextTeam++; bumped.push("team"); }
  if (perQuestion.agent_select) { nextAgent++; bumped.push("agent"); }
  if (perQuestion.task_select) { nextTask++; bumped.push("task"); }
  if (bumped.length === 0 && fallbackStage) {
    if (fallbackStage === "team") { nextTeam++; bumped.push("team"); }
    else if (fallbackStage === "agent") { nextAgent++; bumped.push("agent"); }
    else if (fallbackStage === "task") { nextTask++; bumped.push("task"); }
  }
  return { next: { teamPage: nextTeam, agentPage: nextAgent, taskPage: nextTask }, bumped };
}

/**
 * Generate FormData carrying the codex pagination page numbers, for the codex handler to re-render. The CB client
 * ignores these page fields (CB `ask_followup_question` has no pagination).
 */
function withCodexPageIndex(
  fd: FormData,
  px: { teamPage?: number; agentPage?: number; taskPage?: number } | undefined,
): FormData {
  if (!px) return fd;
  return {
    ...fd,
    teamPage: px.teamPage ?? 0,
    agentPage: px.agentPage ?? 0,
    taskPage: px.taskPage ?? 0,
  };
}

/**
 * WorkBuddy-only: detect whether the user's reply at a given stage clicked "More →"; if so compute the pageIndex after paging
 * (wrapping around to page 0 when out of range).
 *
 * Background: WorkBuddy (agentSource="workbuddy") reuses the CB state machine to run
 * uninitialized → pending_team_select → pending_agent_select → pending_task_select
 * the whole flow, but form rendering goes through workbuddy/form.ts (AskUserQuestion + CC pagination,
 * MORE_LABEL="More →"). The CB state machine originally only intercepted MORE in the agentSource="codex" branch
 * (the isCodexSource gate in section B); once WorkBuddy lands in the pending_*_select branch,
 * extractAgentOnly/extractTaskOnly do not recognize "More →" → unrecognized → page 1 resent endlessly.
 *
 * Fix: at the entry of each pending_*_select branch, before running the extractor, use this function to check
 * MORE. On a hit, bump the page number of the corresponding stage and resend the form of the same stage (the page number is picked from codexPageIndex by stage via the
 * workbuddy re-render branch in session/index.ts,
 * and passed to the pageIndex of workbuddy/form.ts).
 *
 * @param answerText  user reply text extracted by getLastUserMessageText(messages)
 * @param currentPage page number of the current stage (0-based)
 * @param total       total candidates in the current stage (agents.length / tasks.length / teams.length)
 * @returns null=not MORE; number=pageIndex after paging (wraps to 0 when out of range)
 */
function detectWorkbuddyMorePage(
  answerText: string,
  currentPage: number,
  total: number,
): number | null {
  if (!answerText.includes(WB_MORE_LABEL)) return null;
  const nextPage = currentPage + 1;
  // Use the same pagination algorithm as the form side to check out-of-range, preventing a stop on an out-of-range page after paging past the last page, which would make the form throw the
  // solo-page assertion; aligned with the safeNextPage wrap-around logic of claude-code/init.ts.
  const totalPages = computeCCPagination(Math.max(0, total), 0).totalPages;
  return nextPage > totalPages - 1 ? 0 : nextPage;
}

/** Determine whether this is a "brand new" CodeBuddy / dsh conversation (at most one real user input, no assistant/tool).
 *
 * The dsh (deepseek-harness) first-frame body carries 3 **non-user-input** role=user metadata messages:
 *   - <system-reminder> workspace instructions
 *   - "Current runtime context." snapshot
 *   - <system-reminder>\nA skill is a reusable... <available_skills> list
 * Counting them as-is would misjudge the dsh first frame as "not brand new" → the upper safety-net would skip session-init.
 * Here, while counting, skip user messages carrying a dsh metadata signature (string content starting with a known anchor).
 * See MemoryProxy/docs/dsh-recon/2026-08-14-dsh-capture-analysis.md §2.3.
 */
function isFreshCBConversation(messages: MessageArr): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = (m.role as string) ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role !== "user") continue;
    // dsh metadata user messages do not count as real user input
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") {
      if (
        c.startsWith("<system-reminder>") ||
        isDshRuntimeContextSnapshot(c)
      ) {
        continue;
      }
    }
    userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}

async function fetchTeamsAndAgents(
  userId: string,
  config: SessionInitConfig,
  metadataClient: MetadataClient,
): Promise<{ teams: TeamOption[] }> {
  const teamsRaw = await metadataClient.listTeams(userId);
  const teams: TeamOption[] = [];

  // Parallel fan-out: for each team, fetch agents & tasks concurrently
  const teamResults = await Promise.all(
    teamsRaw.map(async (t) => {
      const [agentsRaw, tasksRaw] = await Promise.all([
        // Agents are scoped to (team, owner) — each user only sees the agents
        // they created within the team. Tasks remain team-wide (unchanged).
        metadataClient.listAgents(t.team_id, userId),
        metadataClient.listTasks(t.team_id),
      ]);
      const tasks: TaskInTeam[] = tasksRaw.map((tk) => ({
        task_id: tk.task_id,
        task_name: tk.title,
      }));
      // See the same comment in fetchTeamsAndAgents of claude-code/init.ts: defaultTaskId
      // is unshifted at the source into the head of the tasks list, and downstream form/extractor follow the existing path.
      if (config.defaultTaskId) {
        tasks.unshift({
          task_id: config.defaultTaskId,
          task_name: DEFAULT_TASK_LABEL,
          isDefault: true,
        });
      }
      return {
        team_id: t.team_id,
        team_name: t.name,
        agents: agentsRaw.map((a) => ({
          agent_id: a.agent_id,
          agent_name: a.name,
          description: a.description ?? undefined,
        })),
        tasks,
      };
    }),
  );
  teams.push(...teamResults);
  return { teams };
}

function findTeamIdForAgent(teams: TeamOption[], agentId: string): string | undefined {
  for (const team of teams) {
    if (team.agents.some((a) => a.agent_id === agentId)) return team.team_id;
  }
  return undefined;
}

/**
 * Assemble the registration payload for a resolved (agent, task). Returns
 * `null` when the agent cannot be matched to any team in the cached list —
 * the caller must bypass session init in that case (there is no
 * `defaultTeamId` fallback any more).
 */
function buildRegistrationData(
  extracted: SessionInitData,
  cachedTeams: TeamOption[],
  sessionId: string,
  userId: string,
): SessionRegistrationData | null {
  const teamId = findTeamIdForAgent(cachedTeams, extracted.agent_id);
  if (!teamId) return null;
  return {
    team_id: teamId,
    user_id: userId,
    agent_id: extracted.agent_id,
    task_id: extracted.task_id,
    session_id: sessionId,
  };
}

function applyArtifactsAndContext(
  messages: MessageArr,
  agentDetail: AgentDetail | null | undefined,
  taskDetail: TaskDetail | null | undefined,
  sessionKey: string,
  config: SessionInitConfig,
): MessageArr {
  // This used to decide whether to stripInitArtifacts based on config.keepInitArtifacts;
  // now the session_init form interaction is **always preserved** and nothing is deleted.
  const injected = injectSessionContextWithToggles(messages, agentDetail, taskDetail, config, sessionKey);
  if (injected !== messages) {
    const finalRoles = (injected as unknown[]).map((m: any) => m.role);
    console.log(
      `[session-init:cb] session=${sessionKey} processed: ${messages.length} msgs, ` +
        `ctx=${agentDetail ? "Y" : "N"}/${taskDetail ? "Y" : "N"} final=[${finalRoles.join(",")}]`,
    );
  }
  return injected as MessageArr;
}

/**
 * Register a session given a resolved agent(+task), fetch details, inject context.
 * Shared by the interactive form path (Case 2) and the header pre-selection path.
 */
export async function completeRegistration(
  resolved: SessionInitData,
  state: SessionInitState,
  cachedTeams: TeamOption[],
  compositeKey: string,
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  messages: MessageArr,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
): Promise<SessionInitResult> {
  const regUserId = (state as any).userId || userId;
  if (!regUserId) {
    console.warn(
      `[session-init:cb] session=${compositeKey} no user_id available → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
  }
  // task_id is OPTIONAL for registration: the kernel treats task as an
  // optional business dimension (isolation.ts), so a header-identity agent
  // with team+agent but no task (or a stale task) still registers and gets
  // memory — recall just broadens across the agent's memories instead of
  // narrowing to a task. The interactive "暂时跳过" / defaultTaskId path
  // also lands here with task_id = defaultTaskId (a virtual value). Do NOT
  // bypass when task_id is missing/undefined.
  const regData = buildRegistrationData(resolved, cachedTeams, sessionKey, regUserId);
  if (!regData) {
    console.warn(
      `[session-init:cb] session=${compositeKey} agent=${resolved.agent_id} not bound to any team → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
  }

  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;

  if (metadataClient) {
    // When task_id is defaultTaskId (a virtual value), skip getTask — that task does not exist in the kernel.
    const shouldFetchTask = regData.task_id && regData.task_id !== config.defaultTaskId;
    const [agentRes, taskRes] = await Promise.allSettled([
      metadataClient.getAgent(resolved.agent_id).then((a) => ({
        id: a.agent_id,
        name: a.name,
        description: a.description ?? undefined,
        prompt: a.prompt ?? undefined,
      })),
      shouldFetchTask
        ? metadataClient.getTask(regData.task_id!).then((t) => ({
            id: t.task_id,
            name: t.title,
            description: t.description ?? undefined,
          }))
        : Promise.resolve(null),
    ]);
    if (agentRes.status === "fulfilled") agentDetail = agentRes.value;
    else console.warn(`[session-init:cb] getAgent failed: ${String(agentRes.reason)}`);
    if (taskRes.status === "fulfilled") taskDetail = taskRes.value;
    else console.warn(`[session-init:cb] getTask failed: ${String(taskRes.reason)}`);
  }

  const sessionInfo = buildSessionInfo(regData, userKey, spaceId);
  console.log(
    `[session-init:cb] session=${compositeKey} → initialized ` +
      `agent=${resolved.agent_id} task=${regData.task_id ?? "-"} team=${regData.team_id} user=${sessionInfo.user_id}`,
  );

  // Fire-and-forget: record the participation log (aligned with the claude-code branch, source marked as codebuddy).
  // The bypass scenario already returned above and is naturally filtered; on failure only warn, never block injection.
  // ⚠️ task_id === defaultTaskId is the "暂时跳过" virtual value, not a task that really exists in the kernel;
  //    reporting it directly would trigger a `task_not_found: task not found: default` 404, so skip.
  if (
    metadataClient &&
    typeof metadataClient.appendParticipationLog === "function" &&
    regData.task_id &&
    regData.task_id !== config.defaultTaskId
  ) {
    metadataClient
      .appendParticipationLog({
        team_id: regData.team_id,
        task_id: regData.task_id,
        agent_id: regData.agent_id,
        user_id: regData.user_id,
        source: "context_proxy:codebuddy",
      })
      .catch((err: unknown) => {
        console.warn(
          `[session-init:cb] participation-log append failed for session=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // Look up the display name of the selected team from cachedTeams, for display layers such as the mem:session-reset
  // completion confirmation to compose `Team: {name} ({shortId})`. Returns null if not found.
  const selectedTeam = (state.cachedTeams ?? cachedTeams).find(
    (t) => t.team_id === regData.team_id,
  );
  const teamName = selectedTeam?.team_name ?? null;

  const nextState: SessionInitState = {
    status: "initialized",
    keyId: sessionKey,
    startedAt: state.startedAt,
    attemptCount: state.attemptCount,
    sessionInfo,
    userId: regUserId,
    cachedTeams: state.cachedTeams ?? cachedTeams,
    selectedTeamId: state.selectedTeamId,
    agentDetail,
    taskDetail,
    resetFlow: state.resetFlow,
    resetEpoch: state.resetEpoch,
  };
  await store.set(compositeKey, nextState);

  const out = applyArtifactsAndContext(messages, agentDetail, taskDetail, compositeKey, config);
  return {
    intercepted: false,
    messages: out,
    sessionInfo,
    justRegistered: true,
    agentDetail,
    taskDetail,
    teamName,
    resetFlow: state.resetFlow ?? false,
  };
}

// ── Main Handler ───────────────────────────────────────────────────────────────

/**
 * Top-level entry wrapper: decorates handleSessionInitInner and emits one telemetry event after completion
 * (only when prev !== initialized && after === initialized).
 *
 * The telemetry decoration never changes the state machine; failures/exceptions are silent, with zero impact on the business flow.
 * See docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2.
 */
export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const prevStatus = store.get(compositeKey)?.status ?? "uninitialized";
  try {
    const result = await handleSessionInitInner(
      sessionKey, userId, messages, config, store, reqCtx,
      metadataClient, userKey, spaceId, presetIdentity, agentSource,
    );
    // codex-only post-enhancement: put the codexPageIndex from the latest state into formData,
    // so that codexHandler's buildCodexFormResponse gets the correct paging page numbers. This way
    // all `return { intercepted: true }` sites inside handleSessionInitInner
    // need not be changed one by one. The CB client ignores these fields.
    if (agentSource === "codex" && result.intercepted && result.formData) {
      const latest = store.get(compositeKey);
      if (latest?.codexPageIndex) {
        result.formData = withCodexPageIndex(result.formData, latest.codexPageIndex);
      }
    }
    return result;
  } finally {
    emitSessionInitTelemetryIfCompleted({
      store,
      compositeKey,
      prevStatus,
      agentSource,
    });
  }
}

async function handleSessionInitInner(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  if (sessionKey === "unknown" || !sessionKey) return { intercepted: false };

  const state = store.get(compositeKey);

  // ── codex-only pre-checks: Default gate + MORE pagination ─────────────────
  //
  // The CB/CC clients can never hit these two checks (DEFAULT_GATE_PREFIX / CODEX_MORE_LABEL
  // are codex-client-specific strings), so they are enabled only on opt-in with codex source + raw input;
  // zero regression for legacy CB users.
  //
  // isCodexClient (agentSource === "codex") is the master switch for "stage splitting":
  //   - whenever it is a codex client, session-init goes through the two-step pending_agent_select →
  //     pending_task_select, no longer landing on the old pending_agent_task.
  //   - the CB client's pending_agent_task path (asks both at once) is entirely untouched.
  // The codexInput check lives inside the pre-checks because gate/MORE recognition only happens when
  // the current request also carries an answer; the empty-input first frame does not need it, but still follows the codex semantics for the later stage split.
  const codexInput = reqCtx.codexAnswerInput;
  const isCodexClient = agentSource === "codex";
  const isCodexSource = isCodexClient && Array.isArray(codexInput);

  // A. Default-mode gate — the codex client intercepted request_user_input and filled in the
  //    string "request_user_input is unavailable in Default mode". The first hit
  //    writes the bypass state + bypassReason, so codexHandler returns a Plan mode
  //    hint once; later requests in the same session pass through directly (state.bypassed=true is already covered by the Case 3
  //    branch).
  if (isCodexSource && detectCodexDefaultGate(codexInput)) {
    const alreadyBypassed = state?.bypassed === true;
    if (!alreadyBypassed) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state?.startedAt ?? Date.now(),
        attemptCount: state?.attemptCount ?? 0,
        userId: state?.userId ?? (userId ?? undefined),
        cachedTeams: state?.cachedTeams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(
        `[session-init:cb] session=${compositeKey} codex Default gate → bypass (first hit, notify)`,
      );
      return {
        intercepted: false,
        bypassed: true,
        justRegistered: true,
        bypassReason: "default-gate",
        // When the codex Default gate fires from mem:session-reset, resetFlow is passed through from the old state
        // so codexHandler can switch to the targeted "reset command requires Plan mode" text.
        resetFlow: state?.resetFlow ?? false,
      };
    }
    // Already bypassed: fall through, Case 3 takes the passthrough branch
  }

  // B. MORE paging — the user clicked the "更多..." option. The CB state machine recognizes and advances/pages by itself,
  //    rather than having codexHandler intercept independently. Order of decisions: first check whether there is a real answer (partial vs
  //    full MORE), intercept the whole request only on fullMore; partialMore lets the real answer advance the
  //    big state, and the MORE side automatically carries the new pageIndex in the next stage's form after advancing.
  if (
    isCodexSource &&
    state &&
    state.status !== "initialized" &&
    state.status !== "uninitialized"
  ) {
    const detection = detectCodexMore(codexInput);
    if (detection.hasMore) {
      // Use the text produced by codexFormAnswersAsMessages to judge "whether it contains a non-MORE real answer"
      const answerText = getLastUserMessageText(messages);
      const stripped = answerText.split(CODEX_MORE_LABEL).join("").trim();
      const hasRealAnswer = stripped.length > 0;
      const partialMore = hasRealAnswer && (
        !detection.perQuestion.team_select ||
        !detection.perQuestion.agent_select ||
        !detection.perQuestion.task_select
      );
      // fallbackStage: for a pure-string MORE, infer from state.status
      const fallbackStage: "team" | "agent" | "task" | null =
        detection.perQuestion.team_select || detection.perQuestion.agent_select || detection.perQuestion.task_select
          ? null
          : state.status === "pending_team_select"
            ? "team"
            : state.status === "pending_agent_task" || state.status === "pending_agent_select"
              ? "agent"
              : state.status === "pending_task_select"
                ? "task"
                : null;

      const { next, bumped } = computeCodexPageBumps(state.codexPageIndex, detection.perQuestion, fallbackStage);

      if (bumped.length > 0) {
        await store.set(compositeKey, { ...state, codexPageIndex: next });
        console.log(
          `[session-init:cb] session=${compositeKey} codex MORE (${bumped.join(",")}, ${partialMore ? "partial" : "full"}) → ` +
            `teamPage=${next.teamPage} agentPage=${next.agentPage} taskPage=${next.taskPage}`,
        );

        // Full MORE (no real answer) → intercept the whole request, return the new page form of the current stage.
        // Partial MORE (real answer + MORE) → persist pageIndex but continue through the CB state machine
        // to consume the real answer; the MORE side re-asks via the taskPage/agentPage value of the next stage form.
        if (!partialMore) {
          const cachedTeams = state.cachedTeams ?? [];
          // Stage is inferred from the current state.status. After the split, each pending_* maps to
          // its own independent stage, and only that stage's question is returned to the codex form.
          let stage: FormData["stage"];
          if (state.status === "pending_team_select") stage = "team";
          else if (state.status === "pending_agent_select") stage = "agent_select";
          else if (state.status === "pending_task_select") stage = "task_select";
          else stage = "agent_task"; // legacy pending_agent_task（CB one-shot）
          const fd: FormData = withCodexPageIndex({
            teams: cachedTeams,
            stage,
            selectedTeamId: state.selectedTeamId,
            selectedAgentId: state.selectedAgentId,
            stream: reqCtx.stream,
            questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId,
            protocol: reqCtx.protocol,
          }, next);
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }
        // partial fall through to state-machine dispatch
      }
    }
  }

  // [session-reset] gate removed: always init on missing state

  // ── DEBUG BYPASS ─────────────────────────────────────────────────────
  // When the sessionInit.debugForceIdentity triple is complete and state is not yet initialized,
  // complete registration directly with the forced identity, skipping listTeams / form rendering. Suitable for local/E2E tests,
  // with no dependency on the kernel-side team/agent list API.
  // Applies uniformly to all agentSource (codebuddy/workbuddy/codex).
  if (
    config.debugForceIdentity &&
    userId &&
    metadataClient &&
    (!state || state.status !== "initialized")
  ) {
    const forced = config.debugForceIdentity;
    console.log(
      `[session-init:cb] session=${compositeKey} DEBUG bypass — force identity ` +
        `team=${forced.team_id} agent=${forced.agent_id} task=${forced.task_id ?? "-"} user=${userId}`,
    );
    const forcedTeams: TeamOption[] = [
      {
        team_id: forced.team_id,
        team_name: forced.team_id,
        agents: [
          { agent_id: forced.agent_id, agent_name: forced.agent_id } as any,
        ],
        tasks: forced.task_id
          ? [{ task_id: forced.task_id, task_name: forced.task_id } as any]
          : [],
      } as TeamOption,
    ];
    const seededState: SessionInitState = (state ?? {
      status: "uninitialized",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
    }) as SessionInitState;
    return await completeRegistration(
      { agent_id: forced.agent_id, task_id: forced.task_id } as any,
      seededState,
      forcedTeams,
      compositeKey,
      sessionKey,
      userId,
      config,
      store,
      messages,
      metadataClient,
      userKey,
      spaceId,
    );
  }

  // ── Case 1: Uninitialized → show the asset_confirm dialog first ────────
  if (!state || state.status === "uninitialized") {
    if (!userId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no userId, passing through unintercepted`,
      );
      return { intercepted: false };
    }
    if (!metadataClient) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no metadataClient, passing through unintercepted`,
      );
      return { intercepted: false };
    }

    let teams: TeamOption[];
    try {
      const cfg = await fetchTeamsAndAgents(userId, config, metadataClient);
      teams = cfg.teams;
    } catch (err) {
      console.warn(
        `[session-init:cb] session=${compositeKey} kernel unavailable for user=${userId}, passing through unintercepted: ${err instanceof Error ? err.message : String(err)}`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const totalAgents = teams.reduce((acc, t) => acc + t.agents.length, 0);
    if (totalAgents === 0) {
      console.warn(
        `[session-init:cb] session=${compositeKey} user=${userId} has no active agents, passing through`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        cachedTeams: teams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    // ── Header-only agent short-circuit ────────────────────────────────────
    // pi / hermes / openclaw clients pre-select identity only via request headers and have no interactive form UI:
    //   - pi:       openai-chat, body.tools does not contain ask_followup_question
    //   - hermes:   anthropic, the client does not mount an ask-user tool
    //   - openclaw: same as hermes
    // Any preset failure scenario (missing / mismatch / only team matched but not agent / feature
    // disabled) must bypass — it must never fall into the branch below that pops the ask_followup_question tool_call,
    // which would make the client render an unknown tool error (observed by the user: the pi page crashed outright).
    //
    // Written separately from the generic header-preselect block below: non-header-only agents (codebuddy /
    // workbuddy / dsh / opencode / codex) keep the old semantics of "only team → advance to the agent form",
    // since the form is valid for these clients.
    if (isHeaderOnlyAgent(agentSource)) {
      const prHo = presetIdentity && config.headerAutoSelect?.enabled
        ? resolvePresetIdentity(teams, presetIdentity)
        : null;
      if (prHo && prHo.canRegister) {
        if (presetIdentity?.taskId && !prHo.taskId) {
          console.warn(
            `[session-init:cb] session=${compositeKey} header-only agent=${agentSource} preset task_id="${presetIdentity.taskId}" not found in team=${prHo.teamId} → registering without a task (broad recall)`,
          );
        }
        console.log(
          `[session-init:cb] session=${compositeKey} header-only agent=${agentSource} preset hit team=${prHo.teamId} agent=${prHo.agentId} task=${prHo.taskId ?? "-"} → register directly`,
        );
        const seedState: SessionInitState = {
          status: "uninitialized",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: prHo.teamId,
        };
        return completeRegistration(
          { agent_id: prHo.agentId!, task_id: prHo.taskId },
          seedState, teams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      }
      // preset not hit → bypass (no form, no injection). Once the headers are fixed, the next request recreates an
      // uninitialized state and goes through the canRegister check again.
      const reason = !presetIdentity
        ? "no-preset-headers"
        : !config.headerAutoSelect?.enabled
          ? "header-auto-select-disabled"
          : prHo?.hadMismatch
            ? "preset-mismatch"
            : "preset-partial (team resolved but agent missing/invalid)";
      console.warn(
        `[session-init:cb] session=${compositeKey} header-only agent=${agentSource} ${reason} → bypass (no form popup)`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        cachedTeams: teams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    // ── Header-driven pre-selection: skip forms when identity is provided ──
    if (presetIdentity && config.headerAutoSelect?.enabled) {
      const pr = resolvePresetIdentity(teams, presetIdentity);

      if (pr.hadMismatch) {
        if (config.headerAutoSelect.onMismatch === "bypass") {
          console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → bypass`);
          await store.set(compositeKey, {
            status: "initialized",
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            sessionInfo: null,
            agentDetail: null,
            taskDetail: null,
            bypassed: true,
          } as SessionInitState);
          return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
        }
        console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → fallback to form`);
        // fall through to the normal asset_confirm flow below
      } else if (pr.canRegister) {
        // team + agent resolved → register directly (task optional). A missing
        // task_id yields undefined → broad recall across the agent's memories;
        // a stale (unknown) task_id was already dropped by resolvePresetIdentity
        // (not echoed back) — warn so the operator can re-point the client.
        if (presetIdentity?.taskId && !pr.taskId) {
          console.warn(
            `[session-init:cb] session=${compositeKey} preset task_id="${presetIdentity.taskId}" not found in team=${pr.teamId} → registering without a task (broad recall)`,
          );
        }
        console.log(
          `[session-init:cb] session=${compositeKey} preset hit team=${pr.teamId} agent=${pr.agentId} task=${pr.taskId ?? "-"} → register directly`,
        );
        const seedState: SessionInitState = {
          status: "uninitialized",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        };
        return completeRegistration(
          { agent_id: pr.agentId!, task_id: pr.taskId },
          seedState, teams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      } else if (pr.teamId) {
        // only team resolved → jump straight to agent+task selection (skip
        // asset_confirm + team_select). codex/WB/dsh/opencode use the two-step stage split, agent_select first;
        // the CB client keeps the old pending_agent_task semantics of asking both at once.
        //
        // opencode note: the opencode client's native `question` tool can only pop one question at a time,
        // so it cannot carry the "ask agent+task together" semantics and must split stages (same as codex/wb/dsh).
        const nextStatus = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} preset team=${pr.teamId} → ${nextStatus}`,
        );
        const fd: FormData = {
          teams,
          stage: nextStage,
          selectedTeamId: pr.teamId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    // ── skipAssetConfirm: skip the asset_confirm dialog, treated as the user choosing "Yes" ─────
    if (config.skipAssetConfirm) {
      console.log(
        `[session-init:cb] session=${compositeKey} skipAssetConfirm=true → skip asset_confirm (teams=${teams.length})`,
      );
      if (teams.length === 1) {
        const onlyTeam = teams[0];
        // Progressive auto-select: reuse the 1-team cascade logic of choice===true
        if (onlyTeam.agents.length === 1) {
          const soloAgent = onlyTeam.agents[0];
          const nextState: SessionInitState = {
            status: "pending_agent_select" as any,
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
          };
          console.log(
            `[session-init:cb] session=${compositeKey} skipAssetConfirm only-team=${onlyTeam.team_id} only-agent=${soloAgent.agent_id} auto-select`,
          );
          if (onlyTeam.tasks.length === 0) {
            await store.set(compositeKey, {
              ...nextState,
              status: "initialized",
              sessionInfo: null,
              agentDetail: null,
              taskDetail: null,
              bypassed: true,
            } as SessionInitState);
            return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
          }
          if (onlyTeam.tasks.length === 1) {
            return await completeRegistration(
              { agent_id: soloAgent.agent_id, task_id: onlyTeam.tasks[0].task_id },
              nextState, teams, compositeKey, sessionKey, userId,
              config, store, messages, metadataClient, userKey, spaceId,
            );
          }
          // ≥2 tasks
          await store.set(compositeKey, { ...nextState, status: "pending_task_select" });
          const fd: FormData = {
            teams, stage: "task_select",
            selectedTeamId: onlyTeam.team_id, selectedAgentId: soloAgent.agent_id,
            stream: reqCtx.stream, questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId, protocol: reqCtx.protocol,
          };
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }
        // ≥2 agents
        const useSplitStage = isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode";
        const nextStatus = useSplitStage ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = useSplitStage ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: onlyTeam.team_id,
        });
        const fd: FormData = {
          teams, stage: nextStage, selectedTeamId: onlyTeam.team_id,
          stream: reqCtx.stream, questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId, protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
      // ≥2 teams → show the team_select form
      await store.set(compositeKey, {
        status: "pending_team_select",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        cachedTeams: teams,
      });
      console.log(
        `[session-init:cb] session=${compositeKey} → pending_team_select (teams=${teams.length})`,
      );
      const fd: FormData = {
        teams, stage: "team",
        stream: reqCtx.stream, questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId, protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    // Show the asset_confirm dialog first
    await store.set(compositeKey, {
      status: "pending_asset_confirm",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
      cachedTeams: teams,
    });
    console.log(
      `[session-init:cb] session=${compositeKey} user=${userId} → pending_asset_confirm (teams=${teams.length})`,
    );
    const fd: FormData = {
      teams,
      stage: "asset_confirm",
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── CP3 · WorkBuddy text-mode preprocessing (strict gate) ───────────────
  //
  // Only entered when `capabilities?.askUserQuestion === false` (i.e. CP1 detected that workbuddy's
  // official tools have no AskUserQuestion). For all other clients, and for
  // capabilities === undefined, existing behavior is **unchanged by a single line**.
  //
  // The preprocessing does four things (see workbuddy/text-preprocess.ts):
  //   1. User types "prev / 上一页"   → paginate-prev short-circuit: change codexPageIndex[stage]
  //                                then return formData (the session/index.ts layer will
  //                                re-render the form of the same stage with buildWorkBuddyTextFormResponse
  //                                according to capabilities)
  //   2. User types "next / 下一页"   → paginate-next short-circuit (same as above, page +1, clamp)
  //   3. User types number N          → translate: replace the tail user message content with
  //                                the team_name / agent_name / task_name of item N on the current page
  //                                / "Yes, associate team assets" / "No, do not associate this time"
  //   4. Others (skip / name / short-id / gibberish) → passthrough, left to the CB extractor as fallback
  //
  // In the translate case **the original messages array is not mutated** — the last user message is deep-copied
  // and its content replaced, then reassigned to the local `messages`. The original body.messages is not polluted at all.
  //
  // In the paginate-* case **short-circuit return** — same posture as the codex/workbuddy MORE interception:
  // after changing state.codexPageIndex[stage], return `{ intercepted: true, formData }`,
  // and the workbuddy dispatch point in session/index.ts takes over and re-renders with text-form.
  if (
    reqCtx.capabilities?.askUserQuestion === false &&
    isTextModePendingSelectStage(state.status)
  ) {
    const stageForPreprocess = statusToTextModeStage(state.status);
    if (stageForPreprocess) {
      const { preprocessTextModeInput } = await import(
        "../workbuddy/text-preprocess.js"
      );
      const currentPage = readCurrentPageForStage(state, stageForPreprocess);
      const rawUserText = getLastUserMessageText(messages);
      const preResult = preprocessTextModeInput(rawUserText, {
        stage: stageForPreprocess,
        teams: state.cachedTeams ?? [],
        selectedTeamId: state.selectedTeamId,
        selectedAgentId: state.selectedAgentId,
        currentPage,
      });

      if (config.debugVerboseLogging) {
        console.log(
          `[session-init:text-mode] session=${compositeKey} stage=${stageForPreprocess} ` +
            `input=${JSON.stringify(rawUserText).slice(0, 100)} → action=${preResult.action} ` +
            `reason=${preResult.reason}`,
        );
      }

      // ── short-circuit branch: paginate-next / paginate-prev ─────
      if (
        (preResult.action === "paginate-next" ||
          preResult.action === "paginate-prev") &&
        preResult.newPageIndex !== undefined
      ) {
        const newState = writeCurrentPageForStage(
          state,
          stageForPreprocess,
          preResult.newPageIndex,
        );
        await store.set(compositeKey, newState);
        // Build formData (does not consume attemptCount / does not advance stage). The workbuddy dispatch in the session/index.ts
        // layer picks the text-form re-render according to capabilities.askUserQuestion=false,
        // emitting the content chunk SSE.
        const fd = buildFormDataForTextModeStage(newState, stageForPreprocess, reqCtx);
        return { intercepted: true, formData: fd };
      }

      // ── translate branch: replace the tail user message content ────
      if (preResult.action === "translate" && preResult.translated !== undefined) {
        messages = replaceLastUserMessageContentImmutable(messages, preResult.translated);
      }
      // passthrough: do nothing
    }
  }

  // ── Case 1.25: Awaiting asset_confirm ────────────────────────────────────
  if (state.status === "pending_asset_confirm") {
    const lastUserText = getLastUserMessageText(messages);
    const choice = extractAssetConfirm(lastUserText);
    if (config.debugVerboseLogging) {
      console.log(
        `[session-init:cb-debug] asset_confirm session=${compositeKey} choice=${choice} lastUserText=${JSON.stringify(lastUserText).slice(0, 300)}`,
      );
    }

    if (choice === false) {
      // bypass: the user explicitly chose "do not link" — keep the form conversation as is, do not delete.
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: state.attemptCount,
        userId: state.userId,
        cachedTeams: state.cachedTeams,
        selectedTeamId: undefined,
        agentDetail: null,
        taskDetail: null,
        sessionInfo: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} user chose no-asset → bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (choice === true) {
      const teams = state.cachedTeams ?? [];
      if (teams.length === 1) {
        const onlyTeam = teams[0];
        // Progressive auto-select: when team=1, if there is also only 1 agent, skip the agent form directly;
        // when there is only 1 task, auto-select further, to avoid the form hitting the solo-page assertion.
        // This chain is common to CB / WB / codex (the CB old path would originally ask in agent_task
        // all at once, but should likewise skip when there is only 1 agent).
        if (onlyTeam.agents.length === 1) {
          const soloAgent = onlyTeam.agents[0];
          const nextState: SessionInitState = {
            ...state,
            status: "pending_agent_select" as any,
            keyId: sessionKey,
            attemptCount: 0,
            cachedTeams: teams,
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
          };
          console.log(
            `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} only-agent=${soloAgent.agent_id} auto-select`,
          );
          // 0 tasks → bypass; 1 task → completeRegistration directly; ≥2 → show the task form.
          if (onlyTeam.tasks.length === 0) {
            await store.set(compositeKey, {
              ...nextState,
              status: "initialized",
              sessionInfo: null,
              agentDetail: null,
              taskDetail: null,
              bypassed: true,
            } as SessionInitState);
            console.log(
              `[session-init:cb] session=${compositeKey} team has 0 tasks → bypass`,
            );
            return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
          }
          if (onlyTeam.tasks.length === 1) {
            const soleTaskId = onlyTeam.tasks[0].task_id;
            console.log(
              `[session-init:cb] session=${compositeKey} auto-select single task=${soleTaskId} → completeRegistration`,
            );
            return await completeRegistration(
              { agent_id: soloAgent.agent_id, task_id: soleTaskId },
              nextState, teams, compositeKey, sessionKey, userId,
              config, store, messages, metadataClient, userKey, spaceId,
            );
          }
          // ≥2 tasks: switch to the task_select stage and show the task form.
          await store.set(compositeKey, {
            ...nextState,
            status: "pending_task_select",
          });
          console.log(
            `[session-init:cb] session=${compositeKey} → pending_task_select (tasks=${onlyTeam.tasks.length})`,
          );
          const fd: FormData = {
            teams,
            stage: "task_select",
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
            stream: reqCtx.stream,
            questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId,
            protocol: reqCtx.protocol,
          };
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }

        // ≥2 agents: CB old path pending_agent_task asks both at once; codex/WB/dsh/opencode split stages
        // and go to pending_agent_select. WB's form already asks separately in CC style, so let it take the
        // codex branch, avoiding the semantic ambiguity of landing on the legacy agent_task stage where the form asks only the agent
        // but is processed with the old semantics. opencode's native `question` tool can only pop
        // one question at a time, so it must also take the split stage.
        const useSplitStage = isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode";
        const nextStatus = useSplitStage ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = useSplitStage ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams: teams,
          selectedTeamId: onlyTeam.team_id,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} → ${nextStatus}`,
        );
        const fd: FormData = {
          teams,
          stage: nextStage,
          selectedTeamId: onlyTeam.team_id,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }

      await store.set(compositeKey, {
        status: "pending_team_select",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: teams,
      });
      console.log(
        `[session-init:cb] session=${compositeKey} → pending_team_select (teams=${teams.length})`,
      );
      const fd: FormData = {
        teams,
        stage: "team",
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} asset-confirm max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      // CP4 · text mode: this request returns a "team asset linking skipped" text notice,
      // not sent upstream; the next request goes through recovered.bypassed to auto-skip injection.
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "asset_confirm",
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 1.5: Awaiting team selection ─────────────────────────────────────
  if (state.status === "pending_team_select") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeamsForMore = state.cachedTeams ?? [];

    // ── WorkBuddy / opencode: team MORE paging interception ──
    // WB/OC reuse the CB state machine + the paginated form of WB/OC form.ts (MORE_LABEL="More →").
    // extractTeamFromOptionText does not recognize MORE and must be intercepted before it, otherwise clicking "More →"
    // is counted as "unrecognized" in attemptCount, and only after 3 maxRetries is bypass forced. On a hit, bump
    // codexPageIndex.teamPage and resend the team_select form (the page number is picked from codexPageIndex.teamPage by stage via the
    // re-render branch in session/index.ts, and passed to the pageIndex of the WB/OC form).
    // The dsh client has no options cap and teams are not paginated, so an accidental trigger is harmless.
    // Added 2026-09-03, aligned with the posture of the agent_select / task_select branches.
    if (agentSource === "workbuddy" || agentSource === "opencode" || agentSource === "dsh") {
      const curTeamPage = state.codexPageIndex?.teamPage ?? 0;
      const nextTeamPage = detectWorkbuddyMorePage(lastUserText, curTeamPage, cachedTeamsForMore.length);
      if (nextTeamPage !== null) {
        const nextPx = {
          teamPage: nextTeamPage,
          agentPage: state.codexPageIndex?.agentPage ?? 0,
          taskPage: state.codexPageIndex?.taskPage ?? 0,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB/OC team MORE page ${curTeamPage} → ${nextTeamPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeamsForMore,
          stage: "team",
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const teamId = extractTeamFromOptionText(lastUserText, cachedTeamsForMore);

    // The user actively bypasses at the team_select stage via SKIP_RE (跳过/不关联/skip)
    // (P1-4 fix). Aligned with the BYPASS_MARKER branches of pending_agent_select (init.ts:922) / pending_task_select
    // (init.ts:1037) — the old code missed this here, causing SKIP
    // words to be counted as "unrecognized" in attemptCount, with bypass forced only after 3 maxRetries.
    if (teamId === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: state.cachedTeams ?? [],
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} team_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (teamId && teamId !== BYPASS_MARKER) {
      const useSplitStage = isCodexClient
        || agentSource === "workbuddy"
        || agentSource === "dsh"
        || agentSource === "opencode";

      // ── Single-agent auto-select cascade (2026-09-21 fix, only for split-stage clients) ──
      //
      // Background: WB/dsh/opencode form builders all have a solo-page assertion (agents<2 → throw);
      // if after the user actively picks a team, team.agents has only 1, pushing pending_agent_select directly
      // to show the agent form → the form builder throws → caught by the handleSessionInit upper layer →
      // sessionInfo=undefined → the request passes through upstream → LLM hallucination (live evidence: session 25f9eca5).
      //
      // Logic is fully symmetric with lines 1135-1193 of this file (asset_confirm choice===true with a single team);
      // semantically consistent with CC advanceFromTeamPicked (session/claude-code/init.ts:220-285).
      //
      // The CB old one-shot path (useSplitStage=false) does not enter this section, because the CB old form does no assertion,
      // and when there is only 1 agent it normally shows an agent_task form listing only that agent.
      const selectedTeam = cachedTeamsForMore.find((t) => t.team_id === teamId);
      if (useSplitStage && selectedTeam && selectedTeam.agents.length <= 1) {
        // Branch A: agents.length === 0 → bypass (team has no agent, cannot establish binding)
        if (selectedTeam.agents.length === 0) {
          await store.set(compositeKey, {
            ...state,
            status: "initialized",
            selectedTeamId: teamId,
            sessionInfo: null,
            agentDetail: null,
            taskDetail: null,
            bypassed: true,
          } as SessionInitState);
          console.log(
            `[session-init:cb] session=${compositeKey} team=${teamId} has 0 agents → bypass`,
          );
          return {
            intercepted: false,
            messages: messages as Record<string, unknown>[],
            bypassed: true,
            justRegistered: true,
            resetFlow: state?.resetFlow ?? false,
          };
        }

        // Branch B: agents.length === 1 → auto-select agent, cascade to judge task
        const soloAgent = selectedTeam.agents[0];
        const nextState: SessionInitState = {
          ...state,
          keyId: sessionKey,
          attemptCount: 0,
          selectedTeamId: teamId,
          selectedAgentId: soloAgent.agent_id,
        };
        console.log(
          `[session-init:cb] session=${compositeKey} team=${teamId} auto-select single agent=${soloAgent.agent_id}`,
        );

        // B.1: 0 tasks → bypass (team+agent+task missing any one means no injection)
        if (selectedTeam.tasks.length === 0) {
          await store.set(compositeKey, {
            ...nextState,
            status: "initialized",
            sessionInfo: null,
            agentDetail: null,
            taskDetail: null,
            bypassed: true,
          } as SessionInitState);
          console.log(
            `[session-init:cb] session=${compositeKey} agent=${soloAgent.agent_id} has 0 tasks → bypass`,
          );
          return {
            intercepted: false,
            messages: messages as Record<string, unknown>[],
            bypassed: true,
            justRegistered: true,
            resetFlow: state?.resetFlow ?? false,
          };
        }
        // B.2: 1 task → completeRegistration directly (including the defaultTaskId virtual entry scenario)
        if (selectedTeam.tasks.length === 1) {
          const soleTaskId = selectedTeam.tasks[0].task_id;
          console.log(
            `[session-init:cb] session=${compositeKey} auto-select single task=${soleTaskId} → completeRegistration`,
          );
          return await completeRegistration(
            { agent_id: soloAgent.agent_id, task_id: soleTaskId },
            nextState,
            cachedTeamsForMore,
            compositeKey,
            sessionKey,
            userId,
            config,
            store,
            messages,
            metadataClient,
            userKey,
            spaceId,
          );
        }
        // B.3: ≥2 tasks → advance to pending_task_select and show the task form
        await store.set(compositeKey, {
          ...nextState,
          status: "pending_task_select",
        });
        console.log(
          `[session-init:cb] session=${compositeKey} → pending_task_select (tasks=${selectedTeam.tasks.length})`,
        );
        const fd: FormData = {
          teams: cachedTeamsForMore,
          stage: "task_select",
          selectedTeamId: teamId,
          selectedAgentId: soloAgent.agent_id,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }

      // ── Original logic kept: agents ≥ 2 (or the CB old one-shot path) → advance to the next stage and show the form ──
      // codex/WB/dsh/opencode split stages: agent_select first → task_select; the CB old path keeps agent_task asking both at once.
      const nextStatus = useSplitStage ? "pending_agent_select" : "pending_agent_task";
      const nextStage: FormData["stage"] = useSplitStage ? "agent_select" : "agent_task";
      const next: SessionInitState = {
        ...state,
        status: nextStatus,
        selectedTeamId: teamId,
        attemptCount: 0,
      };
      await store.set(compositeKey, next);
      console.log(`[session-init:cb] session=${compositeKey} team=${teamId} → ${nextStatus}`);
      const fd: FormData = {
        teams: state.cachedTeams ?? [],
        stage: nextStage,
        selectedTeamId: teamId,
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} team-select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "team",
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2a (codex-only): Awaiting agent selection ────────────────────────
  //
  // codex client only branch. After the user selects the agent in the agent_select stage → advance to task_select
  // stage (if the team has only 1 task, auto-select and complete directly).
  // The CB client never enters this branch.
  if (state.status === "pending_agent_select") {
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);
    if (!team) {
      console.warn(
        `[session-init:cb] session=${compositeKey} pending_agent_select but team=${selectedTeamId} not in cache → bypass`,
      );
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const lastUserText = getLastUserMessageText(messages);

    // ── WorkBuddy-only: MORE paging interception ──
    // WorkBuddy reuses the CB state machine + the paginated form of workbuddy/form.ts (MORE_LABEL="More →").
    // extractAgentOnly does not recognize MORE and must be intercepted before it, otherwise clicking "More →" is treated as unrecognized →
    // page 1 resent endlessly. On a hit, bump agentPage and resend the agent_select form (the page number is picked from codexPageIndex.agentPage by stage via the
    // workbuddy/opencode re-render branch in session/index.ts).
    // opencode and workbuddy share the `More →` MORE_LABEL and the paging semantics, so both are intercepted.
    if (agentSource === "workbuddy" || agentSource === "opencode") {
      const curAgentPage = state.codexPageIndex?.agentPage ?? 0;
      const nextAgentPage = detectWorkbuddyMorePage(lastUserText, curAgentPage, team.agents.length);
      if (nextAgentPage !== null) {
        const nextPx = {
          teamPage: state.codexPageIndex?.teamPage ?? 0,
          agentPage: nextAgentPage,
          taskPage: state.codexPageIndex?.taskPage ?? 0,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB agent MORE page ${curAgentPage} → ${nextAgentPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeams,
          stage: "agent_select",
          selectedTeamId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const picked = extractAgentOnly(lastUserText, cachedTeams, selectedTeamId);

    if (picked === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams,
        selectedTeamId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} agent_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (picked) {
      const resolvedAgentId = resolveAgent(picked, cachedTeams, selectedTeamId);
      // 0 tasks → bypass; 1 task → auto-select and complete directly.
      if (team.tasks.length === 0) {
        console.log(
          `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} team has 0 tasks → bypass`,
        );
        await store.set(compositeKey, {
          status: "initialized",
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams,
          selectedTeamId,
          selectedAgentId: resolvedAgentId,
          sessionInfo: null,
          agentDetail: null,
          taskDetail: null,
          bypassed: true,
        } as SessionInitState);
        return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
      }
      if (team.tasks.length === 1) {
        const soleTaskId = team.tasks[0].task_id;
        console.log(
          `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} auto-select single task=${soleTaskId}`,
        );
        return await completeRegistration(
          { agent_id: resolvedAgentId, task_id: soleTaskId },
          state, cachedTeams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      }
      // ≥2 tasks → enter the task_select stage and show the next form.
      const nextState: SessionInitState = {
        ...state,
        status: "pending_task_select",
        selectedAgentId: resolvedAgentId,
        attemptCount: 0,
        // When entering a new stage, clear the task page number and start paging from page 1. agentPage is already used and may be kept or cleared;
        // keeping it has no side effect, clearing is cleaner — uniformly clear to 0.
        codexPageIndex: { teamPage: state.codexPageIndex?.teamPage ?? 0, agentPage: 0, taskPage: 0 },
      };
      await store.set(compositeKey, nextState);
      console.log(
        `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} → pending_task_select (tasks=${team.tasks.length})`,
      );
      const fd: FormData = {
        teams: cachedTeams,
        stage: "task_select",
        selectedTeamId,
        selectedAgentId: resolvedAgentId,
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    // Extraction failed → retry / bypass。
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} agent_select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: cachedTeams,
      stage: "agent_select",
      selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2b (codex-only): Awaiting task selection ────────────────────────
  if (state.status === "pending_task_select") {
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const selectedAgentId = state.selectedAgentId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);
    if (!team || !selectedAgentId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} pending_task_select missing team/agent (team=${selectedTeamId} agent=${selectedAgentId}) → bypass`,
      );
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const lastUserText = getLastUserMessageText(messages);

    // ── WorkBuddy-only: MORE paging interception ──
    // Same as pending_agent_select: extractTaskOnly does not recognize "More →" and must intercept first. On a hit,
    // bump taskPage and resend the task_select form (the page number is picked from codexPageIndex.taskPage by stage via the workbuddy/opencode
    // re-render branch in session/index.ts).
    if (agentSource === "workbuddy" || agentSource === "opencode") {
      const curTaskPage = state.codexPageIndex?.taskPage ?? 0;
      const nextTaskPage = detectWorkbuddyMorePage(lastUserText, curTaskPage, team.tasks.length);
      if (nextTaskPage !== null) {
        const nextPx = {
          teamPage: state.codexPageIndex?.teamPage ?? 0,
          agentPage: state.codexPageIndex?.agentPage ?? 0,
          taskPage: nextTaskPage,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB task MORE page ${curTaskPage} → ${nextTaskPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeams,
          stage: "task_select",
          selectedTeamId,
          selectedAgentId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const picked = extractTaskOnly(lastUserText, cachedTeams, selectedTeamId);

    if (picked === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams,
        selectedTeamId,
        selectedAgentId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} task_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (typeof picked === "string") {
      // Hit task_id (including the defaultTaskId virtual entry) → complete.
      return await completeRegistration(
        { agent_id: selectedAgentId, task_id: picked },
        state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // Unrecognized → retry / bypass.
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} task_select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: cachedTeams,
      stage: "task_select",
      selectedTeamId,
      selectedAgentId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2: Awaiting agent + task selection ───────────────────────────────
  if (state.status === "pending_agent_task" || state.status === "pending_form") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;

    // LLM-based extraction fallback was removed — engineered paths only.
    // If neither the option-text match nor the structured parser recognises
    // the reply, the caller falls through to the retry / bypass branch.
    let extracted = extractFromOptionText(lastUserText, cachedTeams, selectedTeamId)
      ?? extractStructured(lastUserText);

    if (extracted && extracted.agent_id === BYPASS_MARKER) {
      console.warn(`[session-init:cb] session=${compositeKey} unexpected bypass in agent_task, treating as extraction failure`);
      extracted = null;
    }

    if (extracted) {
      const resolvedAgentId = resolveAgent(extracted.agent_id, cachedTeams, selectedTeamId);
      const resolvedTaskId = resolveTask(
        extracted.task_id,
        cachedTeams,
        resolvedAgentId,
        selectedTeamId,
      );
      const resolved: SessionInitData = {
        agent_id: resolvedAgentId,
        task_id: resolvedTaskId,
      };

      return await completeRegistration(
        resolved, state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // Extraction failed → retry / reset
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "agent_task",
      selectedTeamId: state.selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 3: Initialized ───────────────────────────────────────────────────
  const bypassed = (state as any).bypassed === true;
  const agent = bypassed ? null : (state.agentDetail ?? null);
  const task = bypassed ? null : (state.taskDetail ?? null);
  const out = applyArtifactsAndContext(messages, agent, task, sessionKey, config);
  return { intercepted: false, messages: out, sessionInfo: state.sessionInfo, bypassed };
}

// ── CP3 · Text-Mode Preprocess Helpers ─────────────────────────────────────
//
// The following 4 helper functions only serve the text-mode preprocessing hook (see the CP3 section above). They are **not
// called by any existing code path** and are purely additive. Placed at the end of the file to keep the diff of existing functions minimal.

/**
 * Determine whether the current status is a "pending_* select stage that text-mode preprocessing needs to handle".
 *
 * Only handles 4: pending_asset_confirm / pending_team_select /
 * pending_agent_select / pending_task_select。
 *
 * Does not handle pending_agent_task (CB old one-shot path, which workbuddy never reaches) nor intermediate states
 * like pending_agent_select_ambiguous (which the existing code does not have).
 */
function isTextModePendingSelectStage(status: string | undefined): boolean {
  return (
    status === "pending_asset_confirm" ||
    status === "pending_team_select" ||
    status === "pending_agent_select" ||
    status === "pending_task_select"
  );
}

/**
 * status → FormStage mapping (aligned with workbuddy/form.ts::FormStage).
 * Only maps the 4 pending states; everything else returns null.
 */
function statusToTextModeStage(
  status: string | undefined,
): "asset_confirm" | "team" | "agent_select" | "task_select" | null {
  switch (status) {
    case "pending_asset_confirm":
      return "asset_confirm";
    case "pending_team_select":
      return "team";
    case "pending_agent_select":
      return "agent_select";
    case "pending_task_select":
      return "task_select";
    default:
      return null;
  }
}

/**
 * Read the page number for the current stage (using teamPage/agentPage/
 * taskPage of state.codexPageIndex — the same storage fields reused by the workbuddy card mode, keeping behavior consistent;
 * asset_confirm has only 2 fixed options with no pagination, always 0).
 */
function readCurrentPageForStage(
  state: SessionInitState,
  stage: "asset_confirm" | "team" | "agent_select" | "task_select",
): number {
  const pi = state.codexPageIndex;
  switch (stage) {
    case "team":
      return pi?.teamPage ?? 0;
    case "agent_select":
      return pi?.agentPage ?? 0;
    case "task_select":
      return pi?.taskPage ?? 0;
    case "asset_confirm":
      return 0;
    default:
      return 0;
  }
}

/**
 * Return a **new** SessionInitState (does not mutate the argument), updating the page number of the corresponding stage
 * to newPage. asset_confirm has no pagination → returned as is.
 */
function writeCurrentPageForStage(
  state: SessionInitState,
  stage: "asset_confirm" | "team" | "agent_select" | "task_select",
  newPage: number,
): SessionInitState {
  if (stage === "asset_confirm") return state;
  const oldPi = state.codexPageIndex ?? {};
  const nextPi = { ...oldPi };
  if (stage === "team") nextPi.teamPage = newPage;
  else if (stage === "agent_select") nextPi.agentPage = newPage;
  else if (stage === "task_select") nextPi.taskPage = newPage;
  return { ...state, codexPageIndex: nextPi };
}

/**
 * Build FormData for the paginate-* short-circuit re-render (the workbuddy dispatch in the session/index.ts layer
 * stuffs it into buildWorkBuddyTextFormResponse).
 *
 * Key: **do not advance stage, do not consume attemptCount** — stage stays unchanged, retry=false.
 */
function buildFormDataForTextModeStage(
  state: SessionInitState,
  stage: "asset_confirm" | "team" | "agent_select" | "task_select",
  reqCtx: SessionRequestContext,
): FormData {
  return {
    teams: state.cachedTeams ?? [],
    stage,
    selectedTeamId: state.selectedTeamId,
    selectedAgentId: state.selectedAgentId,
    // codexPageIndex has already been updated by writeCurrentPageForStage, passed through to downstream rendering
    teamPage: state.codexPageIndex?.teamPage,
    agentPage: state.codexPageIndex?.agentPage,
    taskPage: state.codexPageIndex?.taskPage,
    retry: false,
    stream: reqCtx.stream,
    questionsAsArray: reqCtx.questionsAsArray,
    modelId: reqCtx.modelId,
    protocol: reqCtx.protocol,
  };
}

/**
 * **Does not mutate the original array**; returns a new messages array: replaces the content of the last role="user"
 * message with newContent.
 *
 * If no user message is found → returned as is (passthrough; should not happen, but a fallback).
 *
 * Note: here we **only handle the case where content is a string** — in text mode the WorkBuddy
 * client always sends plain-text user messages, never multipart. In extreme cases (content is an
 * array) it is also kept as is, letting the CB extractor handle it itself.
 */
function replaceLastUserMessageContentImmutable(
  messages: MessageArr,
  newContent: string,
): MessageArr {
  // Find the last user message from the end
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      // Only overwrite the string-content case; other content types are kept as is
      if (typeof m.content !== "string") return messages;
      const copy = [...messages];
      copy[i] = { ...m, content: newContent };
      return copy;
    }
  }
  return messages;
}

/**
 * CP4 · text-mode max-retry bypass fallback.
 *
 * Returns an intercepted result with a response only when `reqCtx.capabilities?.askUserQuestion === false`
 * — sends a "team asset linking skipped" text notice to the client,
 * and this request is **not sent upstream**. Returning undefined means taking the original bypass path (transparent
 * transfer to the upstream LLM), with existing CB / codex / dsh / opencode behavior unchanged.
 *
 * The state in the store is set by the caller before the call to `{status: "initialized",
 * bypassed: true}`; on the next request, recovered takes the handler.ts
 * `recovered.bypassed` branch to auto-skip injection — fully aligned with existing bypass semantics.
 */
function tryBuildTextModeBypassResult(
  reqCtx: SessionRequestContext,
): SessionInitResult | undefined {
  if (reqCtx.capabilities?.askUserQuestion !== false) return undefined;
  const response = buildBypassNoticeResponse(reqCtx.modelId, reqCtx.stream === true);
  return {
    intercepted: true,
    response,
    bypassed: true,
    justRegistered: true,
  };
}