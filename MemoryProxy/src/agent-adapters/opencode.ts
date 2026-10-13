/**
 * opencode client adapter.
 *
 * OpenCode 1.x uses `@ai-sdk/openai-compatible`; OpenCode 2.0 uses
 * `@opencode/ai/providers/openai-compatible`. Both reach this adapter through
 * OpenAI Chat Completions. Responses/Anthropic runtimes are separate paths.
 *
 * # Differences from existing openai-chat clients
 *
 *   - CodeBuddy: content is always a string, with `<user_query>` / `<additional_data>`
 *     / `<user_info>` wrappers -- must go through `extractUserQueryText` to strip them
 *   - dsh: content is always a string, **bare text** with no wrapper -- returned directly
 *   - OpenCode 2.0.18 local CLI verified: the last user content of the main request is bare text;
 *     the title-generation request in the same turn uses the same endpoint, but its system prompt has a fixed title-generation marker.
 *
 *   Conservative strategy: go through `extractUserQueryText`.
 *   -- That function returns a plain string without wrapper as-is, and can also handle a wrapper
 *      if opencode ever adds one (forward-compatible); zero regression in both shapes.
 *
 * # Two adaptation points
 *   - `classifyRequest`: OpenCode 2.0's title-generation request is auxiliary
 *   - `extractUserText`: string or text-block array -> merge, then strip non-user context
 *
 * Keep a dedicated adapter so OpenCode request classification and telemetry
 * can evolve independently from CodeBuddy.
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const opencodeAdapter: AgentAdapter = {
  agentKind: "opencode",

  classifyRequest(body) {
    // OpenCode 2.0.18 sends title generation to the same chat/completions
    // endpoint as the main conversation. Its first system message carries
    // this distinct marker; keep that request out of memory/session effects.
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const first = messages[0] as Record<string, unknown> | undefined;
    if (first?.role === "system" && typeof first.content === "string"
      && first.content.startsWith("You are a title generator. You output ONLY a thread title.")) {
      return "auxiliary";
    }
    return "main";
  },

  extractUserText(content) {
    // Chat Completions currently sends a string; content-blocks are also
    // accepted without letting injected text bypass the same cleanup.
    const raw = typeof content === "string" ? content : defaultAdapter.extractUserText(content);
    if (!raw) return null;
    const extracted = extractUserQueryText(raw);
    return extracted.length > 0 ? extracted : null;
  },
};
