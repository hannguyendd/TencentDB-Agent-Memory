/**
 * Fake form response builder.
 * Returns an OpenAI-compatible response (streaming SSE or non-streaming JSON)
 * that CodeBuddy renders as interactive selection buttons via `ask_followup_question` tool_call.
 *
 * V3: Uses tool_calls to invoke ask_followup_question — CodeBuddy renders
 * clickable option buttons in the chat UI. User just clicks to select.
 *
 * CRITICAL: Must match the original request's stream mode.
 */

import type { TeamOption, AgentOption, TaskOption } from "./types.js";

export type { TaskOption, AgentOption, TeamOption };

// ── Markers used to recognise fake session-init artifacts in later requests ────

/**
 * tool_call id prefixes used when emitting the fake form (OpenAI / Anthropic).
 * Cleaner uses these to locate the assistant message that issued the form,
 * regardless of where it ends up in the conversation history.
 */
export const SESSION_INIT_TOOLCALL_PREFIXES = [
  "call_session_init_",
  "toolu_session_init_",
] as const;

/**
 * Form titles: split into two rounds. Round 1 selects the team, round 2 selects agent+task.
 * The extractor does not rely on titles for detection; they are only used for retry hints + UI text.
 */
export const SESSION_INIT_TEAM_FORM_TITLE = "Session Init — Select Team";
export const SESSION_INIT_AGENT_TASK_FORM_TITLE = "Session Init — Select Agent and Task";
/** Option text for skipping the association this time; once the extractor recognizes it, the whole session-init is bypassed. */
export const SKIP_LABEL = "Do not associate this time (skip injection, pass through)";

/**
 * Pre-association dialog options for assets.
 * User picks "Yes" → continue with the team/agent/task flow
 * User picks "No" → bypass directly
 */
export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Init — Associate Team Assets?";
/**
 * Claude Code paging mode only: when a team has more than 3 agents, the last slot
 * is used as the "More →" button (on non-final pages). After the user clicks it, the handler resends the form with agentPageIndex+1.
 * The extractor returns the MORE_MARKER signal when it recognizes this label.
 */
export const MORE_LABEL = "More →";
/**
 * Filler shown when the real option count on this page is 1 but Claude Code's
 * `AskUserQuestion` schema requires ≥2 options. Mirrors `claude-code/form.ts`
 * — chosen deliberately to miss every team/agent/task lookup so the extractor
 * treats it as `unrecognized` and `init.ts` bypasses session-init. MUST NOT
 * contain "skip / do not associate" (would fire SKIP_RE on unrelated text).
 */
export const NO_MORE_LABEL = "(No more options)";
export const NO_MORE_DESC = "Selecting this skips injection this time and passes through";
/** Overall title kept for legacy tests (used for detection in cleaner.ts). */
export const SESSION_INIT_FORM_TITLE = "Session Init — Select Team / Agent / Task";

/**
 * Separator for option labels. Round-2 agent / task options no longer carry a team prefix
 * (the team was already chosen in round 1); only tasks use "Agent / Task" to show which agent they belong to.
 */
export const PATH_SEP = " / ";

/** Title used when extraction failed and the form is re-issued. */
export const SESSION_INIT_RETRY_FORM_TITLE = "Could not recognize your selection, please select again";

/** Tool name used by the fake form (CodeBuddy / OpenAI protocol). */
export const SESSION_INIT_TOOL_NAME = "ask_followup_question";

/**
 * Tool name used by the fake form for Claude Code (Anthropic native protocol).
 * Claude Code has its own built-in `AskUserQuestion` tool with a different
 * input schema: structured `{ label, description }` options instead of flat
 * string lists, and multi-question support.
 */
export const CC_SESSION_INIT_TOOL_NAME = "AskUserQuestion";

/**
 * tool_use id prefix for Claude Code session-init forms.
 * We use the same prefix as Anthropic so cleaner can strip them.
 */
export const CC_SESSION_INIT_TOOLCALL_PREFIX = "toolu_cc_session_init_";

/** Returns true if the given string contains any fake form title marker. */
export function containsSessionInitFormTitle(s: string): boolean {
  return (
    s.includes(SESSION_INIT_FORM_TITLE) ||
    s.includes(SESSION_INIT_TEAM_FORM_TITLE) ||
    s.includes(SESSION_INIT_AGENT_TASK_FORM_TITLE) ||
    s.includes(SESSION_INIT_RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/**
 * Props shared by both rounds of the form:
 *   - stage="team": render only the team list
 *   - stage="agent_task": render the agents + tasks under the selected team
 * Why two rounds: with a single form, the user might pick an agent from team_A in the agent list
 * and a task from team_B in the task list — a cross-team mismatch is a valid string combination
 * but semantically inconsistent. Splitting into two rounds fixes the team dimension up front and rules out cross-team mismatches at the protocol level.
 */
export type FormStage = "asset_confirm" | "team" | "agent_task";

export interface FormData {
  /** Full nested structure returned by the control-plane /resources. */
  teams: TeamOption[];
  /** Which stage of the form to render in this round. */
  stage: FormStage;
  /** Required when stage="agent_task"; limits which team's agents/tasks are rendered. */
  selectedTeamId?: string;
  /**
   * Claude Code paging: when stage="agent_task", slice agents by this page index.
   * Each page shows 3 agents + 1 "More →" or SKIP_LABEL.
   * The CodeBuddy path ignores this field (ask_followup_question has no cap on option count).
   */
  pageIndex?: number;
  /** Whether this is a retry (extraction failed in the previous round). */
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  /**
   * Wire protocol of the original request. CodeBuddy talks Anthropic
   * (`/v1/messages`) for `vendor: "claude"` models and OpenAI
   * (`/v1/chat/completions`) for `vendor: "openai"` models. The fake form
   * response MUST match, otherwise the client cannot parse it and the
   * selection box never renders. Defaults to "openai".
   */
  protocol?: "openai" | "anthropic";
}

/**
 * Build the ask_followup_question arguments for the current stage.
 *   - Round 1 (team): a single question listing all teams.
 *   - Round 2 (agent_task): two questions, listing only the agents / tasks under the selected team.
 *
 * The extractor identifies them by question_item id ("team" / "agent" / "task");
 * the title is only UI text.
 */
function buildFollowupQuestionArgs(data: FormData): { title: string; questions: string } {
  const { teams, stage, selectedTeamId, retry } = data;

  const title = retry
    ? "⚠️ " + SESSION_INIT_RETRY_FORM_TITLE
    : stage === "asset_confirm"
      ? ASSET_CONFIRM_FORM_TITLE
      : stage === "team"
        ? SESSION_INIT_TEAM_FORM_TITLE
        : SESSION_INIT_AGENT_TASK_FORM_TITLE;

  const questions: Array<{
    id: string;
    question: string;
    options: string[];
    multiSelect: boolean;
  }> = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: "asset_confirm",
      question: "Associate team assets with this conversation?",
      options: [ASSET_CONFIRM_YES, ASSET_CONFIRM_NO],
      multiSelect: false,
    });
    return { title, questions: JSON.stringify(questions) };
  }

  if (stage === "team") {
    questions.push({
      id: "team",
      question: "Please select the Team for this session:",
      options: [
        ...teams.map((t) => `${t.team_name} (${t.team_id.slice(-8)})`),
      ],
      multiSelect: false,
    });
    return { title, questions: JSON.stringify(questions) };
  }

  // stage === "agent_task"
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { title, questions: JSON.stringify(questions) };

  if (team.agents.length > 0) {
    // agent option label format: "agent_name (last 8 chars of id)" so same-named agents can be told apart
    const agentLabelOptions = [
      ...team.agents.map((a) => `${a.agent_name} (${a.agent_id.slice(-8)})`),
    ];
    questions.push({
      id: "agent",
      question: `Please select the Agent to use under "${team.team_name}":`,
      options: agentLabelOptions,
      multiSelect: false,
    });
  }

  // Full list of all tasks under this team (cannot be skipped)
  // label format: "task_name (last 8 chars of id)" so same-named tasks can be told apart
  const taskOptions: string[] = [];
  for (const tk of team.tasks) {
    const idSuffix = tk.task_id.slice(-8);
    taskOptions.push(`${tk.task_name} (${idSuffix})`);
  }
  if (taskOptions.length > 0) {
    questions.push({
      id: "task",
      question: `Please select the task to associate under "${team.team_name}":`,
      options: taskOptions,
      multiSelect: false,
    });
  }

  return { title, questions: JSON.stringify(questions) };
}

export interface FakeFormOptions {
  formData?: FormData;
}

/** Build a fake response that uses a tool call to invoke ask_followup_question.
 *  The response shape matches the request's wire protocol (OpenAI vs Anthropic),
 *  otherwise the client cannot parse it and the selection box never renders. */
export function buildFakeFormResponse(options: FakeFormOptions = {}): Response {
  const fd = options.formData ?? { teams: [], stage: "team" as const };
  const model = fd.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);

  const args = buildFollowupQuestionArgs(fd);

  if (fd.protocol === "anthropic") {
    const msgId = "msg_session_init_" + Date.now();
    const toolUseId = "toolu_session_init_" + Date.now();
    if (fd.stream) {
      return buildAnthropicStreamingToolUseResponse(msgId, model, toolUseId, args);
    }
    return buildAnthropicNonStreamingToolUseResponse(msgId, model, toolUseId, args);
  }

  const id = "session-init-" + Date.now();
  const toolCallId = "call_session_init_" + Date.now();
  if (fd.stream) {
    return buildStreamingToolCallResponse(id, created, model, toolCallId, args);
  }
  return buildNonStreamingToolCallResponse(id, created, model, toolCallId, args);
}

// ── Claude Code: AskUserQuestion form ──────────────────────────────────────────

/**
 * Claude Code's `AskUserQuestion` input schema.
 * Each question has structured `{ label, description }` options and a header.
 */
interface CCAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/**
 * Claude Code's AskUserQuestion constraints (client-side validation):
 *   - options: 2–4 items per question
 *   - questions: 1–4 per call
 *   - header: ≤12 characters
 *   - label: 1–5 words recommended
 *   - Client auto-appends "Other" option for free-text input
 *
 * We MUST respect the 2–4 options limit. When there are more than 3 business
 * options, we show the first 3 + a "skip" option = 4 total. Users can pick
 * "Other" (auto-appended by Claude Code) to type a name not shown.
 */
const CC_MAX_OPTIONS = 4; // hard limit from Claude Code client
const CC_MAX_BUSINESS_OPTIONS = CC_MAX_OPTIONS - 1; // reserve 1 slot for skip/fallback

/**
 * Build the AskUserQuestion input for Claude Code.
 *
 * Claude Code's tool input format:
 *   { questions: [{ question, header, options: [{ label, description }], multiSelect }] }
 *
 * Key differences from CodeBuddy's ask_followup_question:
 *   - Options are structured objects (label + description) not flat strings
 *   - Each question has a short "header" (≤12 chars)
 *   - The tool name is "AskUserQuestion" not "ask_followup_question"
 *   - There's no `<question_answer>` XML; CC returns the selected label text
 *     directly as tool_result content
 *   - options MUST be 2–4 items (client validates this strictly!)
 *   - Client auto-appends "Other" for free-text, so users can input unlisted options
 */
function buildAskUserQuestionArgs(data: FormData): { questions: CCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;

  const titlePrefix = retry ? "⚠️ " : "";
  const questions: CCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "Associate team assets with this conversation?",
      header: "Team Assets",
      options: [
        { label: ASSET_CONFIRM_YES, description: "Select Team / Agent / Task and inject the team context" },
        { label: ASSET_CONFIRM_NO, description: "Inject nothing this time, pass through" },
      ],
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // Team options: show up to 3 teams (no skip option)
    // label format: "team_name (last 8 chars of id)" so same-named teams can be told apart
    // description left empty — the label already has the team name + id suffix, repeating it is noise.
    const teamOpts = teams.slice(0, CC_MAX_BUSINESS_OPTIONS).map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    // Ensure minimum 2 options (Claude Code requires 2–4)
    const allOptions = teamOpts.length >= 2
      ? teamOpts
      : [...teamOpts, { label: NO_MORE_LABEL, description: NO_MORE_DESC }];
    questions.push({
      question: titlePrefix + "Please select the Team for this session:",
      header: "Team",
      options: allOptions.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "agent_task"
  // Claude Code paging: hard limit of 4 options → each page has 3 agents + 1 "More →" (on non-final pages).
  // The final page no longer includes SKIP, only the remaining agents. If the final page has only 1 agent, add a placeholder to guarantee ≥2 options.
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  const pageIndex = Math.max(0, data.pageIndex ?? 0);
  const totalAgents = team.agents.length;
  const start = pageIndex * CC_MAX_BUSINESS_OPTIONS;
  const slice = team.agents.slice(start, start + CC_MAX_BUSINESS_OPTIONS);
  const isLastPage = start + CC_MAX_BUSINESS_OPTIONS >= totalAgents;
  const totalPages = Math.max(1, Math.ceil(totalAgents / CC_MAX_BUSINESS_OPTIONS));

  // agent label format: "agent_name (last 8 chars of id)" so same-named agents can be told apart.
  // description keeps only the agent's own description (informative); drop the trailing "(Team has N tasks)"
  // / "(No tasks)" hints — the user is choosing an agent now and the task count is irrelevant.
  const combinedOptions: Array<{ label: string; description: string }> = slice.map((a) => ({
    label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
    description: a.description ?? "",
  }));

  // Non-final page: add "More →"; final page: no extra options (SKIP removed)
  if (!isLastPage) {
    const remaining = totalAgents - (start + CC_MAX_BUSINESS_OPTIONS);
    combinedOptions.push({
      label: MORE_LABEL,
      description: `View the next batch (${remaining} more Agents)`,
    });
  }

  // AskUserQuestion requires options ≥ 2; as a fallback when the slice is empty in extreme cases:
  // use "(No more options)" as a placeholder; if the user selects it → extractor does not recognize it → init.ts bypasses.
  while (combinedOptions.length < 2) {
    combinedOptions.push({ label: NO_MORE_LABEL, description: NO_MORE_DESC });
  }

  const pageSuffix = totalPages > 1 ? ` (page ${pageIndex + 1}/${totalPages})` : "";
  questions.push({
    question: titlePrefix + `Please select the Agent to use under "${team.team_name}"${pageSuffix}:`,
    header: totalPages > 1 ? `Agent ${pageIndex + 1}/${totalPages}`.slice(0, 12) : "Agent",
    options: combinedOptions.slice(0, CC_MAX_OPTIONS),
    multiSelect: false,
  });

  return { questions };
}

/**
 * Build a Claude Code `AskUserQuestion` fake form response (Anthropic protocol only).
 *
 * Claude Code always talks Anthropic SSE; we emit the tool_use via standard
 * Anthropic streaming events with tool name "AskUserQuestion".
 *
 * EXPERIMENTAL: Set env `CC_FORM_MODE` to switch how we expose the form to CLI:
 *   - "tool" (default): single-question AskUserQuestion tool_use (≤3 biz + skip)
 *   - "tool-multi-question": one tool_use carrying up to 4 questions (schema
 *     allows 1–4 questions × 2–4 options = up to 16 option slots in one widget),
 *     used to surface more teams/agents at once
 *   - "fake-result": skip tool_use entirely; emit a synthetic tool_result block
 *     with the questions JSON, to probe whether CLI scans tool_result for the
 *     AskUserQuestion widget
 *   - "self-answered-tool": emit BOTH a tool_use AND a matching tool_result in
 *     the same assistant message (id matches), simulating "assistant calls the
 *     tool and immediately self-supplies the result". Probes whether CLI's
 *     toolUseConfirm renderer keys on tool_use alone or requires the absence of
 *     a subsequent tool_result, and whether matched ids change behaviour.
 *   - "text-markdown"/"text-xml"/"text-table"/"text-all": plain assistant text
 *     variants (proven not to trigger any widget render — kept for reference)
 */
export function buildCCAskUserFormResponse(data: FormData): Response {
  const mode = (process.env.CC_FORM_MODE || "tool").toLowerCase();
  if (mode === "tool-multi-question") {
    return buildCCMultiQuestionToolUseResponse(data);
  }
  if (mode === "fake-result") {
    return buildCCFakeToolResultResponse(data);
  }
  if (mode === "self-answered-tool") {
    return buildCCSelfAnsweredToolResponse(data);
  }
  if (mode.startsWith("text")) {
    return buildCCTextFormResponse(data, mode);
  }
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_" + Date.now();
  const toolUseId = CC_SESSION_INIT_TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);

  const encoder = new TextEncoder();
  const inputJson = JSON.stringify(input);

  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: CC_SESSION_INIT_TOOL_NAME,
          input: {},
        },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}

// ── Claude Code: EXPERIMENTAL text-mode form (no AskUserQuestion tool) ────────

/**
 * Render the form data into one or more text formats, then emit it as a normal
 * Anthropic streaming assistant text message. We do NOT emit any tool_use, so
 * the CLI sees only assistant content.
 *
 * Goal: empirically test whether Claude Code CLI scans assistant text for any
 * "render this as a widget" pattern. If it doesn't, the user sees these as
 * plain text; if it does, we'll see a widget render and know which format wins.
 */
function renderTextMarkdown(data: FormData): string {
  const { teams, stage, selectedTeamId, retry } = data;
  const title = retry
    ? "⚠️ " + SESSION_INIT_RETRY_FORM_TITLE
    : stage === "team"
      ? SESSION_INIT_TEAM_FORM_TITLE
      : SESSION_INIT_AGENT_TASK_FORM_TITLE;

  const lines: string[] = [`## ${title}`, ""];
  if (stage === "team") {
    lines.push("Please select the Team for this session (reply with the number or name):", "");
    teams.forEach((t, i) => {
      lines.push(`${i + 1}. **${t.team_name}** — ${t.agents.length} Agents`);
    });
    lines.push(`0. ${SKIP_LABEL}`);
    return lines.join("\n");
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return lines.join("\n");

  lines.push(`Please select the Agent to use under "${team.team_name}" (reply with the number or name):`, "");
  team.agents.forEach((a, i) => {
    lines.push(`${i + 1}. **${a.agent_name}**`);
  });
  lines.push(`0. ${SKIP_LABEL}`);
  return lines.join("\n");
}

function renderTextXml(data: FormData): string {
  const { teams, stage, selectedTeamId, retry } = data;
  const title = retry
    ? "⚠️ " + SESSION_INIT_RETRY_FORM_TITLE
    : stage === "team"
      ? SESSION_INIT_TEAM_FORM_TITLE
      : SESSION_INIT_AGENT_TASK_FORM_TITLE;
  const lines: string[] = [];
  lines.push(`<question title="${title}">`);
  if (stage === "team") {
    teams.forEach((t) => lines.push(`  <option value="${t.team_id}">${t.team_name}</option>`));
    lines.push(`  <option value="__skip__">${SKIP_LABEL}</option>`);
  } else {
    const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
    if (team) {
      team.agents.forEach((a) => {
        lines.push(`  <option value="${a.agent_id}">${a.agent_name}</option>`);
      });
      lines.push(`  <option value="__skip__">${SKIP_LABEL}</option>`);
    }
  }
  lines.push("</question>");
  return lines.join("\n");
}

function renderTextTable(data: FormData): string {
  const { teams, stage, selectedTeamId, retry } = data;
  const title = retry
    ? "⚠️ " + SESSION_INIT_RETRY_FORM_TITLE
    : stage === "team"
      ? SESSION_INIT_TEAM_FORM_TITLE
      : SESSION_INIT_AGENT_TASK_FORM_TITLE;
  const lines: string[] = [`### ${title}`, "", "| # | Name | Description |", "|---|------|------|"];
  if (stage === "team") {
    teams.forEach((t, i) =>
      lines.push(`| ${i + 1} | ${t.team_name} | ${t.agents.length} Agents |`),
    );
    lines.push(`| 0 | ${SKIP_LABEL} | Skip injection this time |`);
  } else {
    const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
    if (team) {
      team.agents.forEach((a, i) => {
        lines.push(`| ${i + 1} | ${a.agent_name} | |`);
      });
      lines.push(`| 0 | ${SKIP_LABEL} | Skip injection this time |`);
    }
  }
  return lines.join("\n");
}

function buildCCTextFormResponse(data: FormData, mode: string): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_text_" + Date.now();

  let body: string;
  switch (mode) {
    case "text-xml":
      body = renderTextXml(data);
      break;
    case "text-table":
      body = renderTextTable(data);
      break;
    case "text-all":
      body =
        renderTextMarkdown(data) +
        "\n\n---\n\n" +
        renderTextXml(data) +
        "\n\n---\n\n" +
        renderTextTable(data);
      break;
    case "text-markdown":
    default:
      body = renderTextMarkdown(data);
      break;
  }

  const encoder = new TextEncoder();
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        sse("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );

      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );

      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: body },
        }),
      );

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      controller.enqueue(
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
      );

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── Claude Code: EXPERIMENTAL multi-question tool_use (up to 4×4=16 slots) ────

/**
 * Build a single AskUserQuestion tool_use carrying multiple questions, each with
 * up to 4 options. The official schema (verified from cli.js) allows
 *   questions: 1–4
 *   options:   2–4 per question
 *   header:    ≤12 chars
 * So we can surface up to 16 option slots in one widget by chunking teams or
 * agents into multiple questions. The first question is the "real" one — the
 * user's first answer wins — and the remaining questions act as overflow pages.
 *
 * NOTE: extractor only inspects ONE answer per stage, so when this mode is on
 * the user is expected to actually answer ALL questions, but in practice CLI
 * lets you skip extras with "Other"/empty. This is a probe to see how CLI
 * actually renders multi-question forms.
 */
function buildCCMultiQuestionToolUseResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_mq_" + Date.now();
  const toolUseId = CC_SESSION_INIT_TOOLCALL_PREFIX + Date.now();
  const input = buildMultiQuestionArgs(data);
  return emitCCToolUseSSE(model, msgId, toolUseId, input);
}

function buildMultiQuestionArgs(data: FormData): { questions: CCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: CCAskQuestion[] = [];

  if (stage === "team") {
    // Chunk teams into pages of (CC_MAX_OPTIONS-1)=3, plus skip on last page.
    const chunkSize = CC_MAX_BUSINESS_OPTIONS;
    const totalPages = Math.min(4, Math.ceil(teams.length / chunkSize) || 1);
    for (let p = 0; p < totalPages; p++) {
      const slice = teams.slice(p * chunkSize, (p + 1) * chunkSize);
      const opts = slice.map((t) => ({
        label: `${t.team_name} (${t.team_id.slice(-8)})`,
        description: "",
      }));
      // Pad to min 2 options if last page has only 1 real team
      while (opts.length < 1) opts.push({ label: NO_MORE_LABEL, description: NO_MORE_DESC });
      // Skip option only on last page
      const isLast = p === totalPages - 1;
      if (isLast) opts.push({ label: SKIP_LABEL, description: "Do not associate this time, pass through" });
      // Ensure at least 2 options (schema min)
      if (opts.length < 2) opts.push({ label: NO_MORE_LABEL, description: NO_MORE_DESC });
      questions.push({
        question:
          titlePrefix + `Please select the Team for this session (page ${p + 1}/${totalPages}):`,
        header: `Team ${p + 1}/${totalPages}`.slice(0, 12),
        options: opts.slice(0, CC_MAX_OPTIONS),
        multiSelect: false,
      });
    }
    return { questions };
  }

  // stage === "agent_task"
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };
  const agents = team.agents;
  const chunkSize = CC_MAX_BUSINESS_OPTIONS;
  const totalPages = Math.min(4, Math.ceil(agents.length / chunkSize) || 1);
  for (let p = 0; p < totalPages; p++) {
    const slice = agents.slice(p * chunkSize, (p + 1) * chunkSize);
    const opts = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));
    const isLast = p === totalPages - 1;
    if (isLast) opts.push({ label: SKIP_LABEL, description: "Do not associate this time, pass through" });
    if (opts.length < 2) opts.push({ label: "Other", description: "Another option is needed" });
    questions.push({
      question:
        titlePrefix +
        `Please select the Agent under "${team.team_name}" (page ${p + 1}/${totalPages}):`,
      header: `Agent ${p + 1}/${totalPages}`.slice(0, 12),
      options: opts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
  }
  return { questions };
}

// ── Claude Code: EXPERIMENTAL fake tool_result (no tool_use at all) ───────────

/**
 * Probe: does Claude Code CLI scan tool_result blocks (independent of any
 * preceding tool_use) for AskUserQuestion-shaped JSON and render a widget?
 *
 * Per source-code analysis of cli.js, the rendering switch (Z5A) is keyed on
 * the tool object identity (case KI6) and is only hit during the
 * toolUseConfirm flow — i.e. when CLI sees an assistant tool_use it intercepts
 * BEFORE relaying it. tool_result is downstream user-side data and does NOT
 * trigger renderToolUseConfirmation. This mode exists to empirically confirm
 * that hypothesis.
 *
 * What this emits:
 *   assistant content: [
 *     { type: "tool_result", tool_use_id: <fake>, content: <JSON string with questions> }
 *   ]
 * Strictly speaking tool_result blocks belong on `user` role per Anthropic
 * spec. We send it under assistant to see if CLI rejects it, ignores it, or
 * (improbably) renders something.
 */
function buildCCFakeToolResultResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_fr_" + Date.now();
  const fakeToolUseId = CC_SESSION_INIT_TOOLCALL_PREFIX + "fake_" + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const resultPayload = JSON.stringify({
    type: "AskUserQuestion",
    name: CC_SESSION_INIT_TOOL_NAME,
    input,
  });

  const encoder = new TextEncoder();
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        sse("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_result",
            tool_use_id: fakeToolUseId,
            content: resultPayload,
          },
        }),
      );
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      controller.enqueue(
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
      );
      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── Claude Code: EXPERIMENTAL self-answered tool (tool_use + tool_result) ─────

/**
 * Probe: emit a tool_use block IMMEDIATELY followed by a matching tool_result
 * block in the SAME assistant message. The two blocks share the same id, so it
 * looks like "the assistant called the tool AND already supplied the result".
 *
 * Hypotheses being tested:
 *   (a) Does CLI's toolUseConfirm renderer fire on the tool_use block, ignoring
 *       the trailing tool_result? If so, widget would still render (but the
 *       extra tool_result might confuse downstream message replay).
 *   (b) Does CLI short-circuit and treat the pair as "already resolved", thus
 *       skipping the widget render entirely?
 *   (c) Does CLI reject the message outright because assistant role isn't
 *       allowed to emit tool_result per Anthropic spec?
 *
 * Note: per Anthropic protocol this is malformed. Only proxies that don't
 * validate role can pass it through. Claude Code reads our SSE directly so
 * there's no intermediate validator.
 */
function buildCCSelfAnsweredToolResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_sa_" + Date.now();
  const toolUseId = CC_SESSION_INIT_TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const inputJson = JSON.stringify(input);
  // Self-supplied "result": pretend the user already answered the first option.
  const firstOption = input.questions[0]?.options[0]?.label ?? "";
  const resultPayload = JSON.stringify({
    answers: input.questions.map((q, idx) => ({
      question: q.question,
      answer: idx === 0 ? firstOption : "",
    })),
  });

  const encoder = new TextEncoder();
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        sse("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      // Block 0: the tool_use (same shape as default mode)
      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: toolUseId,
            name: CC_SESSION_INIT_TOOL_NAME,
            input: {},
          },
        }),
      );
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: inputJson },
        }),
      );
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      // Block 1: the tool_result with MATCHING id
      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: resultPayload,
          },
        }),
      );
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 1 }));
      controller.enqueue(
        sse("message_delta", {
          type: "message_delta",
          // Use tool_use as stop_reason so CLI follows the toolUseConfirm path.
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
      );
      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * Shared helper: emit a Claude Code AskUserQuestion tool_use SSE stream.
 * Used by both the default tool mode and the experimental multi-question mode.
 */
function emitCCToolUseSSE(
  model: string,
  msgId: string,
  toolUseId: string,
  input: { questions: CCAskQuestion[] },
): Response {
  const encoder = new TextEncoder();
  const inputJson = JSON.stringify(input);
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        sse("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      controller.enqueue(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: toolUseId,
            name: CC_SESSION_INIT_TOOL_NAME,
            input: {},
          },
        }),
      );
      controller.enqueue(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: inputJson },
        }),
      );
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      controller.enqueue(
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
      );
      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── Non-streaming (tool_calls) ──────────────────────────────────────────────────

function buildNonStreamingToolCallResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  args: { title: string; questions: string },
): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: {
            name: "ask_followup_question",
            arguments: JSON.stringify(args),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Streaming SSE (tool_calls) ──────────────────────────────────────────────────

function buildStreamingToolCallResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  args: { title: string; questions: string },
): Response {
  const encoder = new TextEncoder();
  const argsStr = JSON.stringify(args);

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: tool_call start (with function name and id)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: "ask_followup_question", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 2: tool_call arguments (full)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: argsStr },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 3: finish
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`));

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}

// ── Anthropic non-streaming (tool_use) ──────────────────────────────────────────

function buildAnthropicNonStreamingToolUseResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  args: { title: string; questions: string },
): Response {
  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content: [{
      type: "tool_use",
      id: toolUseId,
      name: "ask_followup_question",
      input: args,
    }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Anthropic streaming SSE (tool_use) ──────────────────────────────────────────

/**
 * Anthropic tool_use streaming uses `input_json_delta`: the tool input arrives
 * as a JSON string fragment in `partial_json`, which the client concatenates and
 * parses. We emit the whole JSON in one delta chunk.
 */
function buildAnthropicStreamingToolUseResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  args: { title: string; questions: string },
): Response {
  const encoder = new TextEncoder();
  const inputJson = JSON.stringify(args);

  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId, name: "ask_followup_question", input: {} },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
