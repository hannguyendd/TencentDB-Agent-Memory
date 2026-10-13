/**
 * stages/session-reset-pre-hook.ts — mem:session-reset pre-interception stage.
 *
 * Extracted from 4 nearly identical pre-hook blocks (blueprint §2.4 copy-paste, ~40 lines x 4):
 *   - openai-chat runner: header-only reject branch + main reset flow
 *   - anthropic runner:   same as openai-chat
 *   - codex runner:       only the main reset flow (codex has no header-only support)
 *   - workbuddy runner:   same as codex
 *
 * Semantics:
 *   1. header-only agent (pi/hermes/openclaw) or dsh headless: on receiving mem:session-reset
 *      -> return "not supported" text (the client does not recognize the fake tool_call, popping a form would hang)
 *   2. other agents: bind session -> archive the old skill buffer (best-effort) -> reset the store
 *      -> delete the binding, letting the main pipeline pop the form later to complete the reset
 *
 * The caller only needs to call it once; on a hit it returns a Response to return directly, on no hit it returns null to continue the pipeline.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";

/** supported protocol tags, decides the mem response envelope format */
export type SessionResetProtocol = "openai" | "anthropic" | "responses";

export interface SessionResetPreHookInput {
  c: Context;
  config: ProxyConfig;
  body: Record<string, unknown>;
  agentSource: string;
  sessionKey: string;
  spaceId: string;
  userId: string;
  isAuxiliary: boolean;
  dshHeadless: boolean;
  /** true = allow the pre-hook to trigger; anthropic uses memoryTurn (requestKind=main && !legacyProxy),
   *  other protocols use !isAuxiliary && !dshHeadless.
   *  When not provided the stage computes it itself as !isAuxiliary && !dshHeadless. */
  enabled?: boolean;
  isStream: boolean;
  protocol: SessionResetProtocol;
  /**
   * Used by codex/wb: userText pre-extracted from body.input[];
   * openai-chat / anthropic pass an empty string, the stage goes through the parseMemCommand(body) path.
   */
  userText?: string;
  /** anthropic passes body.thinking (needed by buildMemResponse) */
  thinking?: unknown;
  /**
   * workbuddy legacy code used `codex:${sessionKey}` as compositeKey (agent-alias compatibility),
   * other protocols use `${agentSource}:${sessionKey}`. Defaults to the latter; pass this parameter to override.
   */
  compositeKeyOverride?: string;
}

/**
 * Returns Response = intercepted and sent directly (does not continue the pipeline);
 * returns null = no hit or old buffer already archived, the caller continues the pipeline (usually pops the form).
 */
export async function stageSessionResetPreHook(
  input: SessionResetPreHookInput,
): Promise<Response | null> {
  const { c, config, body, agentSource, sessionKey, spaceId, userId,
    isAuxiliary, dshHeadless, isStream, protocol, userText, thinking } = input;
  const gate = input.enabled ?? (!isAuxiliary && !dshHeadless);
  if (!gate) return null;

  // header-only agent + dsh headless: take the "not supported" branch (openai-chat/anthropic only,
  // codex/wb don't use header-only clients so this segment harmlessly never triggers)
  const { isHeaderOnlyAgent } = await import("../../session/preset.js");
  const noFormAgent = isHeaderOnlyAgent(agentSource) || dshHeadless;
  if (!isAuxiliary && noFormAgent) {
    const { isSessionResetCommand } = await import("../../mem-command/pre-intercept.js");
    if (isSessionResetCommand(body, agentSource)) {
      const { buildMemResponse } = await import("../../mem-command/response-builder.js");
      console.log(`[mem-command:pre] session-reset unsupported for agent=${agentSource} dshHeadless=${dshHeadless}`);
      const msg = isHeaderOnlyAgent(agentSource)
        ? `⚠️ mem:session-reset is not supported for ${agentSource} clients.\n\n`
          + `${agentSource} pre-selects its identity via the x-team-id / x-agent-id / x-task-id request headers and has no interactive form entry.\n`
          + `Please change these request headers directly in the client configuration to switch Team / Agent / Task.`
        : "⚠️ mem:session-reset is not supported in dsh headless mode.\n\n"
          + "In headless / no-preset scenarios the dsh client does not mount the ask_user_question tool and cannot pop up the asset selection form.\n"
          + "Please use it in a dsh environment with the ask_user_question preset.";
      return buildMemResponse(msg, {
        protocol,
        stream: isStream,
        requestId: `mem-reset-unsupported-${Date.now()}`,
        thinking: thinking as boolean | undefined,
      });
    }
  }

  // main reset flow (shared by all 4 protocols)
  if (isAuxiliary || dshHeadless || isHeaderOnlyAgent(agentSource)) return null;

  const { isSessionResetCommand } = await import("../../mem-command/pre-intercept.js");
  if (!isSessionResetCommand(body, agentSource)) return null;

  // recognize the command — codex/wb use parseCommandFromText(userText), others use parseMemCommand(body)
  const { parseMemCommand, parseCommandFromText } = await import("../../mem-command/index.js");
  const memCmd = (protocol === "responses" && userText !== undefined)
    ? parseCommandFromText(userText)
    : parseMemCommand(body, agentSource);
  if (!memCmd) return null;

  const { getSessionStore } = await import("../../session/store.js");
  const store = getSessionStore();
  const compositeKey = input.compositeKeyOverride ?? `${agentSource}:${sessionKey}`;
  store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

  // force-archive the old agent's skill buffer (best-effort)
  const oldState = store.get(compositeKey);
  if (oldState?.status === "initialized" && oldState.sessionInfo && config.coreSkill?.endpoint) {
    const si = oldState.sessionInfo as unknown as Record<string, string>;
    if (si.space_id && si.user_id && si.team_id && si.agent_id) {
      import("../../skill/core-client.js").then(({ getCoreSkillClient }) => {
        const client = getCoreSkillClient(config.coreSkill!);
        client.forceArchive(
          {
            space_id: si.space_id,
            user_id: si.user_id,
            team_id: si.team_id,
            agent_id: si.agent_id,
            session_id: sessionKey,
            task_id: si.task_id || undefined,
            reason: "session-reset",
          },
          { serviceId: si.space_id },
        ).then((res) => {
          console.log(`[session-reset] force-archive old buffer: status=${res.status} session=${sessionKey} agent=${si.agent_id}`);
        }).catch((err) => {
          console.warn(`[session-reset] force-archive failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
        });
      }).catch(() => { /* import fail */ });
    }
  }

  const resetEpoch = Date.now();
  await store.set(compositeKey, {
    status: "uninitialized",
    keyId: sessionKey,
    startedAt: resetEpoch,
    attemptCount: 0,
    userId: userId || "anonymous",
    resetEpoch,
    resetFlow: true,
  } as unknown as Parameters<typeof store.set>[1]);
  const bindingRepo = store.getBindingRepo();
  if (bindingRepo) await bindingRepo.deleteBinding(spaceId, sessionKey).catch(() => { /* best-effort */ });
  console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);

  // Note: the void c parameter is kept (future stages may need header access), currently unused
  void c;

  return null; // let the caller continue the pipeline (take the pop-form logic)
}
