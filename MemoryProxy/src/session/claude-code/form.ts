/**
 * Claude Code Session Init Form — `AskUserQuestion` tool_use.
 *
 * Claude Code native interactive form:
 *   - Tool name: `AskUserQuestion`
 *   - Options: `{ label, description }` structs, hard limit of 2-4
 *   - Protocol: Anthropic SSE only
 *   - ID prefix: `toolu_cc_session_init_`
 *   - Pagination: 3 agents per page + 1 "More →"/SKIP slot
 *
 * Contains no CodeBuddy logic.
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "./pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "AskUserQuestion";
export const TOOLCALL_PREFIX = "toolu_cc_session_init_";

export const TEAM_FORM_TITLE = "Session Init — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Init — Select Agent and Task";
export const RETRY_FORM_TITLE = "Could not recognize your selection, please select again";

export const SKIP_LABEL = "Do not associate this time (skip injection, pass through)";
export const MORE_LABEL = "More →";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Init — Associate Team Assets?";

/**
 * Generic note appended to the end of each step's question.
 * Claude Code's AskUserQuestion gives the user an "Other" input box; replying "skip" or
 * "do not associate" goes through the SKIP_RE bypass; unrecognized free text -> unrecognized -> also bypass.
 * The wording is unified across the five clients workbuddy/codex/codebuddy/dsh/cc, to avoid wording drift between clients.
 */
const SKIP_HINT = ' (Please choose the best-matching option; custom input is not currently supported. If you choose to skip, this Session will not inject team assets)';

// Pagination layout is handled by pagination.ts; only its constants are used here.
const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/**
 * Fixed placeholder signature for the fake `thinking` block (used by buildFormResponse).
 *
 * ## Background -- hard constraint of DeepSeek's official Anthropic-compatible endpoint
 *
 * DeepSeek V4's `/anthropic/v1/messages` endpoint in thinking mode (thinking models such as deepseek-v4-pro
 * with a `tools` parameter are almost on by default) **strictly requires** historical assistant messages
 * to contain a `thinking` content block, otherwise it returns:
 *   `400 The content[].thinking in the thinking mode must be passed back to the API`
 *
 * The same pitfall has been reproduced in opencode #24803 / claude-code-router #1378 / hermes-agent #17992 /
 * litellm #31439. DeepSeek's official docs also state: with tools, reasoning_content
 * must be passed back in subsequent requests; under the Anthropic protocol this likewise means the thinking block.
 *
 * Our session-init fake form response only emits `tool_use`, with no thinking -> after the user answers the form,
 * CC puts this fake assistant + tool_result into the history of the next real request -> DeepSeek returns 400.
 *
 * ## Why an empty thinking + placeholder signature is enough
 *
 * - **DeepSeek**: only checks presence; `thinking: ""` + any signature passes (community cases
 *   verified directly with curl that `reasoning_content: ""` unlocks it).
 * - **The proxy's own `sanitizeThinkingBlocks`** (`anthropicHandler.ts:277-289`):
 *   requires the signature to be base64ish (`^[A-Za-z0-9+/=]+$`) + length >= 40 + not a UUID.
 *   Our placeholder satisfies all three -> it will not be stripped by mistake.
 * - **Real Anthropic upstream**: only performs signature
 *   crypto verification when the request itself enables thinking mode. In the CC session-init fake response scenario:
 *     - client has thinking off -> Anthropic ignores the historical thinking sig -> no effect
 *     - client has thinking on -> it would already 400 because the fake tool_use has no thinking
 *       (net-new regressions: 0)
 * - **CC client UI**: the thinking content is empty; at most an empty collapsed thinking block is shown, harmless.
 *
 * ## Symmetric patch on the dsh side
 *
 * `REASONING_PLACEHOLDER` in `src/session/dsh/form.ts` solves the same problem under the OpenAI protocol
 * (deepseek's OpenAI `/v1/chat/completions` endpoint strictly checks `reasoning_content`).
 * CC here uses the Anthropic protocol -> the thinking block version.
 *
 * The value itself has no effect on the model -- the fake session-init never actually goes through the model.
 */
const THINKING_SIGNATURE_PLACEHOLDER =
  "UHJveHlDQ1Nlc3Npb25Jbml0RmFrZVRoaW5raW5nUGxhY2Vob2xkZXJTaWc=";

/** Returns true if the given string contains any CC form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_use id belongs to a CC session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /** Claude Code pagination: current agent page number (0-based) */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── Claude Code AskUserQuestion input schema ───────────────────────────────────

interface CCAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: CCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: CCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "Do you want to associate team assets with this conversation?" + SKIP_HINT,
      header: "Team assets",
      options: [
        { label: ASSET_CONFIRM_YES, description: "Select Team / Agent / Task and inject team context" },
        { label: ASSET_CONFIRM_NO, description: "Inject nothing this time; pass through" },
      ],
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // Team options: list only real teams. The explicit "skip" entry exists only at the asset_confirm stage; later
    // stages' "abnormal/unrecognized" cases are bypassed by init.ts as a fallback.
    //
    // The caller (init.ts) guarantees teams.length >= 2 -- a single team is skipped via auto-select and
    // never reaches the team form. The form builder no longer provides a fallback placeholder.
    // description is left empty -- the label already contains the team name + id suffix, repeating "Team: name"
    // is just noise.
    //
    // Pagination aligned with agent/task: first N-1 pages hold 3 real + "More →", the last page holds the rest (<=4).
    // The old implementation hard-truncated with `slice(0, 4)`; with >= 5 teams the remaining teams silently vanished with no
    // way to page -- fixed (2026-09-03).
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(teams.length, pageIndex);
    const slice = teams.slice(page.start, page.end);
    const teamOpts: Array<{ label: string; description: string }> = slice.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      teamOpts.push({ label: MORE_LABEL, description: `See next batch (${remaining} more Team(s))` });
    }

    if (teamOpts.length < 2) {
      throw new Error(
        `[cc form] team page ${pageIndex} has ${teamOpts.length} option(s); ` +
          `team stage requires ≥2 teams — caller must auto-select when teams.length === 1, ` +
          `and pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? ` (page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Select the Team for this session${pageSuffix}: ` + SKIP_HINT,
      header: page.totalPages > 1 ? `Team ${pageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Team",
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "agent_select" or "agent_task" (agent_task = no SKIP on last page)
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    // Keep only the agent's own description (informative); drop the "(N tasks selectable after choosing the agent)" /
    // "(no tasks)" suffix -- the user is choosing an agent now, and a task-count hint neither affects the decision
    // nor is worth the screen space. If an agent has no custom description, description is left empty, no longer falling back to "Agent: name"
    // (the label already has the name).
    const combinedOptions: Array<{ label: string; description: string }> = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: `See next batch (${remaining} more Agent(s))` });
    }
    // The last page no longer appends SKIP: explicit skip is offered only at asset_confirm; later stages' "abnormal/unrecognized"
    // cases are bypassed by init.ts as a fallback.
    //
    // pagination.ts guarantees at least 2 real items per page (when total > 4; when total <= 4 a single page holds all
    // 4 slots, no MORE); combinedOptions with <2 should not be received here.
    if (combinedOptions.length < 2) {
      throw new Error(
        `[cc form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? ` (page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Select the Agent to use under "${team.team_name}"${pageSuffix}: ` + SKIP_HINT,
      header: page.totalPages > 1 ? `Agent ${pageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Agent",
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "task_select"
  if (!team) return { questions };

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    // description is left empty -- the label already contains the task name + id suffix; "Task: name" is just noise.
    // The virtual fallback entry (isDefault) gets no id suffix; there is only one, so no name ambiguity.
    const taskOpts: Array<{ label: string; description: string }> = taskSlice.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      taskOpts.push({
        label: MORE_LABEL,
        description: `See next batch (${remaining} more task(s))`,
      });
    }

    // Same as the agent stage: pagination.ts guarantees count >= 2; <2 here means the paginator has a bug.
    if (taskOpts.length < 2) {
      throw new Error(
        `[cc form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = page.totalPages > 1 ? ` (page ${taskPageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Select the task to associate under "${team.team_name}"${taskPageSuffix}: ` + SKIP_HINT,
      header: page.totalPages > 1 ? `Task ${taskPageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Task",
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });

    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a Claude Code `AskUserQuestion` fake form response.
 * Always Anthropic SSE streaming (Claude Code only speaks Anthropic).
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_" + Date.now();
  const toolUseId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const inputJson = JSON.stringify(input);

  const encoder = new TextEncoder();
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

      // ── Fake `thinking` block (index 0) ───────────────────────────────────
      // Emit unconditionally -- DeepSeek's official Anthropic-compatible endpoint in thinking mode strictly requires
      // historical assistants to carry a thinking block, otherwise 400. See the
      // THINKING_SIGNATURE_PLACEHOLDER constant comment. Zero regressions for real Anthropic
      // (without thinking mode the sig is not crypto-verified; with thinking mode it would already
      // 400 because the fake tool_use has no thinking).
      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "" },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: THINKING_SIGNATURE_PLACEHOLDER },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      // ── tool_use block (index 1) ─────────────────────────────────────────
      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: TOOL_NAME,
          input: {},
        },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 1 }));

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
