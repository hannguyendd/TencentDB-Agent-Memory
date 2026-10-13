import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText } from "../common/user-query-extractor.js";

/**
 * Extracts the "real user question" from the last user message and writes it to L0.
 *
 * Background: besides the real question, user messages from coding agents such as CodeBuddy / Claude Code / DSH
 * carry a lot of harness context (<additional_data>, current_time, <system_reminder>,
 * DSH's `Current runtime context.` snapshot, etc.). Writing the whole message to L0 as-is would
 * pollute memory with this noise, which differs every turn and has very low retrieval value. So only the real question is kept.
 *
 * The extraction algorithm lives in `common/user-query-extractor.ts` (shared by the tdai / mem-command /
 * codebuddy adapters to avoid semantic drift); this module only handles these steps: take the last
 * user message -> extract the query text -> assemble a TdaiMessage.
 */

// Keep the re-export so downstream import paths (including unit tests) don't force a sweeping change.
export { extractUserQueryText };

export function extractLatestUserMessage(messages: unknown[]): TdaiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    // Only take the real user_query, to avoid writing harness context into L0
    const content = extractUserQueryText(extractContentText(msg.content));
    if (content.trim()) return { role: "user", content };
  }
  return null;
}

export async function recordTdaiTurn(client: TdaiClient, identity: TdaiIdentity | null, userMessage: TdaiMessage | null, assistantContent: string | null | undefined): Promise<void> {
  if (!identity || !userMessage) return;
  const messages: TdaiMessage[] = [userMessage];
  if (assistantContent?.trim()) {
    messages.push({ role: "assistant", content: assistantContent });
  }
  await client.addConversation(identity, messages);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const p = part as Record<string, unknown>;
      if (p.type !== "text" && p.type !== "input_text") return "";
      return typeof p.text === "string" ? p.text : "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
