/**
 * stages/mem-command-intercept.ts — mem: command interception stage (main dispatcher).
 *
 * Extracted from 4 ~100-line mem intercept blocks (blueprint §2.4):
 *   - openai-chat runner
 *   - anthropic runner
 *   - codex runner  (uses parseCommandFromText, a different body extraction path)
 *   - workbuddy runner (similar to codex)
 *
 * Semantics: after session-init completes, check whether the body has a mem command (session-reset has already been
 * intercepted by the pre-hook). On a hit:
 *   1. Not initialized (sessionInfo=null/injectionSkipped=true) -> return a "session not initialized" error response
 *   2. Initialized -> executeMemCommand + L0 write + skill extract + langfuse report + return the response
 * On no hit return null so the caller continues the pipeline.
 */

import type { ProxyConfig } from "../../types.js";
import type { TdaiClient } from "../../tdai/client.js";
import { recordTdaiTurn } from "../../tdai/recorder.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import { isExtractionAllowed } from "../../extraction-gate.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { countHumanTurns } from "../../turnSeq.js";
import { langfuseTurnTraceId, langfuseReportGeneration } from "../../langfuse.js";
import type { SessionResetProtocol } from "./session-reset-pre-hook.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";
import type { MemCommandMessage } from "../../mem-command/types.js";

export interface MemCommandInterceptInput {
  /** memoryTurn/isMainDialog gate — when false, short-circuit (no interception) */
  enabled: boolean;
  body: Record<string, unknown>;
  agentSource: string;
  sessionKey: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** when true, treated as "session not initialized", returns an error response */
  injectionSkipped: boolean;
  /** session-init terminal state for this turn -> checkFirst fallback uses the original intent */
  sessionJustRegistered: boolean;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  apiKey: string;
  callerUserKey?: string;
  isStream: boolean;
  protocol: SessionResetProtocol;
  /** main-chain modelId (mem taskDraft follows the main model) */
  modelId: string;
  /** main-chain upstream URL (reused by mem taskDraft) */
  upstreamUrl: string;
  /** anthropic body.thinking */
  thinking?: boolean;
  /** used by codex/wb: userText extracted from body.input[] -> parseCommandFromText;
   *  other protocols use parseMemCommand(body) */
  userText?: string;
  /** main-conversation messages (needed by skill extract) */
  messages: unknown[];
  /** tdai client / identity construction used by L0 write depends on sessionInfo */
  createTdaiClientFn: (config: ProxyConfig, spaceId?: string) => TdaiClient | null;
  /** OpenAI/CC/CB: body.messages; codex/wb: message segments taken from input[] */
  bodyMessages: MemCommandMessage[];
  /** assistant content structure: openai=string, anthropic=blocks array, responses=message object */
  assistantContentFormat: "openai-string" | "anthropic-blocks" | "responses-message";
  /** startTime for langfuse */
  startTime: string;
  /** used for langfuse traceName */
  keyId: string;
  /** asset capability obtained from session-init */
  assetCapabilities?: AssetCapabilityFlags;
  /** taskDraft LLM upstream protocol (usually == protocol) */
  upstreamProtocol: "openai" | "anthropic" | "responses";
  /** codex/wb have an independent lf turn ctx, reuse it first to avoid recomputing traceId inline */
  langfuseCtx?: {
    traceId: string;
    userId: string;
    sessionId: string;
    tags: string[];
  };
}

/**
 * Returns Response = intercepted and sent directly; returns null = no hit -> caller continues the pipeline.
 */
export async function stageMemCommandIntercept(
  input: MemCommandInterceptInput,
): Promise<Response | null> {
  if (!input.enabled) return null;

  const {
    body, agentSource, sessionKey, sessionInfo, injectionSkipped,
    sessionJustRegistered, config, spaceId, userId, apiKey, callerUserKey,
    isStream, protocol, modelId, upstreamUrl, thinking, userText,
    messages, createTdaiClientFn, bodyMessages,
    assistantContentFormat, startTime, keyId, assetCapabilities, upstreamProtocol,
  } = input;

  const {
    parseMemCommand, parseCommandFromText, executeMemCommand,
    buildMemResponse, truncateArgs,
  } = await import("../../mem-command/index.js");

  // recognize the command
  let memCmd: ReturnType<typeof parseMemCommand> = null;
  if (protocol === "responses" && userText !== undefined) {
    memCmd = parseCommandFromText(userText);
  } else {
    memCmd = parseMemCommand(body, agentSource);
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body, agentSource, { checkFirst: true });
    }
  }
  // session-reset was already handled in the pre-hook, skip to avoid duplication
  if (memCmd?.command === "session-reset") memCmd = null;
  if (!memCmd) return null;

  // not initialized -> error response
  if (!sessionInfo || injectionSkipped) {
    const errText = `⚠️ Session not initialized, command unavailable. Please complete session initialization (select Team/Agent) and retry.`;
    console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
    return buildMemResponse(errText, {
      protocol,
      stream: isStream,
      requestId: `mem-cmd-${Date.now()}`,
      thinking,
    });
  }

  // execute the command
  const memResult = await executeMemCommand(memCmd, {
    sessionKey,
    agentSource,
    config,
    spaceId,
    userId,
    apiKey: apiKey || "",
    sessionInfo: sessionInfo as Record<string, unknown>,
    protocol,
    stream: isStream,
    args: memCmd.args,
    thinking,
    bodyMessages,
    model: modelId,
    upstreamUrl,
    upstreamProtocol,
  });

  // L0 write (synchronous await to guarantee persistence)
  const tdaiClientForMem = createTdaiClientFn(config, spaceId);
  const tdaiIdentityForMem = deriveTdaiIdentity({
    sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
    userId: userId || null,
    sessionKey,
    userKey: callerUserKey,
  });
  if (tdaiClientForMem && tdaiIdentityForMem && isExtractionAllowed(config, "tdai-memory")) {
    const userMsg = { role: "user" as const, content: memCmd.rawMessage };
    try {
      await recordTdaiTurn(tdaiClientForMem, tdaiIdentityForMem, userMsg, memResult.messageText);
    } catch (err: unknown) {
      console.error("[mem-command] L0 write error:", err);
    }
  }

  // Skill extract (synchronous await to guarantee the buffer is persisted)
  if (isExtractionAllowed(config, "skill")) {
    try {
      const assistantMsg = assistantContentFormat === "anthropic-blocks"
        ? { role: "assistant", content: [{ type: "text", text: memResult.messageText }] }
        : assistantContentFormat === "responses-message"
          ? { type: "message" as const, role: "assistant" as const, content: [{ type: "output_text" as const, text: memResult.messageText }] }
          : { role: "assistant", content: memResult.messageText };
      await triggerSkillExtractIfReady({
        config,
        sessionKey,
        agentSource,
        sessionInfo: sessionInfo as Record<string, unknown>,
        inputMessages: messages,
        assistantMessage: assistantMsg,
        protocol: protocol === "responses" ? "responses" : (protocol as "openai" | "anthropic"),
        assetCapabilities,
      });
    } catch (err: unknown) {
      console.warn("[mem-command] skill extract trigger error:", err instanceof Error ? err.message : String(err));
    }
  }

  console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);

  // Langfuse report — prefer reusing the lf ctx passed in by the caller (already built by codex/wb),
  // if not provided compute turnSeq -> traceId inline (openai-chat / anthropic take this path,
  // because their mem interception happens before the lf construction).
  let lfTraceId: string;
  let lfUserId: string;
  let lfSessionId: string;
  let lfTags: string[];
  if (input.langfuseCtx) {
    lfTraceId = input.langfuseCtx.traceId;
    lfUserId = input.langfuseCtx.userId;
    lfSessionId = input.langfuseCtx.sessionId;
    lfTags = [...input.langfuseCtx.tags, "mem-command"];
  } else {
    const memTurnSeq = countHumanTurns(messages, protocol === "anthropic" ? "anthropic" : "openai");
    lfTraceId = langfuseTurnTraceId(sessionKey, memTurnSeq);
    lfUserId = keyId;
    lfSessionId = sessionKey;
    lfTags = [
      `agent_source:${agentSource}`,
      `protocol:${protocol}`,
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
      "mem-command",
    ];
  }
  langfuseReportGeneration({
    traceId: lfTraceId,
    name: "memory-proxy",
    model: "memory-proxy",
    startTime,
    endTime: new Date().toISOString(),
    input: memCmd.rawMessage,
    output: memResult.messageText,
    usage: { input_tokens: 0, output_tokens: 0 },
    traceName: `memory-proxy / ${keyId}`,
    userId: lfUserId,
    sessionId: lfSessionId,
    tags: lfTags,
    traceInput: memCmd.rawMessage,
    traceOutput: memResult.messageText,
  });

  return memResult.response;
}
