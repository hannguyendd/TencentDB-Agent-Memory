/**
 * dsh Session Init Form — carrier for the `ask_user_question` tool_call.
 *
 * When the dsh (deepseek-harness) client runs in preset scenarios (web-app + standard/code/cordis
 * and other presets), it automatically mounts `@deepseek-ai/dsh-tool-ask-user`, adding an
 * `ask_user_question` tool to the main conversation's tools array (see the dsh source
 * `packages/interaction/tool-ask-user/src/index.ts`).
 *
 * The proxy-side session-init form reuses this native dsh tool name directly and fakes an
 * assistant tool_call SSE so the client UI renders the options.
 *
 * # Differences from the workbuddy form (3 shape differences + tool name)
 *   - tool_name: `AskUserQuestion` → `ask_user_question`
 *   - multiSelect (camelCase) → multi_select (snake_case)
 *   - every question requires an `id` (hard constraint of the dsh schema, echoed in answer)
 *   - the top-level `questions[]` can carry multiple questions at once (workbuddy/CC usually send one;
 *     to match the dsh schema the array structure is kept, a single question is a one-element array)
 *
 * # Transport (dual protocol)
 *   - dsh v0.1.x (old llm-deepseek adapter): **OpenAI /v1/chat/completions**
 *   - dsh v0.2+ (new llm-deepseek-api-key adapter, verified by packet capture 2026-09-29):
 *     **Anthropic /v1/messages** (headers carry `anthropic-version: 2023-06-01`,
 *     path is `${baseURL}/v1/messages`, see the dsh source
 *     `packages/llm/llm-deepseek/src/adapter.ts:120-131`)
 *   - the branch is decided by FormData.protocol: "anthropic" | "openai"|undefined (=openai)
 *   - SSE stream or non-stream (consistent with the request's `body.stream`)
 *   - the openai skeleton is copied from workbuddy; the anthropic skeleton is copied from claude-code/form.ts
 *     (message_start → thinking block → tool_use block → message_stop)
 *
 * # State machine
 *   - fully reuses the CB state machine (session/codebuddy/init.ts), same pattern as workbuddy;
 *     the stage values (asset_confirm / team / agent_select / task_select / agent_task)
 *     are identical to CB and passed through directly
 *
 * # tool_call id prefix
 *   - `call_dsh_session_init_` — distinct from CB (`call_session_init_`),
 *     workbuddy (`call_wb_session_init_`), codex (`fc_codex_session_init_`)
 *
 * # Packet-capture schema basis
 *   - `docs/dsh-recon/fixtures/dsh-tool-catalog-schema.json`
 *   - dsh source `packages/interaction/tool-ask-user/src/index.ts`
 */

import type { TeamOption } from "../types.js";
// The dsh (deepseek-harness) ask_user_question UI has no upper limit on the number of options
// (source packages/interaction/tool-ask-user/src/index.ts + UI QuestionComposer.tsx
// both render via a direct map, with no truncation). So the dsh form **does not paginate**; team/agent/task are all included.
// By contrast: CC strictly requires <=4 options (internal AskUserQuestion validation), so it must paginate; codex has a similar
// limit; CB has no limit and does not paginate. dsh belongs to the "UI without limit" class.
// See: MemoryProxy/docs/dsh-recon/2026-08-14-dsh-integration-notes.md pitfall #9.

// ── Constants ──────────────────────────────────────────────────────────────────

/** Native dsh tool name. **Do not** change it to CC's `AskUserQuestion` — the dsh preset mounts the snake_case one. */
export const TOOL_NAME = "ask_user_question";
export const TOOLCALL_PREFIX = "call_dsh_session_init_";

export const TEAM_FORM_TITLE = "Session Init — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Init — Select Agent and Task";
export const RETRY_FORM_TITLE = "Could not recognize your selection, please select again";

export const SKIP_LABEL = "Do not associate this time (skip injection, pass through)";
// dsh does not paginate; MORE_LABEL is kept only for backward compatibility (tests or a future switch to pagination); it is not currently produced.
export const MORE_LABEL = "More →";

/**
 * Placeholder reasoning_content for the fake tool_call assistant message.
 *
 * ## Why it must be non-empty
 *
 * dsh `serialize.ts:99` passes reasoning_content back to the upstream body only when
 * `toolCalls.length > 0 && reasoning.length > 0`. dsh `translate.ts:133` inbound parsing is the same:
 * a reasoning block is opened only when `reasoning_content.length > 0` — **an empty string is swallowed outright**.
 *
 * An empty string `""` = the client parses a block with `text: ""` → length is 0 after serialize join
 * → the upstream body lacks reasoning_content → deepseek thinking mode hard-validates with 400
 * `The reasoning_content in the thinking mode must be passed back to the API`.
 *
 * Stuffing in a non-empty placeholder makes the client really open a reasoning block, which is carried along on the next replay.
 * The value itself has no effect on the model (the fake session-init never actually goes through the model anyway).
 *
 * See docs/dsh-recon/2026-08-14-dsh-integration-notes.md pitfall #7.
 */
const REASONING_PLACEHOLDER = "[proxy session-init form]";

/**
 * anthropic branch only: fixed placeholder signature for the fake `thinking` block.
 *
 * Fully equivalent to THINKING_SIGNATURE_PLACEHOLDER in claude-code/form.ts — the same
 * base64 string, the same compliance rationale:
 *   - DeepSeek's official Anthropic-compatible endpoint, in thinking mode, strictly checks that history assistant
 *     messages carry a thinking block, otherwise 400
 *     `The content[].thinking in the thinking mode must be passed back to the API`
 *   - the proxy's own `sanitizeThinkingBlocks` (`anthropicHandler.ts:280`) requires the
 *     signature to satisfy `^[A-Za-z0-9+/=]+$` + length >= 40 + not a UUID — this value satisfies all of them
 *   - the real Anthropic upstream only performs crypto validation when the request itself enables thinking mode; the fake
 *     session-init never actually goes through the model
 *
 * For a detailed analysis see the comment on THINKING_SIGNATURE_PLACEHOLDER at claude-code/form.ts:83.
 */
const THINKING_SIGNATURE_PLACEHOLDER =
  "UHJveHlDQ1Nlc3Npb25Jbml0RmFrZVRoaW5raW5nUGxhY2Vob2xkZXJTaWc=";

export const ASSET_CONFIRM_YES = "Yes, associate team assets";
export const ASSET_CONFIRM_NO = "No, do not associate this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session Init — Associate Team Assets?";

/**
 * Generic note appended to the end of each step's question.
 * The dsh ask_user_question UI also supports an "Other"/free-text fallback (see dsh docs §3.4,
 * the `custom` field); replying "skip / 跳过 / 不关联" goes through the SKIP_RE bypass.
 * The wording is unified across the five clients: claude-code/workbuddy/codex/codebuddy/dsh.
 */
const SKIP_HINT = ' (Please choose the best-matching option; custom input is not currently supported. If you choose to skip, this Session will not inject team assets)';

/** Returns true if the given string contains any dsh form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a dsh session-init form. */
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
  /** @deprecated dsh does not paginate (see the file header); the field is kept so session/index.ts dispatch can pass it through for compatibility; the builder ignores it. */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  /**
   * Transport protocol — decides which SSE skeleton buildFormResponse uses.
   *   - "anthropic" (dsh v0.2+ llm-deepseek-api-key adapter): message_start
   *     → thinking → tool_use SSE
   *   - "openai" or undefined (dsh v0.1.x old adapter): chat.completion.chunk
   *     tool_calls SSE
   * Passed through by the handler layer when it builds reqCtx: anthropicHandler.ts passes "anthropic",
   * handler.ts passes "openai" (see the dsh dispatch in session/index.ts).
   */
  protocol?: "openai" | "anthropic";
}

// ── ask_user_question input schema (dsh snake_case + required id) ──────────────────

interface DshAskQuestionOption {
  label: string;
  description: string;
}

interface DshAskQuestion {
  /** Hard requirement of the dsh schema, echoed in answer; the proxy generates a stable id (a short label of the question name). */
  id: string;
  question: string;
  header: string;
  options: DshAskQuestionOption[];
  /** dsh uses snake_case, unlike CC's multiSelect camelCase. */
  multi_select: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: DshAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: DshAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: "asset_confirm",
      question: titlePrefix + "Do you want to associate team assets with this conversation?" + SKIP_HINT,
      header: "Team assets",
      options: [
        { label: ASSET_CONFIRM_YES, description: "Select Team / Agent / Task and inject the team context" },
        { label: ASSET_CONFIRM_NO, description: "Inject nothing this time; pass through directly" },
      ],
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // dsh has no upper limit on options; render everything, no pagination (see the file header comment).
    const teamOpts: DshAskQuestionOption[] = teams.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[dsh form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      id: "team_select",
      question: titlePrefix + "Please select the Team for this session:" + SKIP_HINT,
      header: "Team",
      options: teamOpts,
      multi_select: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    // dsh has no upper limit on options; render everything, no pagination.
    const combinedOptions: DshAskQuestionOption[] = team.agents.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (combinedOptions.length < 2) {
      throw new Error(
        `[dsh form] agent stage requires ≥2 agents (got ${combinedOptions.length}). ` +
          `Caller must handle single-agent auto-select upstream.`,
      );
    }

    questions.push({
      id: "agent_select",
      question: titlePrefix + `Please select the Agent to use under "${team.team_name}":` + SKIP_HINT,
      header: "Agent",
      options: combinedOptions,
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    // dsh has no upper limit on options; render everything, no pagination.
    // team.tasks[0] is the virtual default task ("Skip for now"), unshifted once at the source,
    // and with no pagination it will not appear at the start of every page like the old version (pitfall doc §6 pitfall #9).
    const taskOpts: DshAskQuestionOption[] = team.tasks.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (taskOpts.length < 2) {
      throw new Error(
        `[dsh form] task stage requires ≥2 tasks (got ${taskOpts.length}). ` +
          `Default task should always be prepended by fetchTeamsAndAgents.`,
      );
    }

    questions.push({
      id: "task_select",
      question: titlePrefix + `Please select the task to associate under "${team.team_name}":` + SKIP_HINT,
      header: "Task",
      options: taskOpts,
      multi_select: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a dsh `ask_user_question` fake form response.
 *
 * Dual-protocol branches (see FormData.protocol):
 *   - "anthropic" (dsh v0.2+ llm-deepseek-api-key adapter): Anthropic SSE
 *   - "openai" or undefined (dsh v0.1.x old adapter): OpenAI chat.completion(.chunk)
 * The arguments shape is identical: native dsh
 *   `{questions: [{id, question, header, options, multi_select}]}`.
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const input = buildAskUserQuestionArgs(data);
  const argsStr = JSON.stringify(input);

  if (data.protocol === "anthropic") {
    // dsh v0.2+ uses anthropic /v1/messages (dsh llm-deepseek-api-key adapter,
    // verified by packet capture 2026-09-29; see the "Transport" section in the file header).
    // No non-stream branch: the dsh anthropic adapter hardcodes `accept: text/event-stream`
    // (adapter.ts:124), so the real client always uses SSE; any possible non-stream probe path
    // simply reuses the SSE response, and the anthropic SDK can still collect it all at once.
    const msgId = "msg_dsh_session_init_" + Date.now();
    const toolUseId = TOOLCALL_PREFIX + Date.now();
    return buildAnthropicStreamingResponse(msgId, model, toolUseId, argsStr);
  }

  // openai branch (old dsh v0.1.x / future openai-shape clients)
  const created = Math.floor(Date.now() / 1000);
  const id = "dsh-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

// ── Anthropic Streaming(dsh v0.2+ /v1/messages) ─────────────────────────────

/**
 * Anthropic SSE skeleton, fully symmetric with claude-code/form.ts buildFormResponse.
 * Three key layers:
 *   1. thinking block (index 0): emitted unconditionally, to prevent DeepSeek thinking-mode 400
 *   2. tool_use block (index 1): native dsh `ask_user_question` name + full input
 *   3. message_delta stop_reason=tool_use
 */
function buildAnthropicStreamingResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  inputJson: string,
): Response {
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

      // ── Fake `thinking` block (index 0) ──────────────────────────────────
      // Emitted unconditionally — DeepSeek's official Anthropic-compatible endpoint, in thinking mode, strictly checks that
      // history assistant messages carry a thinking block, otherwise 400. See the comment on
      // the THINKING_SIGNATURE_PLACEHOLDER constant.
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
        // Hard constraint of deepseek thinking mode — see the REASONING_PLACEHOLDER definition for the full analysis.
        // Key point: it must be **non-empty**, otherwise the client's translate.ts:133 swallows it on the `reasoning.length > 0`
        // check, and serialize.ts:99 on the output side sees length 0 → the upstream body lacks the field → 400.
        reasoning_content: REASONING_PLACEHOLDER,
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
      // Chunk 1: role + tool_call declaration (empty arguments) + reasoning_content
      // reasoning_content must be **non-empty** (value = REASONING_PLACEHOLDER) — an empty string is
      // swallowed by dsh translate.ts:133, not passed back during serialize, and upstream returns 400.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            reasoning_content: REASONING_PLACEHOLDER,
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
