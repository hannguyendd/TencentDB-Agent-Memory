/**
 * mem:sync - refresh all injection caches of the current session
 *
 * Underlying actions:
 *   - re-fetch Agent / Task detail and overwrite SessionStore (description, prompt, goal are all updated)
 *   - re-run all hooks that declare a session_init / hybrid cache strategy (Skill / memory /
 *     Knowledge / pinned assets, etc.) and putMany the new blocks into HookCacheRepo (COS)
 *
 * The user-facing text only uses concepts users understand ("assets / descriptions"); it does not expose
 * internal terms such as injector id, hook name, or archive_key.
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { refreshSessionCache, type RefreshResult } from "../../routes/session-refresh.js";

function buildSuccessMessage(result: RefreshResult): string {
  const parts: string[] = [];
  parts.push("Skill / memory / Knowledge assets");
  if (result.agentRefreshed || result.taskRefreshed) {
    parts.push("Task & Agent descriptions");
  }
  const scope = parts.join(", ");
  return `✅ All asset injections refreshed (${scope}), took ${result.tookMs}ms`;
}

export async function executeSync(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  // When unbound, skip refreshSessionCache (it would expose the session key to the user)
  if (!ctx.sessionInfo || Object.keys(ctx.sessionInfo).length === 0) {
    const messageText = "⚠️ The current session is not bound to team assets, so sync is unavailable. Please use `mem:session-reset` to select a Team/Agent first, then try again.";
    return {
      success: false,
      messageText,
      response: buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
    };
  }

  const result = await refreshSessionCache({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    callerUserKey: ctx.apiKey,
  });

  const messageText = result.success
    ? buildSuccessMessage(result)
    : `❌ Asset refresh failed: ${result.error ?? "unknown error"}`;

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: result.success,
    messageText,
    // The detailed hookId list / duration is kept in the structured data for the panel / logs.
    data: result.success
      ? {
          refreshed: result.refreshed,
          skipped: result.skipped,
          agent_refreshed: result.agentRefreshed,
          task_refreshed: result.taskRefreshed,
          took_ms: result.tookMs,
        }
      : undefined,
    response,
  };
}
