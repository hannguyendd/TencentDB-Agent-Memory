/**
 * CodeBuddy Session Init Form — `ask_followup_question` tool_call.
 *
 * CodeBuddy renders a form with clickable buttons:
 *   - Tool name: `ask_followup_question`
 *   - Options: flat string list, no count limit
 *   - Protocols: OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`)
 *   - ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
 *
 * Contains no Claude Code logic.
 */

import type { TeamOption } from "../types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "ask_followup_question";
export const TOOLCALL_PREFIXES = ["call_session_init_", "toolu_session_init_"] as const;

export const TEAM_FORM_TITLE = "Session Init — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Init — Select Agent and Task";
export const RETRY_FORM_TITLE = "Could not recognize your selection, please select again";
/** Overall title kept for legacy tests (used by cleaner.ts detection). */
export const COMBINED_FORM_TITLE = "Session Init — Select Team / Agent / Task";

export const SKIP_LABEL = "Do not associate this time (skip injection, pass through)";
export const PATH_SEP = " / ";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Init — Associate Team Assets?";

/**
 * Generic note appended to the end of each step's question.
 * CodeBuddy uses a button-style form; the only skip entry is choosing "No" in the initial asset_confirm step;
 * once in team / agent_task there is no in-button skip, and the user must re-select in the next session.
 * Wording is unified across the five clients: claude-code/workbuddy/codex/dsh/codebuddy.
 */
const SKIP_HINT = ' (Please choose the best-matching option; custom input is not supported yet. If you choose skip, team assets will not be injected into this Session)';

/** Returns true if the given string contains any CodeBuddy form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(COMBINED_FORM_TITLE) ||
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a CodeBuddy session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return TOOLCALL_PREFIXES.some((p) => id.startsWith(p));
}

// ── Form Data ──────────────────────────────────────────────────────────────────

/**
 * Stages supported by the CB form.
 *
 * The CB client only uses "asset_confirm" | "team" | "agent_task" (agent+task asked in one shot).
 * After the 2026-08-08 stage split, the codex client reusing the CB state machine additionally goes through the "agent_select"
 * and "task_select" sub-stages: the stage field of CB's exit formData is carried on to the
 * codex handler, and `buildCodexFormResponse` uses the stage to decide which question to render.
 *
 * CB's own `buildFollowupQuestionArgs` renders agent_select/task_select with the
 * ask-only-one semantics; the CB client never reaches here on the codex-only path (the real render
 * exit is codex form.ts); the branch is kept only as a defensive fallback & to ease CB-side unit tests.
 */
export type FormStage =
  | "asset_confirm"
  | "team"
  | "agent_select"
  | "task_select"
  | "agent_task";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /**
   * codex-only: the agent_id selected in the agent_select stage, passed through to the task_select stage
   * form. The CB client itself does not use it (CB asks agent+task in one shot).
   */
  selectedAgentId?: string;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  protocol?: "openai" | "anthropic";
  /**
   * Only used when agentSource="codex": the pagination page number the CB state machine passes through to the downstream codex form re-render.
   * The CB client does not render pagination itself (`ask_followup_question` has no option
   * count limit), so setting the field does not affect the CB exit.
   */
  teamPage?: number;
  agentPage?: number;
  taskPage?: number;
  /**
   * true = pass questions as a real array (CB v1.106+); false = pass a JSON string (older versions).
   * Defaults to true when unset.
   */
  questionsAsArray?: boolean;
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * The ask_followup_question schema of CB v1.106+ requires `questions` to be a real array (JSON
 * strings are no longer accepted). Older versions (v1.105-) expect questions to be a JSON string.
 * FormData.questionsAsArray decides which path is taken; default true (new version).
 */
function buildFollowupQuestionArgs(data: FormData): { title: string; questions: Array<Record<string, unknown>> | string } {
  const asArray = data.questionsAsArray !== false;
  const { teams, stage, selectedTeamId, retry } = data;

  const title = retry
    ? "⚠️ " + RETRY_FORM_TITLE
    : stage === "asset_confirm"
      ? ASSET_CONFIRM_FORM_TITLE
      : stage === "team"
        ? TEAM_FORM_TITLE
        : AGENT_TASK_FORM_TITLE;

  const questions: Array<{
    id: string;
    question: string;
    options: string[];
    multiSelect: boolean;
  }> = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: "asset_confirm",
      question: "Should this conversation be linked to team assets?" + SKIP_HINT,
      options: [ASSET_CONFIRM_YES, ASSET_CONFIRM_NO],
      multiSelect: false,
    });
    return { title, questions: asArray ? questions : JSON.stringify(questions) };
  }

  if (stage === "team") {
    questions.push({
      id: "team",
      question: "Please select the Team for this session:" + SKIP_HINT,
      options: [
        ...teams.map((t) => `${t.team_name} (${t.team_id.slice(-8)})`),
      ],
      multiSelect: false,
    });
    return { title, questions: asArray ? questions : JSON.stringify(questions) };
  }

  // stage in { "agent_task" (CB one-shot), "agent_select" / "task_select"
  // (codex-only split). The CB client never reaches the latter two stages: the codex handler re-renders with
  // codex form.ts and does not call CB `buildFollowupQuestionArgs`. The branches are kept
  // as a defensive fallback so the CB fallback render can still produce a valid structure.
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { title, questions: asArray ? questions : JSON.stringify(questions) };

  const wantAgent = stage === "agent_task" || stage === "agent_select";
  const wantTask = stage === "agent_task" || stage === "task_select";

  if (wantAgent && team.agents.length > 0) {
    const agentLabelOptions = [
      ...team.agents.map((a) => `${a.agent_name} (${a.agent_id.slice(-8)})`),
    ];
    questions.push({
      id: "agent",
      question: `Please select the Agent to use under "${team.team_name}":` + SKIP_HINT,
      options: agentLabelOptions,
      multiSelect: false,
    });
  }

  if (wantTask) {
    const taskOptions: string[] = [];
    for (const tk of team.tasks) {
      // The virtual fallback entry (isDefault) gets no id suffix; there is only one so no name ambiguity.
      if (tk.isDefault) {
        taskOptions.push(tk.task_name);
      } else {
        taskOptions.push(`${tk.task_name} (${tk.task_id.slice(-8)})`);
      }
    }
    if (taskOptions.length > 0) {
      questions.push({
        id: "task",
        question: `Please select the task to link under "${team.team_name}":` + SKIP_HINT,
        options: taskOptions,
        multiSelect: false,
      });
    }
  }

  return { title, questions: asArray ? questions : JSON.stringify(questions) };
}

/**
 * Build a fake form response (OpenAI or Anthropic protocol).
 * CodeBuddy supports two protocols:
 *   - protocol="openai": tool_calls chunk stream or JSON
 *   - protocol="anthropic": tool_use SSE stream or JSON
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const args = buildFollowupQuestionArgs(data);

  if (data.protocol === "anthropic") {
    const msgId = "msg_session_init_" + Date.now();
    const toolUseId = "toolu_session_init_" + Date.now();
    if (data.stream) {
      return buildAnthropicStreamingResponse(msgId, model, toolUseId, args);
    }
    return buildAnthropicNonStreamingResponse(msgId, model, toolUseId, args);
  }

  const id = "session-init-" + Date.now();
  const toolCallId = "call_session_init_" + Date.now();
  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, args);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, args);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  args: { title: string; questions: string | Array<Record<string, unknown>> },
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
            name: TOOL_NAME,
            arguments: JSON.stringify(args),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── OpenAI Streaming ───────────────────────────────────────────────────────────

function buildOpenAIStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  args: { title: string; questions: string | Array<Record<string, unknown>> },
): Response {
  const encoder = new TextEncoder();
  const argsStr = JSON.stringify(args);

  const stream = new ReadableStream({
    start(controller) {
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
              function: { name: TOOL_NAME, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

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

// ── Anthropic Non-streaming ────────────────────────────────────────────────────

function buildAnthropicNonStreamingResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  args: { title: string; questions: string | Array<Record<string, unknown>> },
): Response {
  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content: [{
      type: "tool_use",
      id: toolUseId,
      name: TOOL_NAME,
      input: args,
    }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Anthropic Streaming ────────────────────────────────────────────────────────

function buildAnthropicStreamingResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  args: { title: string; questions: string | Array<Record<string, unknown>> },
): Response {
  const encoder = new TextEncoder();
  const inputJson = JSON.stringify(args);
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
        content_block: { type: "tool_use", id: toolUseId, name: TOOL_NAME, input: {} },
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
