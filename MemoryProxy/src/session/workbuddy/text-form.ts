/**
 * text-form.ts — text-mode rendering layer used when WorkBuddy has no AskUserQuestion tool.
 *
 * Scenario: the new WorkBuddy official tools set dropped AskUserQuestion (capability probing determined
 * `capabilities.askUserQuestion === false`); if tool_calls SSE were still sent, the client would accept it
 * but not know how to render it → hang. Degraded to: go through the **content chunk**
 * stream of OpenAI chat.completions, rendering the options as markdown for the LLM client to relay verbatim to the user.
 *
 * Layout principles:
 *   - **No emoji** (user rule)
 *   - Use a `====` major-title rule, a `----` hint-area rule, right-aligned numbering, and blank-line blocks
 *   - Visual hierarchy relies on plain ASCII, not on markdown rendering
 *
 * Pagination: uses a standalone `computeTextPagination` (10 items per page, no MORE slot).
 * The user pages with the `next / prev` keywords, recognized in the CP3 parsing layer (this file only renders).
 *
 * Transport:
 *   - stream=true  → SSE, one role chunk + one content chunk + finish + [DONE]
 *   - stream=false → OpenAI chat.completion JSON, choices[0].message.content = markdown
 */

import type { TeamOption, AgentInTeam, TaskInTeam } from "../types.js";
import type { FormData, FormStage } from "./form.js";
import { computeTextPagination, TEXT_PAGE_SIZE } from "./text-pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Major-title rule (visually equivalent to the title emoji in card mode). */
const RULE_MAJOR = "================================================";
/** Hint-area rule (visually separates the option list from the action hints). */
const RULE_MINOR = "------------------------------------------------";

/** Titles of the 4 stages (without step numbers; the step number is concatenated dynamically). */
const STAGE_TITLES: Record<FormStage, string> = {
  asset_confirm: "Associate team assets?",
  team: "Select Team",
  agent_select: "Select Agent",
  task_select: "Select Task",
  agent_task: "Select Agent and Task", // legacy, rarely used in text mode (WB goes through the CC split path)
};

/** Step numbers of the 4 stages (used for the "Step N/4" hint). */
const STAGE_STEP: Record<FormStage, number> = {
  asset_confirm: 1,
  team: 2,
  agent_select: 3,
  task_select: 4,
  agent_task: 3, // legacy
};

/** Total number of steps in each session-init flow (used for the "Step N/4" hint). */
const TOTAL_STEPS = 4;

// The two option labels of asset_confirm — must be identical to ASSET_CONFIRM_YES/NO in workbuddy/form.ts:
// the CP3 parsing layer normalizes the user's reply into these two strings, and after injecting a fake tool_result
// the CB extractor can recognize them. They are re-declared here rather than imported, to keep text-form independent
// and testable; if the constants in form.ts change, the tests fail on both sides as a reminder to sync.
export const TEXT_ASSET_CONFIRM_YES_LABEL = "Yes, associate team assets";
export const TEXT_ASSET_CONFIRM_NO_LABEL = "No, do not associate this time";

/**
 * First-line marker in text-mode content, used for recognition on echo (if the injector layer later wants to strip the
 * initialization text it sent in the previous round, it can recognize it via this prefix).
 */
export const TEXT_FORM_MARKER = "[Session Init]";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RetryContext {
  /** The user's raw reply from the previous round (used to echo "Could not recognize your reply xxx"). */
  userReplyPreview?: string;
  /** Number of attempts so far (1-based, used for the "Attempt N" hint). */
  attemptCount?: number;
  /** Remaining attempts (used for the "will be skipped automatically after M more unrecognized replies" hint). */
  attemptsLeft?: number;
}

// ── Renderers per stage ────────────────────────────────────────────────────────

/**
 * Render the markdown text of the asset_confirm stage.
 */
export function renderAssetConfirmText(retry?: RetryContext): string {
  const header = renderHeader("asset_confirm", null, retry);
  const body = [
    "",
    "   1.  Yes, associate team assets",
    "   2.  No, do not associate this time",
    "",
    RULE_MINOR,
    "  How to reply: enter yes or no",
    "",
  ].join("\n");
  return header + body;
}

/**
 * Render the markdown text of the team stage.
 */
export function renderTeamText(teams: readonly TeamOption[], pageIndex: number, retry?: RetryContext): string {
  const p = computeTextPagination(teams, pageIndex);
  const header = renderHeader("team", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (t) => ({
    primary: t.team_name ?? t.team_id,
    secondary: t.team_id,
  }));
  const footer = renderFooter(p, "team", teams.length);
  return header + "\n" + body + "\n" + footer;
}

/**
 * Render the markdown text of the agent_select stage.
 *
 * @param teams          full list of teams (used to get agents from selectedTeamId)
 * @param selectedTeamId id of the selected team
 * @param pageIndex      current page index
 * @param retry          optional, retry context
 */
export function renderAgentText(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
  pageIndex: number,
  retry?: RetryContext,
): string {
  const team = findTeam(teams, selectedTeamId);
  const agents: readonly AgentInTeam[] = team?.agents ?? [];
  const p = computeTextPagination(agents, pageIndex);
  const header = renderHeader("agent_select", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (a) => ({
    primary: a.agent_name ?? a.agent_id,
    secondary: a.agent_id,
    tertiary: a.description,
  }));
  const footer = renderFooter(p, "agent", agents.length);
  return header + "\n" + body + "\n" + footer;
}

/**
 * Render the markdown text of the task_select stage.
 */
export function renderTaskText(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
  pageIndex: number,
  retry?: RetryContext,
): string {
  const team = findTeam(teams, selectedTeamId);
  const tasks: readonly TaskInTeam[] = team?.tasks ?? [];
  const p = computeTextPagination(tasks, pageIndex);
  const header = renderHeader("task_select", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (t) => ({
    primary: t.task_name ?? t.task_id,
    secondary: t.task_id || "(no task-id)",
    tertiary: t.isDefault ? "Default task" : undefined,
  }));
  const footer = renderFooter(p, "task", tasks.length);
  return header + "\n" + body + "\n" + footer;
}

// ── Bypass notice ──────────────────────────────────────────────────────────────

/**
 * Fallback notice after 3 consecutive unrecognized replies (called by CP4).
 */
export function renderBypassNotice(): string {
  return [
    RULE_MAJOR,
    `  ${TEXT_FORM_MARKER} Team asset association skipped`,
    RULE_MAJOR,
    "",
    "  The selection was not recognized after 3 attempts; this session will not be associated with team assets,",
    "  and subsequent conversation passes through directly.",
    "",
    "  To re-initialize, send `mem:session-reset`.",
    "",
  ].join("\n");
}

// ── Main dispatcher ────────────────────────────────────────────────────────────

export interface BuildTextFormOptions {
  /** Retry context (optional); pass undefined when it is not a retry. */
  retry?: RetryContext;
}

/**
 * Dispatch to the corresponding render function by formData.stage and output the complete markdown string.
 */
export function renderTextForm(data: FormData, options: BuildTextFormOptions = {}): string {
  const retry = options.retry;
  const pageIndex = data.pageIndex ?? 0;

  switch (data.stage) {
    case "asset_confirm":
      return renderAssetConfirmText(retry);
    case "team":
      return renderTeamText(data.teams, pageIndex, retry);
    case "agent_select":
    case "agent_task": // legacy: also rendered as agent
      return renderAgentText(data.teams, data.selectedTeamId, pageIndex, retry);
    case "task_select":
      return renderTaskText(data.teams, data.selectedTeamId, pageIndex, retry);
    default:
      // Unreachable in practice, but keep a graceful fallback.
      return renderBypassNotice();
  }
}

/**
 * Build the complete HTTP Response (stream or non-stream), putting the markdown of renderTextForm
 * into the content field of OpenAI chat.completions.
 */
export function buildWorkBuddyTextFormResponse(
  data: FormData,
  options: BuildTextFormOptions = {},
): Response {
  const markdown = renderTextForm(data, options);
  return buildTextContentResponse(markdown, data.modelId, data.stream === true);
}

/**
 * Build the Response for the bypass scenario (fallback text after 3 retries; used by CP4).
 */
export function buildBypassNoticeResponse(modelId?: string, stream = false): Response {
  return buildTextContentResponse(renderBypassNotice(), modelId, stream);
}

// ── HTTP Response Builders ─────────────────────────────────────────────────────

function buildTextContentResponse(content: string, modelId?: string, stream = false): Response {
  const model = modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "wb-session-init-text-" + Date.now();

  if (stream) {
    return buildStreamingContent(id, created, model, content);
  }
  return buildNonStreamingContent(id, created, model, content);
}

function buildNonStreamingContent(id: string, created: number, model: string, content: string): Response {
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function buildStreamingContent(id: string, created: number, model: string, content: string): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      // Chunk 2: content (sent all at once; no need to split by token, the client only needs to read the complete text)
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      // Chunk 3: finish
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })}\n\n`,
        ),
      );

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Internal helpers ───────────────────────────────────────────────────────────

interface OptionLine {
  primary: string;
  secondary?: string;
  tertiary?: string;
}

/**
 * Render the title block (rule + step number + subtitle pagination info / retry info).
 */
function renderHeader(stage: FormStage, pagination: ReturnType<typeof computeTextPagination> | null, retry?: RetryContext): string {
  const step = STAGE_STEP[stage];
  const title = STAGE_TITLES[stage];
  const isRetry = retry !== undefined;

  const lines: string[] = [];
  lines.push(RULE_MAJOR);

  if (isRetry) {
    // Retry title: highlight "could not recognize"
    const preview = truncatePreview(retry?.userReplyPreview);
    lines.push(`  ${TEXT_FORM_MARKER} Could not recognize your reply${preview ? ` "${preview}"` : ""}`);
    if (typeof retry?.attemptCount === "number") {
      const left = retry.attemptsLeft;
      const leftPart = typeof left === "number" && left > 0
        ? `, will be skipped automatically after ${left} more unrecognized reply(ies)`
        : "";
      lines.push(`  Attempt ${retry.attemptCount}${leftPart}`);
    }
    lines.push(RULE_MAJOR);
    lines.push("");
    lines.push(`  ${TEXT_FORM_MARKER} Step ${step}/${TOTAL_STEPS}: ${title}`);
    if (pagination && !pagination.isEmpty) {
      lines.push(`  Page ${pagination.currentPageIndex + 1} of ${pagination.totalPages}`);
    }
  } else {
    lines.push(`  ${TEXT_FORM_MARKER} Step ${step}/${TOTAL_STEPS}: ${title}`);
    if (pagination && !pagination.isEmpty) {
      lines.push(`  Page ${pagination.currentPageIndex + 1} of ${pagination.totalPages}`);
    }
    lines.push(RULE_MAJOR);
  }

  return lines.join("\n");
}

/**
 * Render the option list. Numbers are right-aligned (1..99 all align).
 *
 * ⚠️ Explicitly wrap it in a ```plaintext code fence:
 *   Our option lines themselves use an "  N.  xxx" prefix (3-4 spaces of indentation) — to the markdown
 *   renderer, lines 1-9 are indented by 4 spaces (triggering an indented-code-block), while lines 10+ have
 *   one less space of indentation and fall out of the code block; and the tertiary (description) sub-lines have a different indentation too.
 *   The result is that the workbuddy client wraps items 1-9 in a code chip while items 10+ and the description lines fall out
 *   as naked text (the "figure 1" symptom). After actively wrapping a ```plaintext fence, the whole segment is rendered with fenced
 *   code-block semantics, the number of in-line spaces no longer matters at all, and the look is consistent.
 */
function renderOptionList<T>(
  items: readonly T[],
  offset: number,
  extract: (item: T) => OptionLine,
): string {
  if (items.length === 0) {
    return "\n```plaintext\n  (the current list is empty)\n```\n";
  }

  const lines: string[] = ["", "```plaintext"];
  items.forEach((item, i) => {
    const absoluteIdx = offset + i + 1; // 1-based display index
    const line = extract(item);
    const numStr = `${absoluteIdx}.`.padStart(4, " ");
    // Main line: number + main label + ID (separated by " · ")
    const idPart = line.secondary ? `  ·  ${line.secondary}` : "";
    lines.push(`  ${numStr}  ${line.primary}${idPart}`);
    // Sub-line: description or label (indentation aligned)
    if (line.tertiary) {
      lines.push(`         ${line.tertiary}`);
    }
  });
  lines.push("```", "");
  return lines.join("\n");
}

/**
 * Render the action-hint area (reply instructions + the next/prev/skip keywords).
 *
 * Numeric addressing uses the **1-based index in the full list** (consistent with absoluteIdx in renderOptionList),
 * so the range hint must use `totalItems` (the full list length), not `currentPageItems.length`.
 * Example: task_select has 28 items over 3 pages; whichever page the user is on, the reply hint says "1..28".
 */
function renderFooter(
  pagination: ReturnType<typeof computeTextPagination>,
  _entity: "team" | "agent" | "task",
  totalItems: number,
): string {
  const lines: string[] = [];
  lines.push(RULE_MINOR);
  lines.push("  How to reply:");
  const pageRange = pagination.isEmpty
    ? "(empty)"
    : `1..${totalItems}`;
  lines.push(`    - a number (e.g. ${pagination.isEmpty ? "1" : "2"}, range ${pageRange})`);
  if (pagination.hasNext) {
    lines.push("    - next  --  show more");
  }
  if (pagination.hasPrev) {
    lines.push("    - prev  --  go back to the previous page");
  }
    lines.push("    - skip  --  do not associate team assets");
  lines.push("");
  return lines.join("\n");
}

function findTeam(teams: readonly TeamOption[], selectedTeamId: string | undefined): TeamOption | undefined {
  if (!selectedTeamId) return teams[0];
  return teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
}

function truncatePreview(s?: string, max = 40): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "...";
}

// ── Re-exports ─────────────────────────────────────────────────────────────────

export { TEXT_PAGE_SIZE };
