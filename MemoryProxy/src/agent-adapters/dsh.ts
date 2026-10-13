/**
 * deepseek-harness (dsh) client adapter.
 *
 * Capture evidence (2026-08-14, 6 real packets via mitmproxy; see
 * `docs/dsh-recon/2026-08-14-dsh-capture-analysis.md`):
 *
 *   - Protocol: **standard OpenAI Chat Completions** (`POST /chat/completions` + SSE),
 *     same family as codebuddy; body/messages shape 100% compatible (role:system/user/assistant/tool,
 *     tool_calls[] on assistant, separate role=tool messages carrying tool_call_id)
 *   - Client fingerprint (strong): `user-agent: deepseek-harness/*` (dsh attribution cannot be disabled)
 *     + `x-deepseek-harness-user-id` (anonymous UUID, constant) + `x-deepseek-harness-session-id`
 *     (session-<uuid>) + `x-deepseek-harness-compact:1` (only on compaction requests)
 *   - session_id is **only in the header**; the body has no fallback field (unlike codex's client_metadata);
 *     the proxy's sid extraction depends 100% on the header
 *   - assistant echoes back `reasoning_content` (a dsh trait, only on tool_calls turns),
 *     the proxy just passes it through; it does not affect the messages parser
 *
 * # Distinguishing the three request types (main / title / compaction)
 *
 * dsh main conversation / compaction / session-title all share the same `x-deepseek-harness-session-id`,
 * **only compaction has a dedicated header** (compact:1), title has none -- distinguished by body traits:
 *
 * | Category | header signal | body traits |
 * |---|---|---|
 * | compaction | `x-deepseek-harness-compact: 1` | — |
 * | title-gen | none | tools missing + thinking.disabled + max_tokens<=128 + system starts with "Create a concise title..." |
 * | main | none | other |
 *
 * classifyRequest priority: **compact header > title body-shape > main**;
 * the title criteria must **all three be satisfied** to count as aux (a single trait is easy to misjudge).
 *
 * # Two adaptation points
 *   - `classifyRequest`: three-signal decision (compact / title / main)
 *   - `extractUserText`: if content is a str, return it directly (dsh messages.content never uses blocks)
 *
 * # Differences from CB
 *   - dsh main conversation puts 4 role=user messages in body.messages: real user input +
 *     `<system-reminder>` workspace instructions + `runtime context` snapshot + `<available_skills>` list
 *     -- when the proxy extracts the str content of the last user message, taking the "first one from the back" suffices;
 *     the actual user input is usually in messages[1] (the first user message)
 *   - dsh user input itself **has no `<user_query>` wrapper like CB/workbuddy**, passed through directly
 */

import type { AgentAdapter, RequestKind } from "./types.js";
import { extractLastUserText } from "../common/user-text-extractor.js";

// ── Title-gen body-shape detection ───────────────────────────────────────────

/**
 * Fixed prefix of the system prompt of the dsh session-title-llm request.
 * Source: `packages/session/session-title-llm/src/index.ts:252-260` +
 * evidence from capture `fixtures/121918-*-9d056d.req.json`.
 *
 * Full opening of the dsh-side prompt:
 *   "Create a concise title for an AI coding-assistant session from the supplied human messages."
 *
 * Match on the prefix only, so the criterion does not break when upstream tweaks the prompt (punctuation / newlines).
 */
const DSH_TITLE_SYSTEM_PROMPT_PREFIX =
  "Create a concise title for an AI coding-assistant session";

/**
 * Max_tokens cap for dsh title-gen requests. Capture shows `max_tokens=64`;
 * leave 128 as some slack, so it doesn't drift after upstream tweaks.
 */
const DSH_TITLE_MAX_TOKENS_CEIL = 128;

/**
 * Determine whether a dsh request is title-gen (three body traits combined).
 *
 * All conditions must be met to count as aux. If any one fails, return false (avoids misjudging main).
 */
function isDshTitleGen(body: Record<string, unknown>): boolean {
  // Condition 1: tools missing or an empty array (main conversation always has 25+)
  const tools = body.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (hasTools) return false;

  // Condition 2: thinking.type === "disabled"
  const thinking = body.thinking as { type?: string } | undefined;
  if (thinking?.type !== "disabled") return false;

  // Condition 3: max_tokens <= 128
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== "number" || maxTokens > DSH_TITLE_MAX_TOKENS_CEIL) return false;

  // Condition 4: first system message content starts with the title prompt prefix
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (!first || first.role !== "system" || typeof first.content !== "string") return false;
  if (!first.content.startsWith(DSH_TITLE_SYSTEM_PROMPT_PREFIX)) return false;

  return true;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * User content shapes under the two dsh protocols:
 *   - v0.1.x(OpenAI Chat): `content: string`
 *   - v0.2+ (Anthropic Messages): `content: [{type:"text", text:"..."}, ...]`
 *
 * Reuses `extractLastUserText` (same as CC): a string is returned directly; for an array, scan from the back for the first
 * `type==="text"` block -- covering both the old dsh string style and the new dsh anthropic block style,
 * and incidentally skipping `<system-reminder>` metadata to take only the last real user utterance (dsh v0.2 Web UI
 * stuffs several environment-metadata blocks into user content just like CC).
 */
function extractDshUserText(content: unknown): string | null {
  return extractLastUserText(content);
}

// ── Adapter export ───────────────────────────────────────────────────────────

export const dshAdapter: AgentAdapter = {
  agentKind: "dsh",

  classifyRequest(
    body: Record<string, unknown>,
    _path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    // Signal 1 (strongest): compact header -- hardcoded in the dsh source at
    // `packages/llm/llm-deepseek/src/adapter.ts:290-293`, only included when
    // `purpose:'compaction'`, unambiguous
    if (headers?.["x-deepseek-harness-compact"] === "1") return "auxiliary";

    // Signal 2: title-gen body traits combined (see isDshTitleGen)
    if (isDshTitleGen(body)) return "auxiliary";

    // Everything else is main
    return "main";
  },

  extractUserText(content: unknown): string | null {
    return extractDshUserText(content);
  },
};
