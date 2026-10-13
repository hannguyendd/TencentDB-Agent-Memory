/**
 * Internal utility functions for mem-command.
 *
 * Currently only extractSimpleMessages -- normalizes the handler layer's body.messages (protocol-native shape)
 * into the minimal { role, content } format consumed by task-draft-generator.
 *
 * Three protocol shapes are supported (the same function input accepts all of them):
 *   - OpenAI (CC/CB):        body.messages = [{ role, content: string }]
 *   - Anthropic (CC native):    body.messages = [{ role, content: string | Array<{type:"text",text}|...> }]
 *   - Responses (Codex/WB):  body.input    = [{ type:"message", role,
 *                              content: [{type:"input_text"|"output_text", text}] }, ...]
 *
 * Main differences of the Responses API from the other two:
 *   1. content blocks use `type:"input_text"` / `type:"output_text"` instead of `type:"text"`
 *   2. each message has an extra outer `type:"message"` wrapper
 *   3. input[] also contains non-message items such as function_call / function_call_output -- only messages are taken
 *
 * The function auto-detects all three shapes, so callers do not need to distinguish them.
 */

import type { MemCommandMessage } from "./types.js";

/**
 * Extract plain text from a content array.
 * Three block types are supported:
 *   - {type:"text", text}         (Anthropic)
 *   - {type:"input_text", text}   (Responses API user/system messages)
 *   - {type:"output_text", text}  (Responses API assistant messages)
 * Blocks of unknown types are ignored (e.g. tool_use / function_call / image ...).
 */
function joinContentBlocks(content: unknown[]): string {
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;
    if ((t === "text" || t === "input_text" || t === "output_text") && typeof b.text === "string") {
      texts.push(b.text);
    }
  }
  return texts.join("\n");
}

/**
 * Extract the minimal { role, content } shape from any messages array.
 *
 * Fault tolerance:
 * - not an array / empty -> return []
 * - role not in ["user","assistant","system"] -> skip the entry
 * - Responses API item with a type field other than "message" (e.g. "function_call" / "function_call_output") -> skip
 * - content is an array -> merge all text/input_text/output_text segments (other types ignored)
 * - content is an empty string -> skip the entry
 */
/**
 * Compress a mem command's args into a short one-line log snippet, for [mem-command] log tracing.
 *
 * - newlines / consecutive whitespace -> single space
 * - longer than max (default 40) -> truncate the tail and append "..."
 * - empty / whitespace-only -> return an empty string (the caller decides whether to include it in the log)
 *
 * Note: this is for logging only and must never be parsed back to the original; args may contain
 * sensitive / multi-line content and must pass through this before being displayed.
 */
export function truncateArgs(args: string | undefined | null, max = 40): string {
  if (!args) return "";
  const oneLine = String(args).replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "";
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "...";
}

export function extractSimpleMessages(input: unknown): MemCommandMessage[] {
  if (!Array.isArray(input)) return [];

  const out: MemCommandMessage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;

    // Responses API: keep only type=message, skip function_call / function_call_output etc.
    // (OpenAI / Anthropic messages have no type field, so this check is a no-op for them)
    if (typeof m.type === "string" && m.type !== "message") continue;

    const role = typeof m.role === "string" ? m.role : "";
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    let content = "";
    const c = m.content;
    if (typeof c === "string") {
      content = c;
    } else if (Array.isArray(c)) {
      content = joinContentBlocks(c);
    }

    content = content.trim();
    if (content.length === 0) continue;

    out.push({ role, content });
  }
  return out;
}
