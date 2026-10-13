/**
 * stages/session-init-orchestrate.ts — the main session-init orchestration stage.
 *
 * Extracted from ~200 lines of isomorphic skeleton across 4 runners (openai-chat / anthropic / codex / workbuddy):
 *   1. store / metadataClient / parsePresetIdentity assembly (identical)
 *   2. compositeKey + identity assembly (workbuddy hardcodes the codex: prefix — parameterized)
 *   3. store.getOrRecover (identical)
 *   4. isTerminalState + needsPrewarm checks (identical)
 *   5. recover branch: buildSessionContextBlockWithToggles / injectSessionContextWithToggles
 *      → assemble messages/systemAppend in initResult (protocol differs, parameterized via recoverApplyFn)
 *   6. handleSessionInit main state machine call (identical; the reqCtx protocol/questionsAsArray/codexAnswerInput
 *      parameters are provided by the caller via buildReqCtx; agentSource is also parameterized — workbuddy uses "codex")
 *   7. intercept response assembly (protocol differs, parameterized via buildInterceptResponse;
 *      openai/anthropic use initResult.response, codex/wb go through buildCodexFormResponse)
 *   8. Default-gate branch (codex/wb only — optionally passed by the caller via buildDefaultGateResponse)
 *
 * Differences are kept as 4 callback parameters, each supplied by its own runner:
 *   - synthesizeMessages: (body) => Record<string,unknown>[]
 *     * openai-chat: body.messages as is
 *     * anthropic: body.messages as is
 *     * codex/wb: codexFormAnswersAsMessages(input)
 *   - buildRecoverInitResult: (recovered) => Partial<SessionInitResult>
 *     * openai-chat: injectSessionContextWithToggles → messages
 *     * anthropic/codex/wb: buildSessionContextBlockWithToggles → systemAppend
 *   - buildInterceptResponse: (initResult) => Response | null
 *     * openai-chat/anthropic: initResult.response directly
 *     * codex/wb: formData → buildCodexFormResponse
 *   - buildDefaultGateResponse?: (initResult) => Response | null
 *     * codex/wb only; openai-chat/anthropic pass undefined
 *
 * ForkSideQuery short-circuit (anthropic only, requestKind==="fork" L2b miss → passthrough):
 *   - the fork branch is checked up front by the caller; on a hit it is a no-op returning initResult and does not enter this stage;
 *     or this stage provides a forkPassthrough option for the caller to pass requestKind + branch.
 *   - For simplicity, currently the fork branch stays in the caller (anthropic runner), since it is unique to just one place.
 *
 * Calling pattern for each runner (pseudocode):
 *   const { proceed, response, initResult, wentThroughStateMachine } = await stageSessionInitOrchestrate({
 *     agentSourceForState, sessionKey, userId, config, headers, spaceId,
 *     apiKey, body, isStream, modelId, capabilities,
 *     compositeKeyOverride: (wb passes "codex:...", others pass undefined),
 *     synthesizeMessages, buildRecoverInitResult, buildInterceptResponse,
 *     buildDefaultGateResponse, // codex/wb
 *     buildReqCtx, // protocol + questionsAsArray + codexAnswerInput
 *   });
 *   if (!proceed) return response!;
 *   // the caller continues using initResult for apply / prewarm / archive-ctx, etc.
 */

import type {
  SessionInitConfig,
  ProxyConfig,
} from "../../types.js";
import type {
  SessionStore,
  SessionInitResult,
  SessionRequestContext,
} from "../../session/index.js";
import type { PresetIdentity } from "../../session/preset.js";
import type { MetadataClient } from "../../meta/client.js";

/** initResult construction defined by the caller on a recover hit (protocol-specific); may be async so the caller can dynamic import */
export type RecoverApplyFn = (
  recovered: NonNullable<Awaited<ReturnType<SessionStore["getOrRecover"]>>>,
  bodyMessages: Array<Record<string, unknown>>,
) => (Partial<SessionInitResult> & { messages?: Array<Record<string, unknown>>; systemAppend?: unknown })
  | Promise<Partial<SessionInitResult> & { messages?: Array<Record<string, unknown>>; systemAppend?: unknown }>;

/** Response assembly on interception (openai/anthropic return initResult.response directly; codex/wb assemble a formResponse) */
export type BuildInterceptFn = (initResult: SessionInitResult) => Response | null;

/** Default-gate branch (codex/wb only; openai/anthropic pass undefined) */
export type BuildDefaultGateFn = (initResult: SessionInitResult) => Response | null;

/** User message synthesis: openai/anthropic return body.messages directly, codex/wb return codexFormAnswersAsMessages(input) */
export type SynthesizeMessagesFn = () => Array<Record<string, unknown>>;

/** SessionRequestContext construction (protocol / questionsAsArray / codexAnswerInput / capabilities) */
export type BuildReqCtxFn = () => SessionRequestContext;

export interface SessionInitOrchestrateInput {
  /** agentSource used for state machine dispatch (workbuddy passes "codex" to reuse the CB branch) */
  agentSourceForState: string;
  /** compositeKey prefix; wb passes "codex:..." (borrowing the codex L2b binding), others pass undefined to use agentSource */
  compositeKeyOverride?: string;
  sessionKey: string;
  userId: string | null;
  spaceId?: string;
  config: ProxyConfig & { sessionInit: SessionInitConfig };
  /** sk-mem-* key used for kernel /v3/meta auth; openai-chat uses `apiKey || config.tdai.apiKey`, others use apiKey */
  kernelUserKey: string;
  /** request header lowercased map, for parsePresetIdentity */
  headers: Record<string, string>;
  /** user message synthesis (openai/anthropic body.messages / codex/wb codexFormAnswersAsMessages) */
  synthesizeMessages: SynthesizeMessagesFn;
  /** protocol-specific initResult assembly on a recover hit */
  buildRecoverInitResult: RecoverApplyFn;
  /** reqCtx of the state machine (protocol + questionsAsArray + codexAnswerInput + capabilities + stream + modelId) */
  buildReqCtx: BuildReqCtxFn;
  /** protocol-specific intercept response assembly */
  buildInterceptResponse: BuildInterceptFn;
  /** Plan hint response on the first Default-gate hit (codex/wb only); undefined means skip this branch */
  buildDefaultGateResponse?: BuildDefaultGateFn;
  /** Whether to pass messages to the store during L2b recovery (openai/anthropic pass body.messages, codex/wb pass []) */
  recoveryMessages: Array<Record<string, unknown>>;
  /**
   * anthropic only: when requestKind === "fork" and recover did not hit a terminal state, short-circuit to passthrough.
   * The passed function is called after store.getOrRecover and before the isTerminalState check;
   * if it returns non-null, the returned initResult is used directly to short-circuit (skipping the recover/state-machine branches).
   *
   * Semantics of the old anthropic runner (behavior-equivalent, preserved):
   *   if (requestKind === "fork" && !recovered?.status !== "initialized") → passthrough
   */
  forkPassthroughHook?: (recovered: Awaited<ReturnType<SessionStore["getOrRecover"]>>) => SessionInitResult | null;
}

export interface SessionInitOrchestrateResult {
  /** false → response is non-null and must be returned to the client immediately; true → continue to apply/prewarm */
  proceed: boolean;
  /** Response to return to the client immediately (intercept / default-gate); null when proceed=true */
  response: Response | null;
  /** Full initResult after the state machine or recover (may be null when proceed=false) */
  initResult: SessionInitResult | null;
  /** Whether this turn actually went through the handleSessionInit state machine (false on the recover branch) */
  wentThroughStateMachine: boolean;
}

/**
 * Main orchestration.
 *
 * 100% equivalent to the old handlers, differing only in:
 *   - 4 callback parameters replace 4 inline protocol/agent-specific code blocks
 *   - metadataClient / store are imported by this stage itself (the old runners had 4 duplicate dynamic imports)
 *
 * The try/catch degrade in the old handlers (recover/state machine failure) stays with the caller,
 * because the caller usually logs + continues injecting in the catch rather than the stage deciding. So the
 * store calls in this stage have no try/catch and let exceptions bubble up.
 */
export async function stageSessionInitOrchestrate(
  input: SessionInitOrchestrateInput,
): Promise<SessionInitOrchestrateResult> {
  const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import(
    "../../session/index.js"
  );
  const { getMetadataClient } = await import("../../meta/client.js");

  const store = getSessionStore();
  const metadataClient: MetadataClient = getMetadataClient(
    input.config.coreSkill,
    input.spaceId ?? "",
    input.kernelUserKey,
  );
  const presetIdentity: PresetIdentity = parsePresetIdentity(input.config.sessionInit, input.headers) ?? {};

  const compositeKey = input.compositeKeyOverride ?? `${input.agentSourceForState}:${input.sessionKey}`;
  const identity = {
    userId: input.userId || "anonymous",
    agentSource: input.agentSourceForState,
    sessionId: input.sessionKey,
    spaceId: input.spaceId,
  };

  const recovered = await store.getOrRecover(compositeKey, identity, {
    metadataClient,
    messages: input.recoveryMessages,
    presetIdentity,
  });

  const isTerminalState = recovered?.status === "initialized";
  const needsPrewarm =
    recovered?.__recoverySource === "l2b" ||
    recovered?.__recoverySource === "history-scan";

  let initResult: SessionInitResult;
  let wentThroughStateMachine = false;

  // fork passthrough (anthropic only): if the hook returns non-null, use it directly as initResult
  const forkOverride = input.forkPassthroughHook?.(recovered ?? undefined);
  if (forkOverride) {
    return {
      proceed: true,
      response: null,
      initResult: forkOverride,
      wentThroughStateMachine: false,
    };
  }

  if (recovered && isTerminalState) {
    // Recover branch — protocol-specific rebuild via callback
    const applied = await input.buildRecoverInitResult(recovered, input.recoveryMessages);
    initResult = {
      intercepted: false,
      sessionInfo: recovered.sessionInfo,
      agentDetail: recovered.agentDetail,
      taskDetail: recovered.taskDetail,
      bypassed: recovered.bypassed,
      justRegistered: needsPrewarm,
      ...applied,
    } as SessionInitResult;
  } else {
    wentThroughStateMachine = true;
    const synthesizedMessages = input.synthesizeMessages();
    initResult = await handleSessionInit(
      input.sessionKey,
      input.userId,
      synthesizedMessages,
      input.config.sessionInit,
      store,
      input.buildReqCtx(),
      input.agentSourceForState,
      metadataClient,
      input.kernelUserKey,
      input.spaceId,
      presetIdentity,
    );
  }

  // Intercept branch (form / reset confirmation)
  if (initResult.intercepted) {
    const response = input.buildInterceptResponse(initResult);
    if (response) return { proceed: false, response, initResult, wentThroughStateMachine };
    // Defensive: intercept without response → fall through (should not happen)
  }

  // Default-gate branch (codex/wb only)
  if (input.buildDefaultGateResponse) {
    const gateResponse = input.buildDefaultGateResponse(initResult);
    if (gateResponse) return { proceed: false, response: gateResponse, initResult, wentThroughStateMachine };
  }

  return { proceed: true, response: null, initResult, wentThroughStateMachine };
}
