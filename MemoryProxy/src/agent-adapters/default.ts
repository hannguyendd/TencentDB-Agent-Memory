/**
 * Default agent adapter -- the **conservative fallback** for unknown/unrecognized clients (cursor / windsurf / user-defined
 * SDKs, etc.), with behavior equivalent to the old logic before the refactor:
 *   - classifyRequest: always returns "main" (no routing split)
 *   - extractUserText: concatenates all text blocks in the content array
 *
 * When adding support for a new client, write a separate adapter for it (see claude-code.ts)
 * and add a branch in the factory in index.ts.
 */

import type { AgentAdapter } from "./types.js";

/**
 * Concatenates all text blocks in the content array into a string, equivalent to the existing `contentToString`.
 * - string input -> returned as-is
 * - array input -> collect each block's text and join with "\n"
 * - anything else -> null
 */
function joinAllTextBlocks(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export const defaultAdapter: AgentAdapter = {
  agentKind: "unknown",
  classifyRequest(_body?, _path?, _headers?) {
    return "main";
  },
  extractUserText(content) {
    return joinAllTextBlocks(content);
  },
};
