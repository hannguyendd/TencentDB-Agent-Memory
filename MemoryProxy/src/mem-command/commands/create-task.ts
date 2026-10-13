/**
 * mem:create-task - generate a Task from the current session context and bind it to this session.
 *
 * Interaction (aligned with the TAPD requirement's "user confirmation" gate):
 *
 *   ┌ session not bound to a real task:
 *   │    no args -> LLM generates title+desc -> persist + bind directly (no confirm needed)
 *   │    with args -> title = user argument (<=40 chars), LLM only generates desc -> persist + bind directly
 *   │            LLM failure -> degrade: desc left empty, the task is still persisted
 *   │
 *   ├ session already bound to a real task:
 *   │    generate a new draft -> write to pending-store (TTL 5 minutes) -> return "preview + three-option guidance":
 *   │      1) mem:create-task confirm — override binding, create new
 *   │      2) mem:update-task [new description] - keep using the current Task and only update its description
 *   │      3) mem:create-task cancel - revoke
 *   │
 *   ├ `mem:create-task confirm`：
 *   │    take the draft from pending -> create a new task -> override the session binding -> clear pending
 *   │
 *   └ `mem:create-task cancel`：
 *        clear pending, do not persist
 *
 * Argument parsing:
 *   - `confirm` / `cancel` (case-insensitive) on their own are treated as subcommands
 *   - any other args are used as lockedTitle (the title hint of the first call)
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  createTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;
const TITLE_MAX_LEN = 40;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(empty)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function truncateTitle(raw: string): string {
  const s = raw.trim();
  return s.length > TITLE_MAX_LEN ? s.slice(0, TITLE_MAX_LEN) : s;
}

/** Determine whether args is a confirm / cancel subcommand. Only matches when strictly equal after trim. */
function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeCreateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
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

  // ── confirm branch ────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ No pending Task action (it may have timed out or been cancelled). Please run \`mem:create-task [title]\` again.`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Failed to create Task: ${result.error ?? "unknown error"}`,
        false,
        { reason: "create_failed", detail: result.error },
      );
    }

    const prevLine = result.previousTaskId
      ? `\n\n(Previously bound Task \`${result.previousTaskId}\` has been unbound)`
      : "";
    return finalize(
      `✅ New Task created and bound.\n\n` +
        `- **Title**: ${result.title}\n` +
        `- **Status**: ${result.status ?? "running"}\n` +
        `- **Description**: ${trimDesc(result.description)}\n` +
        `- **Task ID**：\`${result.taskId}\`${prevLine}`,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
        ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
        ...(result.error ? { bind_warning: result.error } : {}),
      },
    );
  }

  // ── cancel branch ─────────────────────────────────────────────────────────
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
      ? `✅ Pending Task action cancelled.`
      : `ℹ️ There is no pending Task action.`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // ── first-call branch ────────────────────────────────────────────────────────

  const lockedTitle = rawArgs.length > 0 ? truncateTitle(rawArgs) : undefined;

  if (recentMessages.length === 0) {
    return finalize(
      `⚠️ This request carries no conversation messages; \`mem:create-task\` needs recent conversation as context to generate a Task.` +
        `\n\nTip: have a few rounds of conversation with the AI first, then run this command.`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await createTaskFromSession({
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
    ...(lockedTitle ? { lockedTitle, hint: rawArgs } : {}),
  });

  // Persistence failed
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = lockedTitle
      ? ""
      : "\n\nYou can:\n1. Retry later\n2. `mem:create-task <your title>` to specify the title manually (the LLM only generates the description, and falls back to an empty description even if it fails)";
    return finalize(
      `❌ Failed to create Task: ${detail}${hintLine}`,
      false,
      { reason: "create_failed", detail },
    );
  }

  // Already-bound branch: pending preview
  if (result.pending && result.pending.kind === "create") {
    const p = result.pending;
    const currentLine = p.currentTaskTitle
      ? `\`${p.currentTaskId}\`"${p.currentTaskTitle}"`
      : `\`${p.currentTaskId}\``;
    return finalize(
      `⚠️ The current session is already bound to Task ${currentLine}.\n\n` +
        `**New Task preview**\n` +
        `- Title: ${p.draftTitle}\n` +
        `- Description: ${trimDesc(p.draftDescription)}\n\n` +
        `Please choose the next step:\n` +
        `1. \`mem:create-task confirm\` - override the current binding and create a new Task\n` +
        `2. \`mem:update-task\` or \`mem:update-task <new description>\` - keep using the current Task and only update its description (no new Task)\n` +
        `3. \`mem:create-task cancel\` - cancel, make no changes`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "create",
          draft_title: p.draftTitle,
          draft_description: p.draftDescription,
          current_task_id: p.currentTaskId,
          ...(p.currentTaskTitle ? { current_task_title: p.currentTaskTitle } : {}),
        },
      },
    );
  }

  // Unbound branch: persisted directly
  return finalize(
    `✅ Task created and bound to this session.\n\n` +
      `- **Title**: ${result.title}\n` +
      `- **Status**: ${result.status ?? "running"}\n` +
      `- **Description**: ${trimDesc(result.description)}\n` +
      `- **Task ID**：\`${result.taskId}\`\n\n` +
      `You can later use \`mem:update-task\` to append progress.`,
    true,
    {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      ...(result.error ? { bind_warning: result.error } : {}),
    },
  );
}
