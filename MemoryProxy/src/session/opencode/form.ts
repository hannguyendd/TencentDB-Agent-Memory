/**
 * opencode Session Init Form — carrier for the `question` tool_call.
 *
 * The opencode CLI (sst/opencode, a Bun-packaged binary) maintains a **hard whitelist** of
 * tools in its agent-loop: `bash, edit, glob, grep, invalid, question, read, skill, task,
 * todowrite, webfetch, write`. Any tool_call whose name is not on the whitelist is
 * rejected by the client and rendered as `invalid [tool=xxx, error=Model tried to call unavailable tool]`.
 *
 * Therefore the proxy-side session-init form **cannot reuse** CB's `ask_followup_question`
 * or CC's `AskUserQuestion` — it must map to the native opencode `question` tool.
 *
 * # Schema basis of the `question` tool
 *
 * Source: sst/opencode `packages/opencode/src/tool/question.ts` + Question v1
 * schema (`Question.Prompt`). Core structure:
 *   {
 *     questions: [
 *       {
 *         question: string,             // question text (required)
 *         header:   string,             // title of <=30 chars (required)
 *         options:  [{label, description?}, ...],  // at least 1 item
 *         multiple?: boolean,           // multi-select (optional, default false)
 *       },
 *       ...
 *     ]
 *   }
 *
 * # Differences from the workbuddy form (3 items + tool name)
 *   - tool_name: `AskUserQuestion` → `question`
 *   - multiSelect (camelCase) → **multiple** (unique to opencode; neither CC's
 *     `multiSelect` nor dsh's `multi_select`)
 *   - header length constraint: opencode <=30 chars (wb/CC have no limit) → use `.slice(0, 30)`
 *   - tool_call id prefix: `call_oc_session_init_`
 *
 * # Transport
 *   - protocol = **OpenAI /v1/chat/completions** (opencode uses the
 *     `@ai-sdk/openai-compatible` provider underneath)
 *   - SSE stream or non-stream (consistent with the request's `body.stream`)
 *   - the skeleton is copied wholesale from workbuddy (chunk 1 = role+tool_call decl / chunk 2 =
 *     arguments delta / chunk 3 = finish_reason:tool_calls / DONE)
 *
 * # State machine
 *   - fully reuses the CB state machine (session/codebuddy/init.ts), same pattern as workbuddy/dsh;
 *     the stage values (asset_confirm / team / agent_select / task_select / agent_task)
 *     are identical to CB and passed through directly.
 *
 * # Pagination
 *   - opencode `question.options` has no known hard limit, but to keep the UI consistent with CC/WB,
 *     the `computePagination` + `MORE_LABEL` tail-slot scheme is reused (<=4 options/page).
 *
 * # Format of the user's answer passed back (for extractor reference)
 *   After the user finishes choosing, the opencode `question` tool returns a text-form tool-result to the model:
 *     `User has answered your questions: "question1"="answer1", "question2"="answer2, answer3"`
 *   The existing extractor's substring fallback (running `hay.includes` on team_name / agent_name / the
 *   last 8 chars of id) covers this format, so no opencode-specific branch is needed.
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "../claude-code/pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Native opencode tool name, a member of the hard whitelist. Do not change it to `AskUserQuestion` or `ask_followup_question`. */
export const TOOL_NAME = "question";
export const TOOLCALL_PREFIX = "call_oc_session_init_";

export const TEAM_FORM_TITLE = "Session Init — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Init — Select Agent and Task";
export const RETRY_FORM_TITLE = "Could not recognize your selection, please select again";

export const SKIP_LABEL = "Do not associate this time (skip injection, pass through)";
export const MORE_LABEL = "More →";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Init — Associate Team Assets?";

/**
 * Generic note appended to the end of each step's question. The opencode `question` tool UI also lets the user type a free-form answer
 * (non-option text); replying "skip / 跳过 / 不关联" goes through the SKIP_RE bypass.
 * The wording is unified across six clients: claude-code / workbuddy / codex / codebuddy / dsh / opencode.
 */
const SKIP_HINT = ' (Please choose the best-matching option; custom input is not currently supported. If you choose to skip, this Session will not inject team assets)';

/** Hard upper limit of the opencode question header. Schema validation requires <=30 chars; longer ones are rejected by the client. */
const OC_HEADER_MAX = 30;

const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Clip any header text to the <=30 chars allowed by the opencode schema. */
function clipHeader(s: string): string {
  return s.length > OC_HEADER_MAX ? s.slice(0, OC_HEADER_MAX) : s;
}

/** Returns true if the given string contains any opencode form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to an opencode session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** Pagination: current page index (0-based); aligned with CC/WB, which use only one pageIndex (single question for team/agent/task) */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── opencode `question` input schema ───────────────────────────────────────────

interface OCQuestionOption {
  label: string;
  description: string;
}

interface OCAskQuestion {
  question: string;
  /** Hard opencode constraint: <=30 chars. */
  header: string;
  options: OCQuestionOption[];
  /** Unique opencode naming: `multiple` (neither CC's `multiSelect` nor dsh's `multi_select`). */
  multiple: boolean;
}

function buildQuestionArgs(data: FormData): { questions: OCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: OCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "Do you want to associate team assets with this conversation?" + SKIP_HINT,
      header: clipHeader("Team assets"),
      options: [
        { label: ASSET_CONFIRM_YES, description: "Select Team / Agent / Task and inject the team context" },
        { label: ASSET_CONFIRM_NO, description: "Inject nothing this time; pass through directly" },
      ],
      multiple: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // Pagination aligned with agent/task — the old implementation hard-truncated with `slice(0, 4)`; when the user had >=5 teams,
    // later teams silently disappeared with no way to page. Fixed on 2026-09-03.
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(teams.length, pageIndex);
    const slice = teams.slice(page.start, page.end);
    const teamOpts: Array<{ label: string; description: string }> = slice.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      teamOpts.push({ label: MORE_LABEL, description: `View the next batch (${remaining} Team(s) remaining)` });
    }

    if (teamOpts.length < 2) {
      throw new Error(
        `[oc form] team page ${pageIndex} has ${teamOpts.length} option(s); ` +
          `team stage requires ≥2 teams — caller must auto-select when teams.length === 1, ` +
          `and pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? ` (page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Please select the Team for this session${pageSuffix}:` + SKIP_HINT,
      header: clipHeader(page.totalPages > 1 ? `Team ${pageIndex + 1}/${page.totalPages}` : "Team"),
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    const combinedOptions: OCQuestionOption[] = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: `View the next batch (${remaining} Agent(s) remaining)` });
    }

    if (combinedOptions.length < 2) {
      throw new Error(
        `[oc form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? ` (page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Please select the Agent to use under "${team.team_name}"${pageSuffix}:` + SKIP_HINT,
      header: clipHeader(page.totalPages > 1 ? `Agent ${pageIndex + 1}/${page.totalPages}` : "Agent"),
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    const taskOpts: OCQuestionOption[] = taskSlice.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      taskOpts.push({
        label: MORE_LABEL,
        description: `View the next batch (${remaining} task(s) remaining)`,
      });
    }

    if (taskOpts.length < 2) {
      throw new Error(
        `[oc form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = page.totalPages > 1 ? ` (page ${taskPageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Please select the task to associate under "${team.team_name}"${taskPageSuffix}:` + SKIP_HINT,
      header: clipHeader(page.totalPages > 1 ? `Task ${taskPageIndex + 1}/${page.totalPages}` : "Task"),
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build an opencode `question` fake form response.
 *
 * Transport: **OpenAI chat/completions** (stream or non-stream).
 * arguments shape: native opencode `{questions: [{question, header, options, multiple}]}`.
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "oc-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildQuestionArgs(data);
  const argsStr = JSON.stringify(input);

  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
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
            arguments: argsStr,
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
  argsStr: string,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role + tool_call declaration (empty arguments)
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

      // Chunk 2: arguments delta (whole JSON as single delta)
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
