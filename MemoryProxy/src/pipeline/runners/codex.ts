/**
 * Codex Responses API handler.
 *
 * Handles `POST /v1/responses` + 3 aux endpoints (`/responses/compact`,
 * `/memories/trace_summarize`, `/realtime/calls`) for the Codex CLI client.
 *
 * Protocol: OpenAI Responses API — third independent path alongside
 * anthropicHandler (Anthropic Messages) and handler (OpenAI Chat Completions).
 *
 * Internal dispatch:
 *   /v1/responses               → main loop (session-init + injection + forward)
 *   /v1/responses/compact       → aux passthrough (no injection, credit only)
 *   /v1/memories/trace_summarize → aux passthrough
 *   /v1/realtime/calls          → aux passthrough
 *   other codex paths           → 404
 *
 * Session-init flow:
 *   1. Extract session_id from header/body
 *   2. Check sessionStore for binding
 *   3. If unbound → call handleSessionInit (reuses CB state machine with
 *      agentSource="codex", protocol="responses") → return request_user_input form
 *   4. Detect Default mode gate → permanent bypass
 *   5. If bound → inject assets via buildCodexInjectionBlock → forward
 *
 * See docs/2026-08-07-codex-integration-plan.md.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { apiKeyToKeyId, extractBearerToken, opikCreateTrace, uuidv7 } from "../../opik.js";
import { createPipeline, writeLog } from "../../logger.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";
import { joinUrl } from "../../guard-adapter.js";
import {
  prepareUpstreamRequest,
  notifyUpstreamResponse,
  type UpstreamToolCall,
} from "../../request-prepare-adapter.js";
import {
  createCfqStripStream,
  createCfqStripObserver,
  stripCfqFromResponseText,
} from "../../common/cfq-strip.js";
import {
  collectResponsesOutputText,
  collectResponsesToolCalls,
} from "../../common/responses-payload.js";
import { isLegacyProxyPath } from "../../routes/whitelist.js";
import { verifyUserKey } from "../../auth.js";
import { stageAuth } from "../stages/auth.js";
import { stageParseBody } from "../stages/parse-body.js";
import { stageSessionResetPreHook } from "../stages/session-reset-pre-hook.js";
import { stageSessionResetConfirmation } from "../stages/session-reset-confirmation.js";
import { stageMemCommandIntercept } from "../stages/mem-command-intercept.js";
import { countHumanTurnsResponses } from "../../turnSeq.js";
import { stageIdentity } from "../stages/identity.js";
import { stageModelGate } from "../stages/model-gate.js";
import { resolveAgentStrategy } from "../strategies/agent/index.js";
import { enforceRateLimit, isRateLimitExceededError } from "../../rate-limit/guard.js";
import { resolveModelId } from "../../pricing.js";
import { codexAdapter } from "../../agent-adapters/codex.js";
import {
  DEFAULT_GATE_PREFIX,
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "../../session/codex/form.js";
import { buildCodexInjectionBlock, type CodexInjectionInput } from "../../common/codex-injection.js";
import { log } from "../../report/log.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import { TdaiClient, buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { stageArchive } from "../stages/archive.js";
import { stageCredit } from "../stages/credit.js";
import {
  stageWriteUsageLog,
  stageRecordTokenUsage,
  stageEmitModelIntent,
  stageOpikStreamSpan,
} from "../stages/stream-finalize.js";
import { stagePrewarmInjection } from "../stages/prewarm-injection.js";
import { stageAssetCapabilities } from "../stages/asset-capabilities.js";
import { stageSessionBypass } from "../stages/session-bypass.js";
import { stageSessionInitOrchestrate } from "../stages/session-init-orchestrate.js";
import {
  stageInstanceUpstreamResponses,
  isInstanceUpstreamBlocked,
} from "../stages/instance-upstream-responses.js";

// ── Constants ────────────────────────────────────────────────────────────────

// SKIP header sets have been merged into common/constants.ts (codex uses the WITH_INTERNAL version)
import { SKIP_REQUEST_HEADERS_WITH_INTERNAL as SKIP_REQUEST_HEADERS, filterResponseHeaders } from "../../common/constants.js";

// ── TDAI L0 helpers (aligned with the anthropicHandler / handler approach) ───────────────────

/**
 * TDAI L0 client factory — semantically consistent with anthropicHandler.ts::createTdaiClient.
 * spaceId takes priority over the config default serviceId, so that codex requests in a multi-tenant setup are reported to the correct
 * kernel instance. Returns null when config.tdai.memory.enabled=false.
 */
const createCodexTdaiClient = buildTdaiClientForRequest;

/**
 * Extract the last real user text with role=user from codex `input[]` and assemble a TdaiMessage.
 * Equivalent to the codex variant of tdai/recorder.ts::extractLatestUserMessage — the difference is in the
 * traversal criterion (type==="message" && role==="user") and the text extraction (content[].input_text).
 * Reuses codexAdapter.extractUserText, ensuring the same user question text is used as the langfuse traceInput in
 * codexHandler (docs/2026-08-07-codex-integration-plan.md §9).
 */
function extractLatestCodexUserMessage(input: unknown): TdaiMessage | null {
  if (!Array.isArray(input)) return null;
  const text = codexAdapter.extractUserText(input) ?? "";
  const trimmed = text.trim();
  if (!trimmed) return null;
  return { role: "user", content: trimmed };
}

// ── Codex session state (exported for unit tests) ────────────────────────────

export interface CodexSessionState {
  status: "initialized" | "pending";
  bypassed?: boolean;
  sessionInfo?: Record<string, unknown> | null;
}

// ── Aux detection (exported for unit tests) ──────────────────────────────────

/** Aux endpoint path suffixes — hardcoded in codex-rs/core/src/client.rs. */
const CODEX_AUX_PATH_SUFFIXES = new Set([
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
]);

/** Known aux thread_source values. */
const CODEX_AUX_THREAD_SOURCES = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * Classify a codex request as main or auxiliary.
 * Exported for unit tests.
 */
export function classifyCodexRequest(
  body: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): "main" | "auxiliary" {
  // Signal 1: aux endpoint path suffix
  for (const suffix of CODEX_AUX_PATH_SUFFIXES) {
    if (path.endsWith(suffix)) return "auxiliary";
  }

  // Signal 2: x-openai-memgen-request header
  if (headers["x-openai-memgen-request"] === "true") return "auxiliary";

  // Signal 3: body.client_metadata.thread_source whitelist
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && CODEX_AUX_THREAD_SOURCES.has(ts)) return "auxiliary";

  return "main";
}

// ── Session ID extraction (exported for unit tests) ──────────────────────────

/**
 * Extract session_id from codex request.
 * Primary: `session-id` header. Fallback: `body.client_metadata.session_id`.
 *
 * subagent normalization: requests carrying x-parent-conversation-id (parallel subagents) always use the
 * parent id as the session identity, reusing the main session state to avoid re-popping the session-init form.
 * Fully mirrors workbuddyHandler.extractWorkbuddySessionId
 * (fixed 2026-09-20: WorkBuddy infinite loop after compaction; see the comments in session/session-key.ts for details).
 */
export function extractCodexSessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  const parentId = headers["x-parent-conversation-id"] ?? headers["X-Parent-Conversation-Id"];
  if (typeof parentId === "string" && parentId.length > 0) return parentId;

  if (headers["session-id"]) return headers["session-id"];
  const meta = body.client_metadata as { session_id?: string } | undefined;
  if (typeof meta?.session_id === "string") return meta.session_id;
  return null;
}

// ── Default mode gate detection (exported for unit tests) ────────────────────

/**
 * Scan codex input[] for the Default mode gate string in function_call_output.
 *
 * When the client is in Default mode, it intercepts `request_user_input` tool
 * calls and fabricates a `function_call_output.output` starting with
 * "request_user_input is unavailable in".
 *
 * This function is a legacy utility; the actual interception logic is now internalized into the CB state machine
 * (the codex-only pre-checks section of session/codebuddy/init.ts). The export is kept
 * because codex-handler.test.ts has unit tests that use it directly to verify structure recognition.
 */
export function detectDefaultModeGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // Only recognizes "the last item of input is the gate output": see the same-named comment in codebuddy/init.ts for details.
  const last = input[input.length - 1] as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return false;
  if (last.type !== "function_call_output") return false;
  const output = last.output;
  return typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX);
}

// ── Asset injection (exported for unit tests) ────────────────────────────────

/**
 * Inject `<tdai_injections>` wrapper into codex body.input[0].content[].
 *
 * Appends the injection block to the developer message (input[0]) content.
 * Defensive: if input[0] is not a message with an array content, returns
 * the body unchanged.
 *
 * Returns a shallow copy — original body is not mutated.
 */
export function injectCodexAssets(
  body: Record<string, unknown>,
  assets: CodexInjectionInput,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  const devMsg = input[0] as Record<string, unknown> | null;
  if (!devMsg || typeof devMsg !== "object") return body;
  if (devMsg.type !== "message") return body;

  const content = devMsg.content;
  if (!Array.isArray(content)) return body;

  const injectionBlock = buildCodexInjectionBlock(assets);

  // Shallow-copy chain: body → input → input[0] → content
  const newContent = [...content, injectionBlock];
  const newDevMsg = { ...devMsg, content: newContent };
  const newInput = [newDevMsg, ...input.slice(1)];
  return { ...body, input: newInput };
}

// ── Upstream request helpers ─────────────────────────────────────────────────

function buildUpstreamHeaders(
  c: Context,
  config: ProxyConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  // Codex uses OpenAI protocol: inject Bearer token
  if (config.upstream.apiKey) {
    headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
    delete headers["x-api-key"];
  }
  return headers;
}

// filterResponseHeaders merged into common/constants.ts

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * Codex endpoint handler.
 *
 * Routes internally:
 *   - aux endpoints → lightweight passthrough
 *   - main /v1/responses → full pipeline (session-init, injection, mem-command, forward)
 */
export async function runCodexPipeline(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth (via shared stageAuth) ─────────────────────────────────────
  const auth = await stageAuth(c, "bearer-first");
  const apiKey = auth.apiKey;
  const spaceId = auth.spaceId;
  const userId = auth.userId;
  if (auth.rejected) {
    return c.json(
      { error: `Authentication failed: ${auth.rejectReason ?? "unknown"}` },
      401,
    );
  }
  const keyId = auth.keyId;

  // ── 2. Read body (via shared stageParseBody) ─────────────────────────
  const parseResult = await stageParseBody(c);
  if (!parseResult.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // Warning: `let` must not be changed back to `const`: the § 9 injection stage below (around line 770)
  // will replace in place with `body = injectCodexAssets(body, ...)`, the new injected object.
  // c6fa775d (stageParseBody migration) accidentally changed it to const, causing runtime to
  // throw "Assignment to constant variable", and after the catch it degraded to **passthrough without injection** —
  // codex's skill/memory/session_context were all lost from then on. TS 2588 kept reporting a warning
  // but it was treated as a "refactor-leftover baseline error" and nobody fixed it.
  let body = parseResult.body;

  // ── 3. Extract headers as plain object ─────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  // ── Identity instrumentation (bug B5 fix: old codex did not call inspectAndRecord) ────────────
  // Gated by agent.stageGates.identityRecord (codex now uses the full preset, always true).
  // Historically codex started at minimal and needed an explicit flip; later, because the B1-B8 fixes do not take effect under minimal,
  // it was uniformly changed to full; the gate criterion is kept so it can be rolled back by tier.
  const codexAgent = resolveAgentStrategy("codex");
  const reqHeadersForIdentity: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) reqHeadersForIdentity[k] = v;
  if (codexAgent.stageGates.identityRecord) {
    stageIdentity(c, body, "codex");
  }

  // ── DEBUG: dump request_user_input tool schema once so we can see codex's
  //           expected arguments shape and fix our fake form. Remove after fix.
  try {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const rui = tools.find(
      (t: any) => t?.type === "function" && t?.name === "request_user_input" ||
                  t?.function?.name === "request_user_input" ||
                  t?.name === "request_user_input",
    );
    if (rui) {
      console.log("[codex-debug] request_user_input tool schema:", JSON.stringify(rui));
    }
  } catch {}

  // ── 4. Classify request ────────────────────────────────────────────────────
  const requestKind = classifyCodexRequest(body, path, headers);
  const isAuxiliary = requestKind === "auxiliary";
  // The call signature is resolveModelId(creditPricingConfig, requestedModel) — previously
  // body was wrongly passed as the first argument (config omitted), so the return value was the whole body object. This bug
  // has existed since the very first frame of the codex P1 integration; it was not found earlier because codex had no langfuse integration — after integration
  // the Langfuse trace name / observation name all became " / usr-xxx" with an empty-string prefix.
  // Aligned with the call approach in handler.ts:482 / anthropicHandler.ts.
  const requestedModel = typeof body.model === "string" ? body.model : "";

  // ── Model gate + alias (bug B8 fix: old codex did not check the pricing table at all) ──
  // Gated by agent.stageGates.modelGate (codex now uses the full preset, always true).
  // Equivalent to openai-chat + anthropic behavior.
  // isCustomUpstream decision: reuse the shouldOverride result already computed by stageInstanceUpstreamEarly
  // (but the old codex code did not go through this early stage, so it is computed independently here — conservatively skipping the gate only in aux scenarios)
  const _spaceIdForGate = extractSpaceIdFromPath(path) ?? "";
  let _codexIsCustomUpstream = false;
  if (codexAgent.stageGates.modelGate && !isAuxiliary) {
    try {
      const { getInstanceUpstreamConfigs, resolveForAgent, shouldOverride } =
        await import("../../instance-upstream-cache.js");
      const cfgs = await getInstanceUpstreamConfigs(config.coreSkill, _spaceIdForGate, config.instanceUpstream);
      _codexIsCustomUpstream = shouldOverride(resolveForAgent(cfgs, "codex"));
    } catch {
      _codexIsCustomUpstream = false;
    }
    if (!_codexIsCustomUpstream) {
      const gateResult = stageModelGate(requestedModel, config, false);
      if (!gateResult.ok) {
        return c.json({
          type: "error",
          error: { type: "invalid_request_error",
            message: `Model '${requestedModel}' is not a registered display name in the credit pricing table` },
        }, 400);
      }
    }
  }

  const modelId = resolveModelId(config.creditPricing, requestedModel);
  // The external display name is only used for client requests; TokenHub only accepts the real service IDs registered in the price list.
  if (typeof body.model === "string" && modelId !== requestedModel) {
    body.model = modelId;
  }

  const pipe = createPipeline(config, traceId, modelId);

  // ── 5. Aux passthrough ─────────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("CODEX_AUX", `auxiliary request → passthrough (path=${path})`);
    // aux does not report to langfuse (aligned with CC/CB — sidequery/fork-type aux are not real conversation turns)
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, null);
  }

  // ── 6. Session ID extraction ───────────────────────────────────────────────
  const sessionId = extractCodexSessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "codex";
  const isStream = body.stream !== false;

  const callerUserKey = apiKey || null;

  // ── 6b. Langfuse turn context (one trace = one turn) ────────────────────────
  // codex's turn sequence number is derived from the number of "human inputs" in body.input[] (same as the CC/CB convention;
  // tool-loop requests within the same turn compute the same turnSeq → the same trace). The user question
  // goes through the codex adapter's extractUserText — codex uses input[] rather than messages[],
  // and the generic resolveLatestUserQuery relies on the costGuard profile going through messages[], which does not fit here.
  const turnSeq = countHumanTurnsResponses(body.input);
  const userQuery = codexAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    // The agent_source tag identifies the client family; protocol:responses distinguishes codex's wire.
    tags: [
      `agent_source:${agentSource}`,
      "protocol:responses",
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
    ],
    routeTags: [],
    userQuery,
  };

  // ── 6c. Legacy /proxy/<spaceId> — routing + compression + billing only ───────────────────
  // This prefix carries no agent segment, so the client identity reaching here cannot be determined. Memory features are all skipped:
  // showing a form by the wrong agent profile, intercepting mem commands, and injecting assets into the context is worse than doing nothing.
  // archiveCtx=null turns off both skill extraction and TDAI L0 writes; lf is still constructed, compression,
  // billing and usage table writes remain as usual.
  if (isLegacyProxyPath(path)) {
    pipe.info("CODEX_LEGACY_PROXY", `legacy /proxy prefix → route+compress only (path=${path})`);
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, null);
  }

  // ── 7. Session-init state machine ──────────────────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("../../injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  // Store the agent/task detail of initResult for the § 9 injection stage to construct <session_context>.
  // handleSessionInit would have stuffed session_context into messages[0] internally, but that
  // messages is the temporary synthesizedMessages we passed in, and does not return to the codex body.
  // Here we explicitly capture the detail so that when synthesizing the body below, buildSessionContextBlockWithToggles
  // builds the same block and pre-fills it in front of the synthesized system message.
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook (via shared stage) ──
  {
    const { codexAdapter } = await import("../../agent-adapters/codex.js");
    const userText = codexAdapter.extractUserText(input) ?? "";
    const _resetResp = await stageSessionResetPreHook({
      c, config, body: body as Record<string, unknown>, agentSource, sessionKey, spaceId, userId,
      isAuxiliary: false, dshHeadless: false, isStream,
      protocol: "responses", userText, enabled: true,
    });
    if (_resetResp) return _resetResp;
  }

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ────
  //
  // The old version's 7a (Default gate standalone interception) + 7b.1 (MORE standalone interception) have converged into the CB state machine
  // (the codex-only pre-checks section at the top of session/codebuddy/init.ts). codexHandler is only
  // responsible for passing body.input[] through to reqCtx.codexAnswerInput so the state machine recognizes the gate/MORE itself.
  // The first Default gate hit gets initResult.bypassReason === "default-gate", and this
  // handler returns a Plan mode hint once; later requests of the same session bypass in the steady state and pass through.
  if (config.sessionInit?.enabled && sessionId) {
    try {
      // Round 18: the session-init main orchestration goes through the shared stageSessionInitOrchestrate;
      // the 4 callbacks of codex:
      //   - synthesizeMessages: codexFormAnswersAsMessages(input)
      //   - buildRecoverInitResult: systemAppend + messages:[] (responses)
      //   - buildInterceptResponse: buildCodexFormResponse (Responses API SSE)
      //   - buildDefaultGateResponse: codex-only Plan hint (handled in the bypassReason branch below)
      const _orch = await stageSessionInitOrchestrate({
        agentSourceForState: agentSource,
        sessionKey, userId: userId || null, spaceId,
        config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
        kernelUserKey: apiKey,
        headers, recoveryMessages: [],
        synthesizeMessages: () => {
          const synth = codexFormAnswersAsMessages(input);
          const rawOutputs = input
            .filter((it: any) => it?.type === "function_call_output")
            .map((it: any) => ({ call_id: it.call_id, output_preview: String(it.output ?? "").slice(0, 200) }));
          if (rawOutputs.length > 0) {
            console.log(`[codex-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synth).slice(0, 500)}`);
          }
          return synth;
        },
        buildRecoverInitResult: async (recovered) => {
          const { buildSessionContextBlockWithToggles } = await import("../../session/context-injector.js");
          const systemAppend = recovered.bypassed
            ? null
            : buildSessionContextBlockWithToggles(
                recovered.agentDetail ?? null,
                recovered.taskDetail ?? null,
                config.sessionInit,
                sessionKey,
              );
          return { messages: [], systemAppend };
        },
        buildReqCtx: () => ({
          stream: isStream,
          modelId: modelId as string,
          protocol: "responses" as any,
          // Hand the original input[] to the CB state machine, to recognize the codex-client-specific Default gate string and MORE paging marker
          codexAnswerInput: input,
        }),
        buildInterceptResponse: (initResult) => {
          if (!initResult.formData) return initResult.response ?? null;
          return buildCodexFormResponse({
            teams: initResult.formData.teams,
            stage: initResult.formData.stage,
            selectedTeamId: initResult.formData.selectedTeamId,
            selectedAgentId: initResult.formData.selectedAgentId,
            retry: initResult.formData.retry,
            teamPage: initResult.formData.teamPage ?? 0,
            agentPage: initResult.formData.agentPage ?? 0,
            taskPage: initResult.formData.taskPage ?? 0,
            // Override stream with the current request's stream flag (the value at form creation time may be stale)
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        },
        // The Default-gate branch stays inline below (needs access to pipe.info + the complex wording branches of bypassReason)
      });
      if (!_orch.proceed) return _orch.response!;
      const initResult = _orch.initResult!;

      // ── Default gate first hit: the CB state machine has already persisted the bypass state, this handler
      //    returns a Plan mode hint once; the next request's recovered.bypassed=true goes
      //    through the initialized branch to pass through directly, so the Plan hint is not repeated.
      if ((initResult as any).bypassReason === "default-gate") {
        pipe.info("CODEX_GATE", "Default mode gate detected → notify user (first hit)");
        const { buildMemResponse } = await import("../../mem-command/response-builder.js");
        // Gate in the reset scenario: the user explicitly sent the mem:session-reset command,
        // but the codex client is not in Plan mode and cannot show a form → the wording needs to state clearly
        // "the reset command requires Plan mode" rather than the vague "asset features are not enabled".
        const gateText = (initResult as any).resetFlow
          ? "⚠️ mem:session-reset requires Plan mode support.\n\n"
            + "The codex client is not currently in Plan mode, so the asset selection form cannot be shown.\n"
            + "Please switch to Plan mode and then run mem:session-reset."
          : "Plan mode was not detected as enabled; team-asset features (Skill / Task / Agent) will not be enabled for this conversation. "
            + "To use them, please switch to Plan mode and start a new session.";
        return buildMemResponse(gateText, {
          protocol: "responses",
          stream: isStream,
          requestId: `codex-gate-${Date.now()}`,
        });
      }

      if (initResult.justRegistered) sessionJustRegistered = true;
      // Bypass path → skip injection (via shared stageSessionBypass)
      const _bypassResult = stageSessionBypass({
        bypassed: !!initResult.bypassed,
        resetFlow: !!initResult.resetFlow,
        sessionKey,
        logPrefix: "[codex]",
      });
      if (_bypassResult.skipInjection) injectionSkipped = true;
      if (_bypassResult.resetFlowResult) _resetFlowResult = _bypassResult.resetFlowResult as unknown as typeof _resetFlowResult;

      assetCapabilities = await stageAssetCapabilities({
        bypassed: !!initResult.bypassed,
        sessionInfo: initResult.sessionInfo,
        config, spaceId,
        userKey: callerUserKey,
        warnPrefix: "[codex] asset-capability resolve failed:",
      });

      // Prewarm pre-short-circuit: a turn hit by a mem-command does not go through forward and does not consume the hook-cache;
      // prewarming as usual would waste 2-3s + 3 network requests. See the detailed note at the symmetric position in handler.ts.
      let memCommandPending = false;
      {
        try {
          const userTextPeek = codexAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText } = await import("../../mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek) {
              memCommandPending = true;
              console.log(`[codex] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
            }
          }
        } catch (err) {
          console.warn(
            "[codex] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Prewarm injection pipeline cache (same as anthropicHandler)
      await stagePrewarmInjection({
        bypassed: !!initResult.bypassed,
        justRegistered: !!initResult.justRegistered,
        sessionInfo: initResult.sessionInfo,
        agentDetail: initResult.agentDetail,
        taskDetail: initResult.taskDetail,
        memCommandPending,
        config, sessionKey, userId, agentSource, spaceId, assetCapabilities,
        callerUserKey: callerUserKey ?? undefined,
        logTag: "[codex] prewarm error:",
      });

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      // Cache the detail for § 9 below (constructing the <session_context> block) — written by both branches:
      // the initResult of the recovered branch is assembled by hand by us, the walked-through branch comes from
      // handleSessionInit's return; the fields are all the agent/taskDetail in SessionInitResult.
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

      // Record resetFlow to the outer scope for returning the confirmation response outside the block
      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "Unknown",
          // The agentIdShort field name keeps its historical name, but here **the full agent_id is stored** (e.g. agt-1celthr7yn).
          // Previously slice(-8) truncated it to "elthr7yn" which users could not understand, symmetric with the team truncation issue.
          agentIdShort: initResult.sessionInfo?.agent_id
            ? String(initResult.sessionInfo?.agent_id) : "",
          // teamName + full teamId: see the symmetric comment in handler.ts.
          teamName: initResult.teamName ?? undefined,
          teamId: initResult.sessionInfo?.team_id
            ? String(initResult.sessionInfo?.team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[codex] session-init error:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectionSkipped = true;
    }
  }

  // ── mem:session-reset completion confirmation (via shared stage) ────────────────────────
  if (_resetFlowResult) {
    return stageSessionResetConfirmation({
      resetFlowResult: _resetFlowResult,
      protocol: "responses",
      isStream,
    });
  }

  // ── 8. mem-command intercept ────────────────────────────────────────────────
  // Position: after session-init, before injection (same as CC/CB).
  //
  // Warning: do not go through parseMemCommand(body, ...) — that function only parses body.messages[] (CC/CB
  // shape), and a codex body uses input[], so it returns null immediately → all mem commands silently pass through to the
  // LLM, and the model fabricates fake replies like "Memory synced" (P0-1 QA report).
  // Directly use the already-extracted userText to go through parseCommandFromText.
  // ── 8. mem-command intercept (via shared stage) ────────────────────────
  {
    const userText = codexAdapter.extractUserText(input);
    if (userText) {
      const { extractSimpleMessages } = await import("../../mem-command/index.js");
      const memResp = await stageMemCommandIntercept({
        enabled: true,
        body: body as Record<string, unknown>,
        agentSource: "codex", sessionKey,
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        injectionSkipped, sessionJustRegistered: false,
        config, spaceId, userId: userId || "", apiKey: apiKey || "",
        callerUserKey: callerUserKey ?? undefined,
        isStream, protocol: "responses",
        modelId,
        upstreamUrl: config.upstream.agents?.["codex"]?.url || config.upstream.url,
        messages: input,
        createTdaiClientFn: createCodexTdaiClient,
        bodyMessages: extractSimpleMessages(input),
        assistantContentFormat: "responses-message",
        startTime, keyId, assetCapabilities,
        upstreamProtocol: "responses",
        userText,
        langfuseCtx: {
          traceId: lf.traceId,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: lf.tags,
        },
      });
      if (memResp) return memResp;
    }
  }

  // ── 9. Asset injection (every turn, no caching) ────────────────────────────
  // Only inject when session is initialized and not bypassed.
  //
  // Strategy: run the existing injection pipeline on a synthetic OpenAI-shaped
  // body (with an empty system message). The pipeline appends text blocks to
  // the system message's content — we extract those appended blocks and
  // re-package them as `<tdai_injections>` for the codex body format.
  //
  // This reuses 100% of the existing pipeline infrastructure (hook cache,
  // prewarm, all injectors) without writing a third protocol adapter.
  if (!injectionSkipped && sessionInfo && config.injection?.enabled && (config.injection.injectors?.length ?? 0) > 0) {
    try {
      const { getInjectionPipeline } = await import("../../injection/index.js");
      const pipeline = getInjectionPipeline(config);

      // ── session_context pre-fill ────────────────────────────────────────────────
      // The CB init of handleSessionInit stuffs <session_context> ([Agent]+[Task] descriptions)
      // into the messages[0] it holds internally (the temporary array we passed it), and this messages
      // is not returned to the codex handler; meanwhile initResult.systemAppend is only
      // filled on the CC branch, and always undefined on the CB branch. As a result the codex side only gets the skill/memory/knowledge
      // segments, and **the agent/task description is not injected into the final body at all**.
      //
      // Fix: directly use buildSessionContextBlockWithToggles to build the same block from the
      // agentDetail/taskDetail already stored on the handler side, and pre-fill it into the system
      // message of the synthesized body; pipeline.process below continues to append
      // more injected content after the same system message, and in the end raw mode extracts them together → the developer segment contains session_context.
      const { buildSessionContextBlockWithToggles } = await import("../../session/context-injector.js");
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as any,
        cachedTaskDetail as any,
        config.sessionInit,
        sessionKey,
      );

      // Build a synthetic OpenAI body that the pipeline can parse/serialize.
      // The pipeline's OpenAI adapter reads `body.messages` and injects
      // text into the system message. We use a single system message as
      // the injection target; all injected text ends up there.
      const syntheticBody: Record<string, unknown> = {
        messages: [
          { role: "system", content: sessionContextBlock ?? "" },
          { role: "user", content: "." },
        ],
        model: modelId,
      };

      const injectedBody = await pipeline.process(syntheticBody, {
        protocol: "openai",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: 0,
        requestPath: c.req.path,
        custom: { session: sessionInfo, userKey: callerUserKey ?? undefined, assetCapabilities },
      });

      // Extract injected content from the synthetic body's system message.
      // The pipeline appends to `messages[0].content` (system message).
      const injectedMessages = injectedBody.messages as Array<Record<string, unknown>> | undefined;
      const sysMsg = injectedMessages?.[0];
      const injectedText = typeof sysMsg?.content === "string" ? sysMsg.content : "";

      if (injectedText.length > 0) {
        // The injectedText produced by the Pipeline is already **finished XML text** (containing
        // <skill_tools> / <available_skills> / <user_memory> /
        // multiple groups of internal tags such as <tdai_profile_memory> / <memory-tools-guide>),
        // byte-identical to what CC / CB clients see in the system message.
        // Go through raw mode and embed as is inside the <tdai_injections> wrapper — no longer wrapping
        // an inner <available_skills> tag, and not escaping the XML tags inside the content,
        // otherwise the model would see escaped characters (`&lt;user_memory&gt;`) and could not read the structure.
        body = injectCodexAssets(body, { raw: injectedText });
      }
    } catch (err: unknown) {
      console.error("[codex] injection pipeline error:", err instanceof Error ? err.message : String(err));
      // Degrade gracefully: forward without injection
    }
  }

  // ── 10. Build archive ctx (skill + tdai L0), forward, tap for hooks ──────
  //
  // Only build ctx in the steady state of main dialog + initialized + not bypassed — the injectionSkipped
  // scenario aligns with the CC/CB "skip L0/skill" branch (when sessionInfo lacks the team/user/agent trio,
  // triggerSkillExtractIfReady itself also exits early, but deciding up front saves one fanout).
  const archiveCtx = buildArchiveCtx({
    config,
    sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
    injectionSkipped,
    input,
    sessionKey,
    agentSource,
    spaceId,
    userId,
    callerUserKey,
    assetCapabilities,
  });

  // ── 11. Forward to upstream ────────────────────────────────────────────────
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, archiveCtx);
}

// ── Archive context (skill/conversation/add + TDAI L0 write) ─────────────────

/**
 * Archive trigger context — packages all inputs the hook needs, built from handleCodexEndpoint and
 * passed all the way to the tail of completeStream in consumeCodexStream to trigger the skill/L0 hooks.
 *
 * Created only for main dialog + initialized session + not bypassed; in other cases archiveCtx=null,
 * and the forward side skips the hooks on null (aligned with the isMainDialog branch of CC/CB).
 */
export interface CodexArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  spaceId: string;
  /**
   * The original codex `input[]` — when skill archiving, with protocol="responses" it goes through
   * normalize-conversation's internal convertCodexInputItem to expand.
   */
  input: unknown[];
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  /** The latest user question extracted from `input[]` (extracted by extractLatestCodexUserMessage). */
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
}

function buildArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  agentSource: string;
  spaceId: string;
  userId: string;
  callerUserKey: string | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
}): CodexArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  const tdaiClient = args.assetCapabilities?.chat_memory === false
    ? null
    : createCodexTdaiClient(args.config, args.spaceId);
  const tdaiIdentity = deriveTdaiIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey,
  });
  const tdaiUserMessage = extractLatestCodexUserMessage(args.input);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: args.agentSource,
    sessionInfo,
    spaceId: args.spaceId,
    input: args.input,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
    assetCapabilities: args.assetCapabilities,
  };
}

/**
 * After the stream ends, trigger skill/conversation/add + TDAI L0 write, aligned with the
 * anthropicHandler.ts:1867-1948 section of CC/CB.
 *
 * Parameters:
 *   assistantText: assistant text accumulated by the SSE accumulator
 *   toolUseCount:  number of function_calls accumulated in the stream (round boundary criterion)
 *
 * Failures are silent (errors already logged), never blocking the upstream response chain.
 *
 * Goes through the shared stages/archive.ts::stageArchive (tdaiWriteMode="fire-and-forget-tracked"),
 * the responses assistantMessage shape (type:"message", role:"assistant",
 * content:[{type:"output_text", text}]) is assembled by this function and handed to the stage.
 */
async function triggerCodexArchiveHooks(
  ctx: CodexArchiveCtx,
  assistantText: string,
  toolUseCount: number,
): Promise<void> {
  const assistantMessage = assistantText
    ? {
        type: "message" as const,
        role: "assistant" as const,
        content: [{ type: "output_text" as const, text: assistantText }],
      }
    : null;
  await stageArchive({
    config: ctx.config,
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    sessionInfo: ctx.sessionInfo,
    inputMessages: ctx.input,
    assistant: { text: assistantText, raw: assistantMessage },
    protocol: "responses",
    assetCapabilities: ctx.assetCapabilities,
    tdaiClient: ctx.tdaiClient,
    tdaiIdentity: ctx.tdaiIdentity ?? undefined,
    tdaiUserMessage: ctx.tdaiUserMessage ?? undefined,
    isAuxiliary: false,
    dshHeadless: false,
    tdaiWriteMode: "fire-and-forget-tracked",
    toolCallCountOverride: toolUseCount,
    logPrefix: "[codex-tdai-l0]",
  });
}

// ── Forward helper ───────────────────────────────────────────────────────────

async function forwardToUpstream(
  c: Context,
  config: ProxyConfig,
  body: Record<string, unknown>,
  traceId: string,
  startTime: string,
  keyId: string,
  modelId: string,
  pipe: ReturnType<typeof createPipeline>,
  lf: LangfuseTurnContext | null,
  archiveCtx: CodexArchiveCtx | null = null,
): Promise<Response> {
  // Per-agent upstream override (upstream.agents.codex.url) takes priority over the global url.
  // Aligned with the resolution approach at anthropicHandler.ts:1029. codex usually needs to point separately at a compatibility layer
  // that supports the Responses API — some OpenAI-compatible upstreams only implement
  // messages/chat_completions and do not support /responses; overriding per agent is allowed here.
  const agentUpstreamEntry = config.upstream.agents?.["codex"];
  let upstreamBase = agentUpstreamEntry?.url || config.upstream.url;
  let upstreamUrl = joinUrl(upstreamBase, c.req.path);
  const upstreamHeaders = buildUpstreamHeaders(c, config);
  let skipCreditReport = false;
  upstreamHeaders["content-type"] = "application/json";
  // Overriding apiKey is consistent with the per-agent policy: agentUpstreamEntry.apiKey takes priority,
  // otherwise pass through the client Bearer.
  if (agentUpstreamEntry) {
    if (agentUpstreamEntry.apiKey) {
      upstreamHeaders["authorization"] = `Bearer ${agentUpstreamEntry.apiKey}`;
    }
    // else: keep the client key in c.req.header('authorization') and pass it through
  }

  // ── Instance upstream config override (codex has no cost-guard routing) ──
  // v2 model groups (§7.3): go through the shared stageInstanceUpstreamResponses (shared with wb).
  // 4-state handling: blocked/unmanaged → 400; override → replace upstream; official → keep.
  // `/proxy/<spaceId>` carries no agent segment: force official (forceOfficial=true), to avoid
  // unmanaged → 400 blocking the protocol route when the instance has not written codex into the agents list.
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const _upstreamResolve = await stageInstanceUpstreamResponses({
    agent: "codex",
    spaceId,
    config,
    pathForOverride: c.req.path,
    forceOfficial: isLegacyProxyPath(c.req.path),
  });
  if (isInstanceUpstreamBlocked(_upstreamResolve)) {
    return c.json(_upstreamResolve.errorBody, 400);
  }
  if (_upstreamResolve.overrideUrl) {
    upstreamUrl = _upstreamResolve.overrideUrl;
    if (_upstreamResolve.headerUpdates?.authorization) {
      upstreamHeaders["authorization"] = _upstreamResolve.headerUpdates.authorization;
    }
    // codex has no x-api-key support, deleteXApiKey is a no-op
    if (_upstreamResolve.bodyModelOverride && typeof body.model === "string") {
      body.model = _upstreamResolve.bodyModelOverride;
    }
  }
  if (_upstreamResolve.skipCreditReport) skipCreditReport = true;

  // Optional private preparation stage. It rewrites `body` and the `input[]`
  // items in place, so it has to land after every host-side mutation (model
  // resolution, instance override) and before the body is serialized below.
  //
  // Auxiliary turns are excluded for the same reason they skip langfuse and
  // archive: they are client-driven background calls, not dialogue turns.
  let preparedStats: Record<string, unknown> | null = null;
  if (lf && Array.isArray(body.input)) {
    preparedStats = await prepareUpstreamRequest({
      config,
      protocol: "responses",
      body,
      messages: body.input,
      sessionKey: lf.sessionId,
      spaceId,
      pipe,
      upstreamCall: {
        upstreamUrl,
        headers: upstreamHeaders,
        model: modelId,
        tools: body.tools,
      },
      userQuery: lf.userQuery,
      lf,
      opikTraceId: traceId,
      opikKeyId: keyId,
    });
  }

  pipe.forwardStart(upstreamUrl);

  // ── Opik: create trace (bug B7 fix lost during migration, restored this time) ──────────────────
  // Aligned with anthropic.ts / openai-chat.ts: the trace must be created before the span,
  // otherwise the closing opikCreateLlmSpan would carry an empty trace_id and be rejected by Opik (422 traceId
  // must not be null), making the whole codex chain completely invisible on the Opik side.
  // When opik.enabled=false it is an internal no-op (returns "").
  let forkTraceId: string | undefined;
  try {
    const { extractSimpleMessages: extractForOpik } = await import("../../mem-command/index.js");
    const inputMessages = extractForOpik(body.input);
    forkTraceId = opikCreateTrace(config, {
      traceId,
      projectName: keyId,
      name: `${modelId} / ${keyId}`,
      startTime,
      input: { messages: inputMessages },
      tags: lf?.tags ?? [],
      forkProjectName: "request_log",
      forkMetadata: {
        keyId,
        modelId,
        stream: true,
        upstreamUrl,
      },
    });
  } catch (opikErr: unknown) {
    pipe.error("OPIK_TRACE", opikErr instanceof Error ? opikErr : new Error(String(opikErr)));
  }

  // Bug B9 fix (handler-audit): the old codex had no AbortSignal.timeout; when upstream hangs, fetch
  // hangs forever until the pod is OOM-killed. Add a timeout fallback (aligned with openai-chat/anthropic).
  const forwardTimeoutMs = config.server?.forwardTimeoutMs ?? 600_000;

  // Bug B1 fix (handler-audit): the old codex did not wire enforceRateLimit at all, so when the upstream quota was
  // blown it could not protect the operator's own account. Gated by codex agent.stageGates.rateLimit (now on the full
  // preset, always true). With a custom upstream (user-paid) the user manages their own quota, so it is skipped.
  const codexAgentForForward = resolveAgentStrategy("codex");
  if (codexAgentForForward.stageGates.rateLimit && !skipCreditReport) {
    try {
      await enforceRateLimit({
        config,
        instanceId: extractSpaceIdFromPath(c.req.path) || undefined,
        modelId,
        protocol: "openai",
      });
    } catch (rlErr: unknown) {
      if (isRateLimitExceededError(rlErr)) {
        pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
        return rlErr.response;
      }
      throw rlErr;
    }
  }

  let upstreamResp: Response;
  try {
    const fetchOpts: RequestInit = {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    };
    if (forwardTimeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
    }
    upstreamResp = await fetch(upstreamUrl, fetchOpts);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.error("CODEX_FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
    } else {
      pipe.error("CODEX_FORWARD", err instanceof Error ? err : new Error(String(err)));
    }
    // Report langfuse failure (forwarding exception — upstream returned no response body, only a local fetch error was thrown)
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildCodexLangfuseInput(body),
          statusMessage: `forward error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: { stage: "forward", stream: true, upstreamUrl },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return c.json(
      { error: "Upstream request failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  pipe.forwardDone(upstreamResp.status, upstreamResp.headers.get("x-request-id") ?? undefined);

  // Log usage
  writeLog(config, {
    timestamp: startTime,
    event: "request",
    modelId,
    keyId,
    sessionKey: keyId,
    upstreamUrl,
    stream: true,
    traceId,
  });

  // ── Upstream 4xx/5xx: copy the body text for langfuse error reporting; on success, tap ──
  // The codex Responses API only has SSE streaming responses, with no stream / non-stream distinction.
  if (upstreamResp.status >= 400) {
    // 4xx/5xx usually return a JSON error (very small); read it fully and include it in langfuse for easier troubleshooting
    const errText = await upstreamResp.text();
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildCodexLangfuseInput(body),
          status: upstreamResp.status,
          statusMessage: errText.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: { stage: "upstream", stream: true, upstreamUrl },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return new Response(errText, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  const responseHeaders = filterResponseHeaders(upstreamResp.headers);
  // Upstream request id — for cross-system tracing: the x-request-id the client gets → our usage_logs → upstream logs.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const responseText = await upstreamResp.text();
    let usage: Record<string, unknown> | undefined;
    let toolCalls: UpstreamToolCall[] = [];
    let outputText = "";
    try {
      const responseBody = JSON.parse(responseText) as Record<string, unknown>;
      if (responseBody.usage && typeof responseBody.usage === "object") {
        usage = responseBody.usage as Record<string, unknown>;
      }
      toolCalls = collectResponsesToolCalls(responseBody.output);
      outputText = collectResponsesOutputText(responseBody);
    } catch {
      // Preserve an unexpected non-JSON response without billing it.
    }
    if (lf) {
      void notifyUpstreamResponse(config, {
        protocol: "responses",
        sessionKey: lf.sessionId,
        model: modelId,
        stream: false,
        turnSeq: lf.turnSeq,
        text: outputText,
        toolCalls,
        usage: usage ?? {},
      }, pipe);
    }
    if (usage && Object.keys(usage).length > 0) {
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId,
        keyId,
        sessionKey: lf?.sessionId ?? keyId,
        turnSeq: lf?.turnSeq,
        userInput: lf?.userQuery || undefined,
        upstreamUrl,
        stream: false,
        usage,
        requestReceivedAt: startTime,
        extensionStats: preparedStats ?? undefined,
        spaceId,
        upstreamRequestId,
      });
      await stageRecordTokenUsage({
        config, gates: codexAgentForForward.stageGates,
        isCustomUpstream: skipCreditReport,
        spaceId,
        modelId, usage, protocol: "responses",
      }).catch((rlErr: unknown) => pipe.error("RATE_LIMIT_RECORD", rlErr));
      // stageCredit uniformly goes through the shared billing implementation (aligned with openai-chat / anthropic)
      const _creditResult = await stageCredit({
        skipCreditReport,
        config,
        path: c.req.path,
        usage,
        effectiveModel: modelId,
        upstreamUrl,
        event: "usage",
        startTime: new Date(startTime),
        reqIds: pipe.ids(),
        upstreamRequestId,
        sessionKey: lf?.sessionId ?? keyId,
        stream: false,
        keyId,
        routedFrom: "",
      }, pipe);
      if (_creditResult.responseErrorHeader) {
        responseHeaders.set("x-credit-report-error", _creditResult.responseErrorHeader);
      }
    }
    // Last mile: notify / logging / billing have all seen the original response; only now do we touch the copy for the client.
    const clientResponseText = stripCfqFromResponseText(
      "responses",
      responseText,
      preparedStats,
      createCfqStripObserver(pipe),
    );
    return new Response(clientResponseText, {
      status: upstreamResp.status,
      headers: responseHeaders,
    });
  }

  // 2xx: aux scenarios (lf=null && archiveCtx=null) pass through directly without tap; main-dialog scenarios tap
  // one copy for langfuse reporting + the skill/L0 archive hooks (P1-P2 gap fix).
  // As long as either lf or archiveCtx is non-null, a tap stream must be tee'd.
  // Main turns are tapped for observability/archive; auxiliary Responses calls
  // are tapped for credit only.
  const needTap = Boolean(lf) || Boolean(archiveCtx) || !skipCreditReport;
  if (!needTap || !upstreamResp.body) {
    // Strip even without tap: whether injection happened is unrelated to observability, and client-side validation rejects it equally.
    return new Response(
      upstreamResp.body
        ? upstreamResp.body.pipeThrough(createCfqStripStream(
            "responses",
            preparedStats,
            createCfqStripObserver(pipe),
          ))
        : null,
      {
        status: upstreamResp.status,
        headers: filterResponseHeaders(upstreamResp.headers),
      },
    );
  }

  const [rawClientStream, tapStream] = upstreamResp.body.tee();
  consumeCodexStream(tapStream, {
    lf,
    modelId,
    startTime,
    upstreamUrl,
    inputBody: body,
    pipe,
    config,
    requestPath: c.req.path,
    keyId,
    sessionKey: lf?.sessionId ?? keyId,
    spaceId,
    // Opik trace id — must be the one generated by opikCreateTrace (the pipeline's internal
    // traceId has the same value, but passing it explicitly avoids silent misalignment if the two diverge in the future).
    traceId,
    forkTraceId,
    upstreamRequestId,
    skipCreditReport,
    preparedStats,
    archiveCtx,
  });

  // CFQ stripping comes last: the tap goes through another tee branch and still reads the model's raw output.
  return new Response(
    rawClientStream.pipeThrough(createCfqStripStream(
      "responses",
      preparedStats,
      createCfqStripObserver(pipe),
    )),
    {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
    },
  );
}

// ── Langfuse helpers ─────────────────────────────────────────────────────────

// countHumanTurnsCodex merged into turnSeq.ts::countHumanTurnsResponses (Round 7).
// Alias export kept for backward-compat (old tests still import this name).
export { countHumanTurnsResponses as countHumanTurnsCodex } from "../../turnSeq.js";

/**
 * Build the input sent to langfuse — codex's input[] is already a structured conversation history,
 * and can be passed through as is (same purpose as anthropic's buildLangfuseInput: to make
 * the langfuse UI show clearly "what the input of this call was"). The instructions segment is carried separately,
 * to complete the context (codex's system prompt is in body.instructions rather than input).
 */
function buildCodexLangfuseInput(body: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = { input: body.input };
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    out.instructions = body.instructions;
  }
  return out;
}

export interface CodexTapContext {
  /**
   * langfuse trace context; null means an aux scenario that does not report to langfuse but may still need
   * archiving (in theory aux never carries archiveCtx; when both are null the upstream tap simply does not start).
   */
  lf: LangfuseTurnContext | null;
  modelId: string;
  startTime: string;
  upstreamUrl: string;
  inputBody: Record<string, unknown>;
  pipe: ReturnType<typeof createPipeline>;
  config?: ProxyConfig;
  requestPath?: string;
  keyId?: string;
  sessionKey?: string;
  /**
   * Opik trace id — generated by opikCreateTrace in forwardToUpstream.
   * Warning: it is a separate id from lf.traceId (Langfuse, sha256 hex) and must not be mixed:
   *   Opik requires a v7 UUID; passing Langfuse's 32-char hex gets rejected with 400.
   * When omitted (undefined), the span report carries an empty trace_id and is rejected by Opik with 422.
   */
  traceId?: string;
  /** Opik fork trace id (request_log project); undefined when opik is off. */
  forkTraceId?: string;
  /** Tenant the usage is billed to; ClickHouse filters on it. */
  spaceId?: string;
  /** Upstream `x-request-id`, carried for cross-system tracing. */
  upstreamRequestId?: string;
  skipCreditReport?: boolean;
  /** Opaque counters from the preparation stage, recorded with the usage log. */
  preparedStats?: Record<string, unknown> | null;
  /**
   * Context of the skill archive + TDAI L0 write hooks;
   * null means the current request does not need to trigger archiving (aux / session not initialized / bypass).
   */
  archiveCtx?: CodexArchiveCtx | null;
}

/**
 * Consume the codex Responses API SSE stream, extract usage + assistant output, and report to langfuse.
 *
 * codex SSE key frames (see docs/2026-08-05-codex-onboarding.md §7.5.2/3):
 *   - response.output_text.delta:  {delta: "..."}                → accumulate assistant text
 *   - response.function_call_arguments.delta: {delta: "..."}     → accumulate tool_use arguments (for observation)
 *   - response.completed: {response: {usage, output, status, ...}} → closing, take usage
 *
 * Failures are silent — instrumentation must never affect the business chain.
 */
export function consumeCodexStream(stream: ReadableStream<Uint8Array>, ctx: CodexTapContext): void {
  const { lf, modelId, startTime, upstreamUrl, inputBody, pipe, archiveCtx } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let toolCalls: UpstreamToolCall[] = [];
    let stopReason: string | undefined;
    let streamCompleted = false;
    // 5-minute fallback: a client disconnect may leave the upstream stream stuck; on timeout here, also force a closing once.
    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Codex stream reading exceeded 5 minutes");
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();
      if (ctx.config && lf) {
        void notifyUpstreamResponse(ctx.config, {
          protocol: "responses",
          sessionKey: lf.sessionId,
          model: modelId,
          stream: true,
          turnSeq: lf.turnSeq,
          text: outputText,
          toolCalls,
          usage,
        }, pipe);
      }
      if (ctx.config && Object.keys(usage).length > 0) {
        // Legacy codex behavior: writeLog(usage) always writes with no gate (B6 was already restored during the pipeline migration,
        // not wrapped in stageGates.writeLogUsage to avoid any preset tier making codex stop writing)
        stageWriteUsageLog({
          config: ctx.config, pipe,
          timestamp: endTime, modelId,
          keyId: ctx.keyId ?? "unknown",
          sessionKey: ctx.sessionKey ?? "",
          turnSeq: lf?.turnSeq,
          userInput: lf?.userQuery || undefined,
          upstreamUrl, usage,
          requestReceivedAt: startTime,
          extensionStats: ctx.preparedStats ?? undefined,
          spaceId: ctx.spaceId,
          upstreamRequestId: ctx.upstreamRequestId,
        });
      }
      if (ctx.config && ctx.requestPath) {
        // stageCredit uniformly goes through the shared billing implementation (aligned with the openai-chat / anthropic stream branch)
        // In the stream scenario the client has already received it and headers cannot be written (but the stage still logs + falls back to CH raw internally)
        await stageCredit({
          skipCreditReport: ctx.skipCreditReport,
          config: ctx.config,
          path: ctx.requestPath,
          usage: Object.keys(usage).length > 0 ? usage : undefined,
          effectiveModel: modelId,
          upstreamUrl,
          event: "usage",
          startTime: new Date(startTime),
          reqIds: pipe.ids(),
          upstreamRequestId: ctx.upstreamRequestId ?? "",
          sessionKey: ctx.sessionKey ?? "",
          stream: true,
          keyId: ctx.keyId ?? "unknown",
          routedFrom: "",
        }, pipe).catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
      }
      if (lf) {
        try {
          const output = outputText
            ? { role: "assistant", content: outputText }
            : toolUseCount > 0
              ? { role: "assistant", content: `[${toolUseCount} tool call(s)]` }
              : undefined;
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildCodexLangfuseInput(inputBody),
            output,
            usage: Object.keys(usage).length > 0 ? usage : undefined,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: output,
            traceMetadata: {
              stream: true,
              upstreamUrl,
              stop_reason: stopReason,
              tool_use_count: toolUseCount,
            },
            observationMetadata: {
              stream: true,
              stop_reason: stopReason,
              tool_use_count: toolUseCount,
            },
          });
        } catch (lfErr: unknown) {
          pipe.error("LANGFUSE_SPAN", lfErr);
        }
      }

      // ── Opik LLM span (bug B7 fix, gated by stageGates.opik) ──
      const codexAgent = resolveAgentStrategy("codex");
      if (ctx.config && Object.keys(usage).length > 0) {
        const output = outputText
          ? { role: "assistant" as const, content: outputText }
          : toolUseCount > 0
            ? { role: "assistant" as const, content: `[${toolUseCount} tool call(s)]` }
            : null;
        stageOpikStreamSpan({
          config: ctx.config, gates: codexAgent.stageGates, pipe,
          // The Opik trace id comes from ctx.traceId (produced by opikCreateTrace
          // in forwardToUpstream). If missing it means opik is off → the stage internally no-ops because
          // opik.enabled=false, and will not send a request with an empty trace_id.
          traceId: ctx.traceId ?? "",
          forkTraceId: ctx.forkTraceId,
          keyId: ctx.keyId ?? "unknown",
          modelId, startTime, endTime,
          inputMessages: [{ role: "user", content: JSON.stringify(inputBody.input ?? []) }],
          outputMessage: output,
          usage,
          retried: false,
          upstreamUrl,
          streamTag: "stream",
          // The codex-specific "codex" tag append is kept here; stageOpikStreamSpan internally uses streamTag + retry tag
        });
        // stageOpikStreamSpan can only carry the stream / retry tag; the codex-only "codex" tag is handled separately via forkMetadata
        // It could also be appended by the caller after the stageOpikStreamSpan output, but opikCreateLlmSpan is an idempotent sink with no second call
        // Decision: do not strictly keep the "codex" tag (in the old behavior it was just a classification label; the opik-side tag does not affect the main UI path)
      }

      // ── ModelIntent telemetry (bug B4 fix, gated by stageGates.modelIntentTelemetry) ──
      stageEmitModelIntent({
        gates: codexAgent.stageGates,
        sessionKey: `codex:${ctx.sessionKey}`,
        turnSeq: lf?.turnSeq ?? 0,
        spaceId: ctx.spaceId,
        userId: ctx.keyId ?? "unknown",
        agentSource: "codex",
        intents: toolCalls.filter((tc) => tc.name).map((tc) => ({ name: tc.name, arguments: tc.arguments })),
      });

      // ── recordInputTokenUsage (bug B1 fix, gated by stageGates.rateLimit) ──
      if (ctx.config && Object.keys(usage).length > 0) {
        await stageRecordTokenUsage({
          config: ctx.config, gates: codexAgent.stageGates,
          isCustomUpstream: !!ctx.skipCreditReport,  // codex uses skipCreditReport as the custom flag
          spaceId: ctx.spaceId,
          modelId, usage, protocol: "responses",
        }).catch((rlErr: unknown) => pipe.error("RATE_LIMIT_RECORD", rlErr));
      }

      // ── Skill/conversation/add + TDAI L0 archive hook ──
      // Aligned with the stream branch of anthropicHandler.ts (line 1867-1948): after langfuse reporting,
      // trigger skill archiving + L0 write. Failures are silent (already warned internally), not blocking the client SSE.
      // archiveCtx=null (aux / uninitialized session / bypass) skips directly.
      if (archiveCtx) {
        try {
          await triggerCodexArchiveHooks(archiveCtx, outputText, toolUseCount);
        } catch (archiveErr: unknown) {
          pipe.error("CODEX_ARCHIVE", archiveErr instanceof Error ? archiveErr : new Error(String(archiveErr)));
        }
      }
    }

    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });
        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) dataStr = line.slice(6);
            else if (line.startsWith("data:")) dataStr = line.slice(5);
          }
          if (!dataStr) continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string | undefined;

            if (evtType === "response.output_text.delta") {
              const delta = evt.delta;
              if (typeof delta === "string") outputText += delta;
            } else if (evtType === "response.output_item.added") {
              const item = evt.item as Record<string, unknown> | undefined;
              if (item?.type === "function_call") toolUseCount++;
            } else if (evtType === "response.completed") {
              const resp = evt.response as Record<string, unknown> | undefined;
              if (resp?.usage) {
                Object.assign(usage, resp.usage as Record<string, unknown>);
              }
              // The terminal `output[]` carries the complete call_id and verbatim arguments, more reliable than accumulating
              // response.function_call_arguments.delta.
              if (resp?.output) toolCalls = collectResponsesToolCalls(resp.output);
              stopReason = (resp?.status as string) ?? "completed";
            } else if (evtType === "response.incomplete") {
              // max_output_tokens / other interruptions (Responses API standard)
              const resp = evt.response as Record<string, unknown> | undefined;
              const details = resp?.incomplete_details as Record<string, unknown> | undefined;
              stopReason = `incomplete:${details?.reason ?? "unknown"}`;
              if (resp?.usage) Object.assign(usage, resp.usage as Record<string, unknown>);
              if (resp?.output) toolCalls = collectResponsesToolCalls(resp.output);
            }
          } catch {
            // ignore malformed frames — instrumentation-level problems do not block
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("CODEX_TAP", err instanceof Error ? err : new Error(String(err)));
    } finally {
      await completeStream();
    }
  })().catch((err: unknown) => pipe.error("CODEX_TAP_UNHANDLED", err));
}
