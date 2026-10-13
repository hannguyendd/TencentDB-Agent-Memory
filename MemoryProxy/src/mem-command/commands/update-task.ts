/**
 * mem:update-task - update the bound Task.
 *
 * Interaction (user confirmation is required every time):
 *
 *   ┌ session not bound -> blocked, guide to mem:create-task
 *   ├ first call (no confirm/cancel subcommand):
 *   │    with args -> description replaced directly (skip LLM) -> write pending -> preview
 *   │    no args -> LLM diffs to generate new desc + status suggestion -> write pending -> preview
 *   │            LLM judges changed=false -> return "no update needed", do not write pending
 *   ├ `mem:update-task confirm` -> take from pending -> updateTask (status passed through) -> clear pending
 *   └ `mem:update-task cancel`  -> clear pending
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  updateTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(empty)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeUpdateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const recentMessages = ctx.bodyMessages ?? [];
  const rawArgs = (ctx.args ?? "").trim();

  const finalize = (
    messageText: string,
    success: boolean,
    data: Record<string, unknown>,
  ): MemCommandResult => {
    const response = buildMemResponse(messageText, {
      protocol: ctx.protocol,
      stream: ctx.stream,
      requestId,
      thinking: ctx.thinking,
    });
    return { success, messageText, data, response };
  };

  const subcommand = parseSubcommand(rawArgs);

  // ── confirm ─────────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ No pending Task update (it may have timed out or been cancelled). Please run \`mem:update-task [addition]\` again.`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Failed to update Task: ${result.error ?? "unknown error"}`,
        false,
        { reason: "update_failed", detail: result.error },
      );
    }

    return finalize(
      `✅ Task updated.\n\n` +
        `- **Title**: ${result.title} (immutable)\n` +
        `- **Status**: ${result.status ?? "running"}\n` +
        `- **New description**: ${trimDesc(result.description)}\n` +
        `- **Task ID**：\`${result.taskId}\``,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
      },
    );
  }

  // ── cancel ──────────────────────────────────────────────────────────────
  if (subcommand === "cancel") {
    const result = await cancelPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });
    if (!result.success) {
      return finalize(
        `⚠️ Cancel failed: ${result.error ?? "unknown"}`,
        false,
        { reason: "cancel_failed", detail: result.error },
      );
    }
    const msg = result.cancelled
      ? `✅ Pending Task update cancelled.`
      : `ℹ️ There is no pending Task update.`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // ── first call ────────────────────────────────────────────────────────────

  const directDescription = rawArgs.length > 0 ? rawArgs : undefined;

  if (!directDescription && recentMessages.length === 0) {
    return finalize(
      `⚠️ This request carries no conversation messages; the no-argument form of \`mem:update-task\` needs recent conversation as context.` +
        `\n\nYou can directly run: \`mem:update-task <your additional description>\` to specify the new description manually.`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await updateTaskFromSession({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    recentMessages,
    // Option D: the taskDraft LLM follows the main model -- pass through the client's current model / upstream / apiKey
    // upstreamProtocol is independent of ctx.protocol (the latter only controls the response-rendering SSE skeleton format,
    // while the former decides whether the taskDraft request hits /messages | /chat/completions | /responses).
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.upstreamUrl ? { upstreamUrl: ctx.upstreamUrl } : {}),
    ...(ctx.upstreamProtocol ? { protocol: ctx.upstreamProtocol } : {}),
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    ...(directDescription ? { directDescription, hint: rawArgs } : {}),
  });

  // Not bound
  if (!result.success && result.error?.includes("no task bound")) {
    return finalize(
      `⚠️ The current session is not bound to a Task yet. Please run \`mem:create-task\` to create a Task first, then update it.`,
      false,
      { reason: "no_task_bound" },
    );
  }

  // Cross-user update: not supported by the kernel; the proxy rejects it early and suggests creating a new one
  if (!result.success && result.error === "not_creator") {
    return finalize(
      `❌ Cannot update: this Task was not created by you, and cross-user edits are not currently supported.\n\n` +
        `If you need to create a Task of your own based on the current session, use \`mem:create-task\`.`,
      false,
      { reason: "not_creator" },
    );
  }

  // Other errors
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = directDescription
      ? ""
      : "\n\nYou can:\n1. Retry later\n2. `mem:update-task <your addition>` to specify the new description manually";
    return finalize(
      `❌ Failed to update Task: ${detail}${hintLine}`,
      false,
      { reason: "update_failed", detail },
    );
  }

  // LLM judged no update needed
  if (result.noUpdateNeeded) {
    return finalize(
      `ℹ️ Task needs no update -- the recent conversation produced no new progress or scope changes.\n\n` +
        `Task ID: \`${result.taskId}\`\n` +
        `You can run \`mem:update-task [addition]\` again later to re-trigger the check, or pass arguments to force an update.`,
      true,
      { reason: "no_update_needed", task_id: result.taskId },
    );
  }

  // First call: pending preview
  if (result.pending && result.pending.kind === "update") {
    const p = result.pending;
    const statusLine = p.statusSuggestion
      ? `\n- Suggested status: ${p.statusSuggestion}`
      : "";
    return finalize(
      `📝 Update preview for Task "${p.currentTitle ?? p.taskId}":\n\n` +
        `- New description: ${trimDesc(p.draftDescription)}${statusLine}\n\n` +
        `Reply \`mem:update-task confirm\` to confirm, or \`mem:update-task cancel\` to cancel.`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "update",
          task_id: p.taskId,
          draft_description: p.draftDescription,
          ...(p.statusSuggestion ? { status_suggestion: p.statusSuggestion } : {}),
          ...(p.currentTitle ? { current_title: p.currentTitle } : {}),
          ...(p.currentStatus ? { current_status: p.currentStatus } : {}),
        },
      },
    );
  }

  // Fallback (should be unreachable): return the current state
  return finalize(
    `ℹ️ No changes to Task.\n\nTask ID: \`${result.taskId}\``,
    true,
    { task_id: result.taskId },
  );
}
