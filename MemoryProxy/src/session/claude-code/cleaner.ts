/**
 * Claude Code Session Init — LastUser text extractor.
 *
 * This file used to contain `stripInitArtifacts`, which stripped the fake form
 * conversation after session_init completed (so the LLM would not see the form interaction). **That feature has been removed**: all real user
 * conversation (including the session_init form interaction) is now always kept, with nothing deleted.
 *
 * Only one export remains: `getLastUserMessageText`, used by the session_init
 * state machine to read the text of the last user / tool message and parse the user's selection.
 */

import { containsFormTitle } from "./form.js";

interface RawMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get text from last tool message containing Claude Code form answer data.
 *
 * Prefer the most recent role=tool message containing form answer keywords (AskUserQuestion /
 * multi_question_result / form title) -- this is the tool_result carrier Claude Code uses to report the user's
 * selection; fall back to the most recent user message.
 */
export function getLastUserMessageText(messages: RawMessage[]): string {
  // Priority: tool messages with real answer data (JSON)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") {
      const text = getMessageText(messages[i]);
      if (text && (text.includes("AskUserQuestion") || text.includes("multi_question_result") || containsFormTitle(text))) {
        return text;
      }
    }
  }

  // Fallback: last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return getMessageText(messages[i]);
    }
  }
  return "";
}

function getMessageText(msg: RawMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content as AnthropicBlock[]) {
      const type = raw.type;
      if (type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
        continue;
      }
      if (type === "tool_result") {
        const inner = raw.content;
        if (typeof inner === "string") {
          parts.push(inner);
        } else if (Array.isArray(inner)) {
          for (const c of inner as AnthropicBlock[]) {
            if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
          }
        }
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}
