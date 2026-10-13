/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import type { Context } from "hono";

/**
 * Extract conversation ID from request headers. Returns null if no valid ID found.
 *
 * ── subagent session normalization (2026-09-20, fixes the endless form-popup loop after WorkBuddy compaction) ──
 * When the WorkBuddy assistant spawns parallel subagents, each subagent uses a **separate new x-conversation-id**,
 * but carries `x-parent-conversation-id` pointing to the parent (main) conversation. If the session key were
 * derived from the subagent's own conversation-id, the session store would not find the completed
 * session-init (initialized binding) of the main conversation, so every subagent would be treated as a "new conversation" → the
 * "Select Agent/Task" form pops up again; the form is then replayed into history → endless loop.
 *
 * Fix: **subagent requests (carrying x-parent-conversation-id) always use the parent id as
 * the conversation identity** — subagents reuse the main conversation's session key and naturally inherit the agent/task/team
 * binding, so session-init is no longer triggered. Main-conversation requests have no such header, so behavior is unchanged (zero intrusion).
 *
 * Empirical evidence (opik 2026-09-14 + local packet capture 2026-09-20):
 *   main     : x-conversation-id=888a1848..  x-parent-conversation-id=(none)  purpose=conversation type=main
 *   subagent : x-conversation-id=01a0bcff..  x-parent-conversation-id=888a1848.. purpose=subagent:general-purpose type=team
 *   → subagent.parent === main.conv, so the parent is used to normalize to the main conversation identity.
 */
export function resolveConversationId(c: Context): string | null {
  // Subagents prefer parent-conversation-id to normalize to the parent (main) conversation identity.
  const parentId = c.req.header("x-parent-conversation-id");
  if (parentId && parentId.length > 0) return parentId;

  const id =
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-claude-code-session-id") ?? // Claude Code CLI sends this
    c.req.header("x-deepseek-harness-session-id") ?? // dsh (deepseek-harness) CLI/web sends this
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    null;
  return id && id.length > 0 ? id : null;
}

/** Check whether the messages look like a fresh conversation (at most 1 user message, no assistant/tool). */
export function isFreshConversation(
  messages: Array<{ role?: string }>,
): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = m.role ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role === "user") userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}
