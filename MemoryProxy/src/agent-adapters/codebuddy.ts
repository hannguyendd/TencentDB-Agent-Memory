/**
 * CodeBuddy client adapter.
 *
 * Capture evidence (2026-07-30, langfuse trace `d814929a67a1ca893c7b2b40c65ccd75`
 * session `f817ea40163c4dd89ee4f5a18bba9717`）：
 *
 *   - Protocol: **OpenAI** (`/codebuddy/{spaceId}/v1/chat/completions`), always streaming
 *   - `message.content` is **always a string** (the common shape for 3P LLMs); content-block arrays are never used
 *   - The string carries CB pseudo-XML wrappers:
 *       * `<user_info>`         first user message, OS/shell/workspace metadata
 *       * `<additional_data>`   every user message, auxiliary segments such as current_time
 *       * `<user_query>...</user_query>`  **anchor for what the user actually typed**
 *       * `<question_answer>` / `<title>` / `<questions>` / `<answers>`
 *                              session-init form backfill
 *   - assistant message content is often the placeholder `"-"` (when the LLM only calls tools and outputs no text)
 *   - **No `cache_control` marker, no fork/sidequery concept** -- the CC three-way split
 *     does not apply to CB at all; every request is `main`
 *   - Tools are a stable 26 (`list_dir` / `search_file` / `read_file` / `execute_command` ...)
 *   - CB-specific headers: `x-agent-intent` / `x-conversation-id` /
 *     `x-conversation-message-id` / `x-conversation-request-id`
 *
 * Two adaptation points:
 *   - `classifyRequest`: always `"main"` (backed by capture evidence, no longer a "stub fallback")
 *   - `extractUserText`: uses the shared `extractUserQueryText` (prefers the `<user_query>`
 *     block; otherwise what remains after stripping wrappers. Shares the same
 *     semantics as tdai L0 / mem-command to avoid drift between places)
 *
 * See the appendix (CodeBuddy analysis) of docs/design/2026-07-30-cc-request-routing-plan.md.
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const codebuddyAdapter: AgentAdapter = {
  agentKind: "codebuddy",

  classifyRequest(_body?, _path?, _headers?) {
    // Capture evidence: CB requests have no cache_control marker, tools are a stable 26, and there are no CC
    // fork/sidequery routing traits. All requests are main conversation, going through the full path (injection + L0 + skill).
    return "main";
  },

  extractUserText(content) {
    // CB content is always a string. If CB suddenly switches to arrays in the future, fall back to the
    // default (concatenate all text blocks) rather than crash.
    if (typeof content !== "string") {
      return defaultAdapter.extractUserText(content);
    }
    const extracted = extractUserQueryText(content);
    return extracted.length > 0 ? extracted : null;
  },
};
