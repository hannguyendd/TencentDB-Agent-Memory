/**
 * mem:session-reset - reset the binding of the current session and re-run the session-init form mid-conversation.
 *
 * Semantics: regardless of whether the current state is uninitialized / pending_* / initialized / bypassed,
 * after the command runs the session always enters `pending_asset_confirm`, carrying `resetEpoch = Date.now()` +
 * `resetFlow = true`. On the next request, `handleSessionInit` will show the asset_confirm form
 * because state !== initialized, and the user re-selects Team/Agent/Task.
 *
 * Cross-node consistency:
 *   - writes to the store go through `store.set` write-through; L1 + L2a (SessionRepo) are persisted synchronously
 *   - another pod's L1 may still hold the old initialized state -- `store.getOrRecover` step 1
 *     aligns with L2a using resetEpoch; if L2a.resetEpoch is larger it breaks the L1 short-circuit and takes the new
 *     pending state to show the form
 *   - the L2b binding (the "note" written when initialized) is explicitly deleted, so the next `rebuildFromBinding`
 *     does not restore the old initialized state directly
 *
 * Copy: following the style of create-skill, only expose words users understand such as "reset / link / team assets";
 * internal terms like status / resetEpoch / binding / pending_asset_confirm do not appear.
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";

export async function executeSessionReset(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const store = getSessionStore();
  const compositeKey = `${ctx.agentSource}:${ctx.sessionKey}`;

  // Record the old state for observability (instrumentation is added in Commit 4; for now it is only included in the returned data)
  const before = store.get(compositeKey);
  const oldStatus = before?.status ?? "uninitialized";
  const oldBypassed = !!before?.bypassed;

  const resetEpoch = Date.now();
  // Write uninitialized rather than pending_asset_confirm:
  //
  // pending_asset_confirm means "the proxy has already shown the form and is waiting for the user's reply" -- but the
  // next-turn body after a reset will not contain a form tool_use/tool_result (the form has not been shown yet).
  // If pending_asset_confirm were written, the next handleSessionInit would enter the "pending_asset_confirm
  // branch" and try to parse the form answer from the user message -> cannot parse -> unrecognized -> bypass ->
  // the command would have been wasted.
  //
  // Writing uninitialized makes the next turn take the Case 1 "first entry" branch: re-fetch teams -> show the
  // asset_confirm form. Since Commit 2 already removed the isFreshCCConversation gate,
  // it will not be blocked by the safety-net even when there are many messages.
  const nextState: SessionInitState = {
    status: "uninitialized",
    keyId: ctx.sessionKey,
    startedAt: resetEpoch,
    attemptCount: 0,
    userId: ctx.userId,
    resetEpoch,
    resetFlow: true,
  };

  // Fallback bind identity: the handler path normally calls store.getOrRecover(compositeKey, identity, ...) first
  // to complete the bind, but when the pre-hook intercepts early the store may not have been bound yet -- bind explicitly once more
  // to ensure the L2a write-through of store.set hits the correct namespace.
  store.bind(compositeKey, {
    userId: ctx.userId,
    agentSource: ctx.agentSource,
    sessionId: ctx.sessionKey,
    spaceId: ctx.spaceId,
  });

  await store.set(compositeKey, nextState);

  // Explicitly delete the L2b binding -- otherwise on the next request getOrRecover step 3 rebuildFromBinding
  // would restore the old initialized binding directly, and resetFlow would run in vain.
  // store.set already calls `deleteBinding` for the pending state (it only puts when initialized),
  // but for defensiveness we explicitly delete here, without relying on store.set's internal implementation details.
  const bindingRepo = store.getBindingRepo();
  if (bindingRepo) {
    try {
      await bindingRepo.deleteBinding(ctx.spaceId, ctx.sessionKey);
    } catch (err) {
      console.warn(
        `[mem-command:session-reset] deleteBinding failed for ${compositeKey}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ── observability ────────────────────────────────────────────────────────
  // Structured audit log -- lets ops precisely catch session-reset events in a dashboard / grep.
  // Fields align with the later session_init_logs completion instrumentation (same session_key /
  // agent_source), so PM/ops can join them to see the "reset triggered -> init completed conversion rate".
  // reset_epoch is used for cross-node consistency debugging -- pod A writes, pod B reads; if the two sides see different
  // reset_epoch values, an L2a probeL2a staleness problem can be located immediately.
  console.log(
    `[session-reset] session=${compositeKey} space=${ctx.spaceId} user=${ctx.userId} ` +
      `agent_source=${ctx.agentSource} old_status=${oldStatus} old_bypassed=${oldBypassed} ` +
      `new_status=${nextState.status} reset_epoch=${resetEpoch}`,
  );

  const messageText = buildSuccessMessage(oldStatus, oldBypassed);

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: true,
    messageText,
    // Structured data is only visible in logs / the panel, not in user-readable text
    data: {
      old_status: oldStatus,
      old_bypassed: oldBypassed,
      new_status: nextState.status,
      reset_epoch: resetEpoch,
    },
    response,
  };
}

/**
 * Build the user-readable message based on the old state.
 *
 * Old state    Message emphasis
 * uninitialized "a selection will pop up when the conversation continues"
 * initialized   "binding removed, please re-select"
 * bypassed      "selection entry restored"
 * pending_*     "selection restarted"
 */
function buildSuccessMessage(oldStatus: string, oldBypassed: boolean): string {
  if (oldStatus === "uninitialized") {
    return "✅ Reset done. Team asset selection will pop up when you continue the conversation";
  }
  if (oldBypassed) {
    return "✅ Team asset selection entry restored. Re-selection will pop up when you continue the conversation";
  }
  if (oldStatus === "initialized") {
    return "✅ Team asset binding of this session removed. Re-selection will pop up when you continue the conversation";
  }
  // pending_*
  return "✅ Team asset selection restarted. Selection will pop up when you continue the conversation";
}
