/**
 * Session initialization types.
 */

/**
 * With `config.defaultTaskId` fallback association, the label of the virtual entry that fetchTeamsAndAgents injects at the head of each team's
 * tasks list.
 *
 * By injecting at the source rather than adding branches on the form / extractor side, pagination totals, auto-select
 * cascading and extractor matching all go through the existing tasks.length path, avoiding "pagination truth scattered" bugs
 * (see the defaultTaskId notes in docs & the 2026-07-29 issue).
 */
export const DEFAULT_TASK_LABEL = "Skip for now";

/**
 * Session-init state machine:
 *   uninitialized           → first entry, control plane fetches teams[]
 *   pending_asset_confirm   → round-0 form sent (associate team assets?), waiting for the user's answer
 *   pending_team_select     → "Yes" chosen, round-1 form sent (team only), waiting for the user's answer
 *   pending_agent_task      → team chosen, round-2 form sent (agent + task), waiting for the user's answer
 *   initialized             → full triple identified, registration complete
 *
 * When teams.length === 1, pending_team_select is skipped and it goes straight to pending_agent_task.
 * When the user picks "No" at the pending_asset_confirm stage, it bypasses directly.
 */
export type SessionInitStatus =
  | "uninitialized"
  | "pending_asset_confirm"
  | "pending_team_select"
  | "pending_agent_task"     // legacy
  | "pending_agent_select"  // CC: selecting agent (with pagination)
  | "pending_task_select"   // CC: selecting task (with pagination)
  | "initialized"
  // legacy (phase-1 single form), kept for compatibility with old tests / old store data
  | "pending_form";

export interface SessionInitState {
  status: SessionInitStatus;
  keyId: string;
  startedAt: number;
  attemptCount: number;
  sessionInfo?: SessionInfo | null;
  /** User ID from auth/verify (not from header). */
  userId?: string;
  /** Nested structure returned by the kernel's /teams, used to render the form and parse the user's reply. */
  cachedTeams?: TeamOption[];
  /**
   * The team_id the user already chose in round 1 (only meaningful in the pending_agent_task stage).
   * The round-2 form renders only the agents/tasks under this team; the extractor also matches only within this team.
   */
  selectedTeamId?: string;
  /**
   * Current agent page index (0-based) in Claude Code paging mode.
   *
   * Background: Claude Code's AskUserQuestion allows 2–4 options per question, so when a team
   * has more than 3 agents they cannot all be laid out at once. We reuse the existing "multi-round interception" mechanism, rendering
   * 3 agents + 1 "More →" or "Do not associate this time" slot each time; if the user clicks "More", pageIndex++
   * and the next page of the form is sent. See docs/reports/2026-06-19-cc-form-mode-experiment.md §4.4.
   *
   * - Used only by Claude Code (agentSource="claude-code"); CodeBuddy goes through ask_followup_question,
   *   which has no 4-option limit, so no paging is needed.
   * - Only valid while status="pending_agent_task".
   * - Defaults to 0 (first page); each time the user picks "More", the handler adds 1 to it and resends the form.
   */
  agentPageIndex?: number;
  /**
   * Current team page index (0-based) in Claude Code paging mode.
   *
   * Fully symmetric with `agentPageIndex` semantics; paging only kicks in when the team count > 4.
   * Added 2026-09-03 — fixes a pre-existing bug where the team stage's hard `slice(0, 4)` truncation silently dropped later teams
   * when there were ≥5 teams, with no "More →" entry.
   * Used only by CC; the CB state machine (serving WB/OC/dsh) goes through `codexPageIndex.teamPage`.
   */
  teamPageIndex?: number;
  /** CC: the agent_id the user chose in the agent_select stage (used in the pending_task_select stage). */
  selectedAgentId?: string;
  /** Resolved agent detail (cached after selection), used to inject context every request. */
  agentDetail?: AgentDetail | null;
  /** Resolved task detail (cached after selection), used to inject context every request. */
  taskDetail?: TaskDetail | null;
  /**
   * The user explicitly chose "Skip" (do not associate this time). Status is set to initialized to prevent repeated popups,
   * but agentDetail/taskDetail are null, so later requests only strip and do not inject.
   */
  bypassed?: boolean;
  /**
   * Page indexes specific to the codex client (0-based), written only when agentSource="codex".
   *
   * Background: codex's request_user_input allows at most 3 options per question (the client
   * automatically appends "Other" taking 1 slot; the proxy cannot add it itself). When candidates > 3, paging follows the 3-slot cap:
   * the first N-1 pages each have 2 real + "More...", the last page has 2~3 real.
   *
   * Independent of the CC-side `agentPageIndex` — CC has its own 4-slot paging semantics (agent /
   * task share one field, distinguished by stage), while codex needs separate page indexes for the
   * team / agent / task segments; reusing one would cross-contaminate them.
   *
   * ── Who writes it ──
   * The CB state machine bumps the corresponding field when agentSource==="codex" + reqCtx.codexAnswerInput hits MORE
   * (team convention 2026-08-08 codex session-init refactor: MORE interception moved from
   * codexHandler into the CB state machine). Never written in CC / plain CB scenarios.
   */
  codexPageIndex?: {
    teamPage?: number;
    agentPage?: number;
    taskPage?: number;
  };
  /**
   * Transient (not persisted): source hint set by SessionStore.getOrRecover
   * indicating which cache layer produced this state on the current turn.
   *
   * - `l1`: hot in-memory hit — hook-cache is almost certainly also warm in
   *   this process. Handler should NOT trigger prewarm.
   * - `l2a`: SessionRepo hit — same-process cache exists too (state promoted
   *   back to L1 in probeL2a); handler should NOT trigger prewarm.
   * - `l2b`: rebuilt from binding after L1+L2a miss — hook-cache may be
   *   cold (fresh pod / long dormant session). Handler SHOULD prewarm.
   * - `history-scan`: last-resort bypass reconstruction — hook-cache is
   *   also cold. Handler SHOULD prewarm.
   *
   * Consumed by handler.ts / anthropicHandler.ts to decide `justRegistered`
   * without triggering redundant network fetches on every warm turn.
   *
   * Not written by set()/upsert()/repo callers — only meaningful on the
   * getOrRecover return value; do not persist to L2a/L2b.
   */
  __recoverySource?: "l1" | "l2a" | "l2b" | "history-scan";

  /** Written when mem:session-reset fires, marking this init as a reset flow. */
  resetFlow?: boolean;
  /** Timestamp of the mem:session-reset trigger, used for cross-node consistency checks. */
  resetEpoch?: number;
}

/**
 * Nested structure from the control plane `/api/v1/proxy/resources`:
 *   teams[] → agents[]  +  tasks[]
 *
 * agents and tasks are the full lists under this team, shown side by side.
 * During session init the user freely picks agent + task; the task_agents association
 * is managed by the page after init completes and does not affect the option lists during init.
 */
export interface TaskInTeam {
  task_id: string;
  task_name: string;
  /**
   * Marks this entry as a virtual task injected by the `config.defaultTaskId` fallback (source: proxy)
   * rather than a task that really exists in the kernel. When the form side sees this field it skips the `(id-suffix)` suffix,
   * showing a cleaner label — there is only one virtual task anyway, so no name ambiguity.
   */
  isDefault?: boolean;
  /**
   * The associated agent_id (a field in the core API response, not consumed by the proxy itself, but extractor
   * tests give the task mock this field to express "which agent the task hangs under").
   */
  agent_id?: string;
}

export interface AgentInTeam {
  agent_id: string;
  agent_name: string;
  description?: string;
}

export interface TeamOption {
  team_id: string;
  team_name: string;
  agents: AgentInTeam[];
  tasks: TaskInTeam[];
}

/** @deprecated Old flat structure, kept for compatibility with old tests; new code uses TeamOption. */
export interface AgentOption {
  id: string;
  name: string;
  description?: string;
  team_id?: string;
}

/** @deprecated Old flat structure, kept for compatibility with old tests; new code uses TaskInTeam. */
export interface TaskOption {
  id: string;
  name: string;
  description?: string;
}

/** Full Agent detail (fetched after selection) — content injected into system prompt. */
export interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  /** The Agent's system-level prompt / persona, appended to system message. */
  prompt?: string;
}

/** Full Task detail (fetched after selection) — content injected into system prompt. */
export interface TaskDetail {
  id: string;
  name: string;
  description?: string;
  /** Optional structured goal/acceptance criteria text. */
  goal?: string;
}

/**
 * User-facing init data — agent + task selection (from dropdown).
 * team_id and user_id are sourced from the selected agent and the request
 * header respectively; not part of the user-facing form.
 */
export interface SessionInitData {
  agent_id: string;
  /** User-selected task (index into cachedTasks, or raw task_id string). */
  task_id?: string;
}

/** Full init data sent to register session. */
export interface SessionRegistrationData {
  team_id: string;
  agent_id: string;
  user_id: string;
  task_id?: string;
  session_id: string;
}

/**
 * Subset of the `POST /agent-sessions` response we consume.
 * The real backend returns more (created_at, updated_at, …) — we keep the
 * shape loose with `permissions` etc. optional so future fields don't break us.
 */
export interface SessionInfo {
  session_id: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  task_id?: string;
  /** User's API key — stored so injectors can create MetadataClient for per-user kernel calls. */
  user_key?: string;
  /**
   * Kernel instance / space ID (e.g. `mem-example001`) extracted from the request
   * URL path `/proxy/<spaceId>/...`. Stored so injectors can build a
   * MetadataClient with the correct `x-tdai-service-id` header (kernel routes
   * tenants by this header — a static config value would return `invalid_user_key`).
   */
  space_id?: string;
  created_at?: string;
  expires_at?: string;
  identity_verified?: boolean;
  permissions?: {
    user_in_team?: boolean;
    user_in_task?: boolean;
    agent_assigned_to_task?: boolean;
    repo_in_team?: boolean;
  };
  fixed_asset_summary?: {
    count: number;
    total_est_tokens: number;
  };
}
