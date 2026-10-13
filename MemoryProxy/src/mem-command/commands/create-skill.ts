/**
 * mem:create-skill - manually force-archive the current session buffer
 *
 * Copy convention: only tell the user concepts like "archive triggered / Skill extraction in progress";
 * do not expose internal task_id, archive_key, file paths, etc. For troubleshooting, see the `data` field or backend logs.
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { forceArchiveSkill } from "../../routes/session-force-archive.js";

export async function executeCreateSkill(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const result = await forceArchiveSkill({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    reason: ctx.args || undefined,
  });

  let messageText: string;

  if (!result.success) {
    messageText = `❌ Failed to archive this conversation: ${result.error ?? "unknown error"}`;
  } else if (result.status === "empty") {
    messageText = `⚠️ Nothing to archive in this conversation yet. Please continue the conversation and try again`;
  } else {
    messageText = `✅ Conversation archived successfully, extracting Skill`;
  }

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: result.success,
    messageText,
    // task_id / archive_key are still kept in the structured data (readable by the panel / logs / e2e),
    // they are just no longer included in the user-visible text.
    data: result.success
      ? { status: result.status, task_id: result.taskId, archive_key: result.archiveKey }
      : undefined,
    response,
  };
}
