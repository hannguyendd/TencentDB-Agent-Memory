/**
 * WorkBuddy endpoint handler — skeleton layer (helper functions + main handler stub).
 *
 * WorkBuddy uses the OpenAI Responses API (@openai/agents SDK); its wire protocol is
 * the same as Codex, and its system prompt XML structure is similar to CodeBuddy. But this file is **deliberately fully
 * decoupled from codexHandler / codebuddyHandler**, not importing any sibling handler,
 * so changing WorkBuddy only touches this file and injection/agents/workbuddy/, leaving other clients unaffected.
 *
 * This round (step one of layered delivery): **only expose unit-test-friendly pure functions**
 *   - classifyWorkbuddyRequest: identify main vs auxiliary requests
 *   - extractWorkbuddySessionId: extract the session id from header / body
 *   - detectWorkbuddyDefaultModeGate: identify the client's Default mode gate signal
 *   - injectWorkbuddyAssets: append the `<tdai_injections>` wrapper to body.input[0].content[]
 *
 * The full `handleWorkbuddyEndpoint(c, config)` main handler (including auth / session-init /
 * mem-command / forward+langfuse tap) is left to be added in the next round when the server routes are wired in —
 * that part needs to bring in lots of config/session dependencies, so it is isolated first to reduce the regression surface.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { apiKeyToKeyId, extractBearerToken, opikCreateTrace, uuidv7 } from "../../opik.js";
import { createPipeline, writeLog } from "../../logger.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";
import { writeFailedReportRaw } from "../../clickhouse.js";
import { joinUrl } from "../../guard-adapter.js";
import {
  stageInstanceUpstreamResponses,
  isInstanceUpstreamBlocked,
} from "../stages/instance-upstream-responses.js";
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
  mergeResponsesToolCalls,
} from "../../common/responses-payload.js";
import { verifyUserKey } from "../../auth.js";
import { stageAuth } from "../stages/auth.js";
import { stageParseBody } from "../stages/parse-body.js";
import { stageSessionResetPreHook } from "../stages/session-reset-pre-hook.js";
import { stageSessionResetConfirmation } from "../stages/session-reset-confirmation.js";
import { countHumanTurnsResponses } from "../../turnSeq.js";
import { stageCredit } from "../stages/credit.js";
import { resolveModelId } from "../../pricing.js";
import { stageIdentity } from "../stages/identity.js";
import { stageModelGate } from "../stages/model-gate.js";
import { resolveAgentStrategy } from "../strategies/agent/index.js";
import { enforceRateLimit, isRateLimitExceededError } from "../../rate-limit/guard.js";
import { workbuddyAdapter } from "../../agent-adapters/workbuddy.js";
import {
  buildWorkbuddyInjectionBlock,
  type WorkbuddyInjectionInput,
} from "../../common/workbuddy-injection.js";
// WorkBuddy uses the Responses API, fully consistent with the codex wire — the form-popup skeleton directly reuses
// buildFormResponse + codexFormAnswersAsMessages of session/codex/form.ts,
// and the state machine reuses CB's handleSessionInit (agentSource="codex"). This way WorkBuddy
// does not need its own separate form skeleton.
import {
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "../../session/codex/form.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";

// ── TDAI L0 + Skill extraction imports ────────────────────────────────────────
import { TdaiClient, buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { stageArchive } from "../stages/archive.js";
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
import { buildMemResponse } from "../../mem-command/response-builder.js";

// ── Handler-level constants ──────────────────────────────────────────────────

// SKIP header sets have been merged into common/constants.ts (workbuddy uses the WITH_INTERNAL version)
import { SKIP_REQUEST_HEADERS_WITH_INTERNAL as SKIP_REQUEST_HEADERS, filterResponseHeaders } from "../../common/constants.js";

// ── Types (exported for unit tests) ──────────────────────────────────────────

/**
 * WorkBuddy per-session state.
 * Semantically the same as CodexSessionState but a separate type, to avoid type sharing across handlers.
 *
 * - status: "initialized" means the binding/onboarding flow is complete; "pending" means still waiting for the
 *   session-init form to be filled in
 * - bypassed: after the user explicitly chooses "Default mode" to bypass the binding flow, form injection is skipped permanently
 * - sessionInfo: metadata { userId, teamId, agentId, ... } attached after a successful binding,
 *   passed through to the injection pipeline for context queries
 */
export interface WorkbuddySessionState {
  status: "initialized" | "pending";
  bypassed?: boolean;
  sessionInfo?: Record<string, unknown> | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Signature string of the WorkBuddy client's Default mode gate.
 * After the user chooses Default mode, the client outputs this prefix in function_call_output
 * hinting "request_user_input is unavailable in Default mode" — a hit is treated as
 * the user explicitly choosing to bypass the binding flow, and the session should be permanently bypassed.
 *
 * The WorkBuddy client's actual string is **pending capture verification**; this round uses codex's gate string
 * ("request_user_input is unavailable in Default mode") for now, to be aligned
 * during real-client joint debugging.
 * TODO(workbuddy-integration): capture to confirm the actual gate string of the WorkBuddy client.
 */
const DEFAULT_GATE_PREFIX = "request_user_input is unavailable in Default mode";

// ── Request classification ───────────────────────────────────────────────────

/**
 * Classify a WorkBuddy request as main or auxiliary.
 *
 * Auxiliary requests are auxiliary calls spontaneously made by the client (memory generation, trace summarization, compact
 * etc.), which should not trigger the session-init form or injection and are forwarded straight to upstream.
 *
 * Decision order (any hit returns auxiliary):
 *   1. an aux path fragment appears in the path (/compact, /trace_summarize, /realtime, /memories)
 *   2. a memgen marker appears in the header (x-openai-memgen-request=true, compatible with SDK convention)
 *   3. body.client_metadata.thread_source ∈ {system, memory_consolidation}
 *
 * An unknown thread_source is treated as main (leaning strict — better to miss an aux than to mistake user interaction for aux).
 */
export function classifyWorkbuddyRequest(
  body: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): "main" | "auxiliary" {
  // ① path-based aux decision
  const AUX_PATH_HINTS = ["/compact", "/trace_summarize", "/realtime", "/memories"];
  for (const hint of AUX_PATH_HINTS) {
    if (path.includes(hint)) return "auxiliary";
  }

  // ② header memgen marker
  const memgen =
    headers["x-openai-memgen-request"] ??
    headers["X-OpenAI-Memgen-Request"] ??
    "";
  if (memgen === "true" || memgen === "1") return "auxiliary";

  // ③ body.client_metadata.thread_source
  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const ts = meta.thread_source;
    if (ts === "system" || ts === "memory_consolidation") return "auxiliary";
  }

  return "main";
}

// ── Session ID extraction ────────────────────────────────────────────────────

/**
 * Extract the WorkBuddy session id from the request headers/body.
 *
 * Priority (same as codex):
 *   1. header `session-id` (the SDK default location)
 *   2. body.client_metadata.session_id (fallback)
 *
 * If both are missing → null (the upper layer decides whether to reject or generate a new session).
 */
export function extractWorkbuddySessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  // subagent normalization: requests carrying x-parent-conversation-id (parallel subagents) always use the
  // parent id as the session identity, reusing the main session state, to avoid re-popping the session-init form
  // (fixed 2026-09-20: WorkBuddy infinite loop after compaction; see the comments in session/session-key.ts for details).
  const parentId = headers["x-parent-conversation-id"] ?? headers["X-Parent-Conversation-Id"];
  if (typeof parentId === "string" && parentId.length > 0) return parentId;

  const fromHeader = headers["session-id"] ?? headers["Session-Id"] ?? headers["x-conversation-id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;

  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const sid = meta.session_id;
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return null;
}

// ── Default mode gate detection ──────────────────────────────────────────────

/**
 * Identify the Default mode gate signal of the WorkBuddy client.
 *
 * When the user rejects the request_user_input form (chooses Default mode), the client carries
 * function_call_output.output ~= 
 * "request_user_input is unavailable in Default mode" in the input[] of the next request. A hit means the user
 * explicitly wants to bypass the binding flow → the session should be marked bypassed.
 *
 * Same structure as the codex version, with the string prefix defined independently (DEFAULT_GATE_PREFIX); when the client later
 * changes the wording, only this one constant needs to change.
 */
export function detectWorkbuddyDefaultModeGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const output = it.output;
    if (typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX)) {
      return true;
    }
  }
  return false;
}

// ── Asset injection ──────────────────────────────────────────────────────────

/**
 * Inject `<tdai_injections>` wrapper into WorkBuddy body.input[0].content[].
 *
 * Isomorphic with the codex logic: attach the complete XML text produced by the pipeline to the end of the content array
 * of the developer message (input[0]).
 *
 * Defensive short-circuits:
 *   - no input or input is not an array → return the original body
 *   - input[0] is not a message → return the original body
 *   - input[0].content is not an array → return the original body
 *   (The point of these defensive branches: on non-first frames of the client, input[0] may be a function_call or similar,
 *    and only in the first round is input[0] a developer/user message; wrongly injecting into the content of a function_call item
 *    would cause an upstream 400 or semantic confusion.)
 *
 * Returns a shallow copy without modifying the original body (shallow copy along the whole chain body → input → input[0] → content).
 */
export function injectWorkbuddyAssets(
  body: Record<string, unknown>,
  assets: WorkbuddyInjectionInput,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  const devMsg = input[0] as Record<string, unknown> | null;
  if (!devMsg || typeof devMsg !== "object") return body;
  if (devMsg.type !== "message") return body;

  const content = devMsg.content;
  if (!Array.isArray(content)) return body;

  const injectionBlock = buildWorkbuddyInjectionBlock(assets);

  // Shallow-copy chain: body → input → input[0] → content
  const newContent = [...content, injectionBlock];
  const newDevMsg = { ...devMsg, content: newContent };
  const newInput = [newDevMsg, ...input.slice(1)];
  return { ...body, input: newInput };
}

// ── Human turn counting (langfuse instrumentation helper) ──────────────────────────────────

/**
 * Count the number of "human turns" in WorkBuddy input[].
 *
 * Used for the turnSeq of the langfuse trace — only user messages actively sent by the client (role=user
 * and type=message) are counted; function_call / function_call_output / assistant feedback produced by tool calls
 * are not counted. This way multiple function_calls within the same round are merged into the same
 * trace, which is easier to observe.
 *
 * Same logic as codex's countHumanTurnsCodex, copied independently to keep "zero dependencies between
 * handlers".
 */
// countHumanTurnsWorkbuddy merged into turnSeq.ts::countHumanTurnsResponses (Round 7).
// Alias export kept for backward-compat.
export { countHumanTurnsResponses as countHumanTurnsWorkbuddy } from "../../turnSeq.js";

// ── Workbuddy Archive Context (L0 write + Skill extract) ────────────────────

/**
 * WorkBuddy L0/Skill archive context, aligned with codexHandler's CodexArchiveCtx design:
 *   - when archiveCtx=null the forward/session bypass side skips the hooks directly
 *   - failures are silent (internal warn), never blocking the upstream response
 */
export interface WorkbuddyArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  userId: string;
  /** The original body.input[] (responses API input items) */
  input: unknown[];
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  /**
   * Asset capability switches (chat_memory / skill / ...); used to gate the archive hook.
   * Aligned with codexHandler.CodexArchiveCtx.assetCapabilities.
   */
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
}

/**
 * Extract the latest user message from the responses API body.input[] for the L0 write.
 */
function extractLatestWorkbuddyUserMessage(input: unknown): TdaiMessage | null {
  if (!Array.isArray(input)) return null;
  const text = workbuddyAdapter.extractUserText(input);
  if (!text) return null;
  return { role: "user", content: text };
}

// The old createWorkbuddyTdaiClient implementation omitted spaceId (bug: writing to the wrong tenant in multi-tenant setups),
// migrating to the shared buildTdaiClientForRequest fixes it automatically — the old wb call site will add a spaceId parameter.
const createWorkbuddyTdaiClient = (config: ProxyConfig, spaceId?: string) =>
  buildTdaiClientForRequest(config, spaceId);

function buildWorkbuddyArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  userId: string;
  callerUserKey?: string | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
}): WorkbuddyArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  // When chat_memory=false the user explicitly turned off memory → do not create a tdaiClient; skill archiving still goes ahead.
  // Aligned with codexHandler.buildArchiveCtx (line 855-857).
  const tdaiClient = args.assetCapabilities?.chat_memory === false
    ? null
    : createWorkbuddyTdaiClient(args.config);
  const tdaiIdentity = deriveTdaiIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey ?? null,
  });
  const tdaiUserMessage = extractLatestWorkbuddyUserMessage(args.input);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: "workbuddy",
    sessionInfo,
    userId: args.userId,
    input: args.input,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
    assetCapabilities: args.assetCapabilities,
  };
}

/**
 * After the stream ends, trigger the TDAI L0 write + skill extraction, aligned with codexHandler's
 * triggerCodexArchiveHooks logic. Failures are silent (already warned internally), not blocking downstream.
 *
 * Goes through the shared stages/archive.ts::stageArchive (tdaiWriteMode="fire-and-forget-tracked"),
 * 100% symmetric with the codex archive hook, only the agentSource / logPrefix parameters differ.
 */
async function triggerWorkbuddyArchiveHooks(
  ctx: WorkbuddyArchiveCtx,
  assistantText: string,
  toolCallCountOverride?: number,
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
    agentSource: "workbuddy",
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
    toolCallCountOverride,
    logPrefix: "[workbuddy-tdai-l0]",
  });
}

// ── Upstream helpers ─────────────────────────────────────────────────────────

/**
 * Structure the workbuddy request body into the `input` field of a langfuse observation.
 *
 * workbuddy uses the Responses API; the request body shape:
 *   - body.input:        Array<InputItem> (always present, user messages / tool outputs, etc.)
 *   - body.instructions: string           (optional, system-level instructions)
 *
 * Combination strategy (minimize nesting levels in the langfuse UI):
 *   - has instructions → return { input, instructions }
 *   - input only       → return body.input directly
 *   - both missing     → return undefined (the langfuse side does not write the input field)
 */
function buildWorkbuddyLangfuseInput(body: Record<string, unknown>): unknown {
  const hasInput = Array.isArray(body.input);
  const hasInstructions =
    typeof body.instructions === "string" && (body.instructions as string).length > 0;
  if (!hasInput && !hasInstructions) return undefined;
  if (hasInput && hasInstructions) {
    return { input: body.input, instructions: body.instructions };
  }
  return hasInput ? body.input : { instructions: body.instructions };
}

function buildUpstreamHeaders(c: Context, config: ProxyConfig): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) h[k] = v;
  }
  if (config.upstream.apiKey) {
    h["authorization"] = `Bearer ${config.upstream.apiKey}`;
    delete h["x-api-key"];
  }
  return h;
}

// filterResponseHeaders merged into common/constants.ts

/**
 * Forward the request to upstream. On SSE responses with `lf != null`, tees
 * the stream and reports usage/text to langfuse (best-effort).
 */
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
  archiveCtx: WorkbuddyArchiveCtx | null = null,
): Promise<Response> {
  // ── Per-agent upstream override ──
  // Aligned with codexHandler: supports config.upstream.agents?.workbuddy pointing separately at URL/apiKey,
  // falling back to the global config.upstream.{url,apiKey} when not configured.
  const perAgent = (config.upstream as unknown as {
    agents?: { workbuddy?: { url?: string; apiKey?: string } };
  }).agents?.workbuddy;
  const upstreamBase = ((perAgent?.url ?? config.upstream.url ?? "") as string).replace(/\/$/, "");
  const upstreamPath = c.req.path.replace(/^\/workbuddy\/[^/]+/, "");
  let upstreamUrl = joinUrl(upstreamBase, upstreamPath);
  let skipCreditReport = false;

  const headers = buildUpstreamHeaders(c, config);
  // If a per-agent apiKey is specified separately, it overrides the globally injected authorization
  if (perAgent?.apiKey) {
    headers["authorization"] = `Bearer ${perAgent.apiKey}`;
    delete headers["x-api-key"];
  }

  // ── Instance upstream config override ──
  // v2 model groups (§7.3): go through the shared stageInstanceUpstreamResponses (shared with codex).
  // pathForOverride uses the upstreamPath with the /workbuddy/<sid> prefix stripped, equivalent to the old implementation.
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const _upstreamResolve = await stageInstanceUpstreamResponses({
    agent: "workbuddy",
    spaceId,
    config,
    pathForOverride: upstreamPath,
  });
  if (isInstanceUpstreamBlocked(_upstreamResolve)) {
    return c.json(_upstreamResolve.errorBody, 400);
  }
  if (_upstreamResolve.overrideUrl) {
    upstreamUrl = _upstreamResolve.overrideUrl;
    if (_upstreamResolve.headerUpdates?.authorization) {
      headers["authorization"] = _upstreamResolve.headerUpdates.authorization;
    }
    if (_upstreamResolve.headerUpdates?.deleteXApiKey) {
      delete headers["x-api-key"];
    }
    if (_upstreamResolve.bodyModelOverride && typeof body.model === "string") {
      body.model = _upstreamResolve.bodyModelOverride;
    }
  }
  if (_upstreamResolve.skipCreditReport) skipCreditReport = true;

  // Optional private preparation stage. It rewrites `body` and the `input[]`
  // items in place, so it has to land after every host-side mutation (model
  // resolution, instance override) and before `bodyStr` freezes them below.
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
        headers,
        model: modelId,
        tools: body.tools,
      },
      userQuery: lf.userQuery,
      lf,
      opikTraceId: traceId,
      opikKeyId: keyId,
    });
  }

  const bodyStr = JSON.stringify(body);

  // Structured instrumentation: aligned with codex (forwardStart / forwardDone / info three-part form)
  pipe.forwardStart(upstreamUrl);

  // ── Opik: create trace (bug B7 fix lost during migration, restored this time) ──────────────────
  // Aligned with codex.ts / anthropic.ts. Warning: an **independent v7 UUID** must be used as the Opik
  // trace id — lf.traceId cannot be reused (that is Langfuse's sha256 hex, and Opik would
  // reject it with a 400 "must be a version 7 UUID").
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

  // usage.log records the request (for ops / billing statistics), aligned with the codex writeLog usage
  try {
    writeLog(config, {
      timestamp: startTime,
      event: "request",
      modelId,
      keyId,
      sessionKey: keyId,
      upstreamUrl,
      stream: true,
    });
  } catch {
    /* logger best-effort */
  }

  // Bug B1 fix: the old wb did not wire enforceRateLimit at all; now gated by stageGates.rateLimit
  const wbAgentForForward = resolveAgentStrategy("workbuddy");
  if (wbAgentForForward.stageGates.rateLimit && !skipCreditReport) {
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

  // Bug B9 fix: the old wb had no AbortSignal.timeout; when upstream hangs, fetch hangs forever
  const wbForwardTimeoutMs = config.server?.forwardTimeoutMs ?? 600_000;

  let upstreamResp: Response;
  try {
    const fetchOpts: RequestInit = {
      method: "POST",
      headers,
      body: bodyStr,
    };
    if (wbForwardTimeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(wbForwardTimeoutMs);
    }
    upstreamResp = await fetch(upstreamUrl, fetchOpts);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.info("WORKBUDDY_FORWARD_ERR", `Timeout after ${wbForwardTimeoutMs / 1000}s`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    pipe.info("WORKBUDDY_FORWARD_ERR", msg);
    // Network-layer failure → report langfuse failure, so online visualization can see it
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildWorkbuddyLangfuseInput(body),
          statusMessage: `fetch_failed: ${msg}`.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: {
            stage: "forward",
            stream: true,
            upstreamUrl,
            keyId,
          },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return c.json({ error: `Upstream fetch failed: ${msg}` }, 502);
  }

  const respHeaders = filterResponseHeaders(upstreamResp.headers);
  // Upstream request id — for cross-system tracing: the x-request-id the client gets → our usage_logs → upstream logs.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isSSE = contentType.includes("text/event-stream");

  pipe.forwardDone(upstreamResp.status, upstreamResp.headers.get("x-request-id") ?? undefined);

  // Upstream 4xx/5xx → report langfuse failure (the body has already been consumed by upstream; do not re-read, to avoid breaking the stream)
  if (lf && upstreamResp.status >= 400) {
    try {
      langfuseReportFailure({
        lf,
        model: modelId,
        startTime,
        endTime: new Date().toISOString(),
        input: buildWorkbuddyLangfuseInput(body),
        status: upstreamResp.status,
        statusMessage: `upstream_${upstreamResp.status}`,
        extraTags: ["error"],
        observationMetadata: {
          stage: "upstream",
          stream: true,
          upstreamUrl,
          keyId,
          content_type: contentType,
        },
      });
    } catch (lfErr: unknown) {
      pipe.error("LANGFUSE_SPAN", lfErr);
    }
  }

  if (!isSSE) {
    const responseText = await upstreamResp.text();
    let usage: Record<string, unknown> | undefined;
    const toolCalls = new Map<string, UpstreamToolCall>();
    let outputText = "";
    try {
      const responseBody = JSON.parse(responseText) as Record<string, unknown>;
      if (responseBody.usage && typeof responseBody.usage === "object") {
        usage = responseBody.usage as Record<string, unknown>;
      }
      mergeResponsesToolCalls(toolCalls, responseBody.output);
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
        toolCalls: [...toolCalls.values()],
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
        config, gates: wbAgentForForward.stageGates,
        isCustomUpstream: skipCreditReport,
        spaceId,
        modelId, usage, protocol: "responses",
      }).catch((rlErr: unknown) => pipe.error("RATE_LIMIT_RECORD", rlErr));
      const creditResult = await stageCredit({
        skipCreditReport, config, path: c.req.path, usage, effectiveModel: modelId,
        upstreamUrl, event: "usage", startTime: new Date(startTime),
        reqIds: pipe.ids(), upstreamRequestId,
        sessionKey: lf?.sessionId ?? keyId, stream: false,
        keyId, routedFrom: "",
      }, pipe);
      if (creditResult.responseErrorHeader) {
        respHeaders.set("x-credit-report-error", creditResult.responseErrorHeader);
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
      headers: respHeaders,
    });
  }

  // Main turns are tapped for observability/archive; auxiliary Responses calls
  // are tapped for credit only.
  if (!upstreamResp.body || (!lf && skipCreditReport)) {
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
        headers: respHeaders,
      },
    );
  }

  // SSE + langfuse: tee & tap
  const [passStream, tapStream] = upstreamResp.body.tee();
  void consumeWorkbuddyStream(tapStream, {
    startTime,
    modelId,
    keyId,
    traceId,
    forkTraceId,
    lf,
    config,
    requestPath: c.req.path,
    spaceId,
    upstreamRequestId,
    skipCreditReport,
    preparedStats,
    pipe,
    archiveCtx,
    inputBody: body,
    upstreamUrl,
  });

  // CFQ stripping comes last: the tap goes through another tee branch and still reads the model's raw output.
  return new Response(
    passStream.pipeThrough(createCfqStripStream(
      "responses",
      preparedStats,
      createCfqStripObserver(pipe),
    )),
    {
      status: upstreamResp.status,
      headers: respHeaders,
    },
  );
}

/**
 * WorkBuddy tap context — the parameter type of consumeWorkbuddyStream.
 */
interface WorkbuddyTapContext {
  startTime: string;
  modelId: string;
  keyId: string;
  traceId: string;
  /** Opik fork trace id (request_log project); undefined when opik is off. */
  forkTraceId?: string;
  lf: LangfuseTurnContext | null;
  config: ProxyConfig;
  requestPath: string;
  /**
   * Session composite key (`${agentSource}:${sessionId}`), used for the modelIntent
   * telemetry and the sessionKey field of skill extract. When the runner constructs the tap ctx it
   * passes `${lf.sessionId}` (the old code always wrote it this way).
   */
  sessionKey?: string;
  /** Tenant the usage is billed to; ClickHouse filters on it. */
  spaceId: string;
  /** Upstream `x-request-id`, carried for cross-system tracing. */
  upstreamRequestId: string;
  skipCreditReport: boolean;
  /** Opaque counters from the preparation stage, recorded with the usage log. */
  preparedStats: Record<string, unknown> | null;
  pipe: ReturnType<typeof createPipeline>;
  archiveCtx: WorkbuddyArchiveCtx | null;
  /**
   * The final body forwarded to upstream (including the injected input[]). Used in two places:
   *   1) langfuse observation.input (buildWorkbuddyLangfuseInput)
   *   2) fallback — currently unused, but aligned with codex for easier future extension
   */
  inputBody: Record<string, unknown>;
  /** Upstream URL, written into observationMetadata to ease troubleshooting */
  upstreamUrl: string;
}

/**
 * Consume an SSE stream from upstream, extract text + usage, report to
 * langfuse, then trigger L0 write + skill extraction hooks.
 * Runs asynchronously without blocking the downstream response.
 *
 * Key mechanisms (aligned with codex but keeping workbuddy's existing try/finally style):
 *   - 5-minute fallback setTimeout: force a closing once when the client disconnects or upstream stalls without releasing
 *   - toolUseCount accumulation: in the Responses API `response.output_item.done` +
 *     `item.type==="function_call"` counts as one tool call; passed through to skill archiving as the
 *     round boundary criterion
 *   - buildWorkbuddyLangfuseInput(inputBody): structures body.input + instructions
 *     into the langfuse observation.input, easing troubleshooting
 */
async function consumeWorkbuddyStream(
  stream: ReadableStream<Uint8Array>,
  ctx: WorkbuddyTapContext,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let assistantText = "";
  let usage: Record<string, unknown> | undefined;
  let responseId: string | undefined;
  // Q: accumulate the number of function_calls within the current turn (round boundary criterion)
  let toolUseCount = 0;
  // Accumulate tool calls by call_id, for the CFQ side channel of incremental sessions. output_item.done
  // and completed give the same one twice; dedupe via Map and take the terminal state as authoritative.
  const toolCalls = new Map<string, UpstreamToolCall>();

  // P: 5-minute timeout fallback. An upstream or client disconnect may leave reader.read() hanging forever;
  // use setTimeout to force a cancel, to avoid leaking the tap coroutine. Use a flag rather than
  // throwing directly, because the cancel of fetch's ReadableStream makes the main loop exit naturally.
  let streamCompleted = false;
  const timeoutHandle = setTimeout(() => {
    if (!streamCompleted) {
      ctx.pipe.error(
        "STREAM_TIMEOUT",
        new Error("Workbuddy stream reading exceeded 5 minutes"),
      );
      // Actively cancel the reader; the read loop will therefore receive done=true or exit with an error
      void reader.cancel().catch(() => {
        /* best-effort */
      });
    }
  }, 5 * 60 * 1000);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6));
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as Record<string, unknown>;
          const evtType = evt.type as string | undefined;
          if (evtType === "response.output_text.delta") {
            const delta = evt.delta;
            if (typeof delta === "string") assistantText += delta;
          }
          // Q: tool call counting (aligned with codex's criterion) — +1 only on output_item.done
          // with item.type==="function_call"; do not put it in response.completed,
          // to avoid over- or under-counting.
          if (evtType === "response.output_item.done") {
            const item = evt.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") toolUseCount++;
            if (item) mergeResponsesToolCalls(toolCalls, [item]);
            // The semantics of resp in response.output_item.done are consistent with codex:
            // some upstreams spit out usage/response.id together here (multiple
            // done within a stream); the completed branch below is the authoritative source of usage.
            const resp = (evt.response ?? evt) as Record<string, unknown>;
            if (typeof resp?.id === "string") responseId = resp.id as string;
            if (resp?.usage && typeof resp.usage === "object") {
              usage = resp.usage as Record<string, unknown>;
            }
          }
          if (evtType === "response.completed") {
            const resp = (evt.response ?? evt) as Record<string, unknown>;
            if (typeof resp?.id === "string") responseId = resp.id as string;
            if (resp?.usage && typeof resp.usage === "object") {
              usage = resp.usage as Record<string, unknown>;
            }
            mergeResponsesToolCalls(toolCalls, resp?.output);
          }
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  } catch (err) {
    ctx.pipe.info("WORKBUDDY_STREAM_ERR", err instanceof Error ? err.message : String(err));
  } finally {
    streamCompleted = true;
    clearTimeout(timeoutHandle);
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  const endTime = new Date().toISOString();
  if (ctx.lf) {
    void notifyUpstreamResponse(ctx.config, {
      protocol: "responses",
      sessionKey: ctx.lf.sessionId,
      model: ctx.modelId,
      stream: true,
      turnSeq: ctx.lf.turnSeq,
      text: assistantText,
      toolCalls: [...toolCalls.values()],
      usage: usage ?? {},
    }, ctx.pipe);
  }
  if (usage && Object.keys(usage).length > 0) {
    // Legacy wb behavior: writeLog(usage) always writes with no gate (aligned with codex, to avoid any preset tier making wb stop writing)
    stageWriteUsageLog({
      config: ctx.config, pipe: ctx.pipe,
      timestamp: endTime, modelId: ctx.modelId,
      keyId: ctx.keyId,
      sessionKey: ctx.lf?.sessionId ?? ctx.keyId,
      turnSeq: ctx.lf?.turnSeq,
      userInput: ctx.lf?.userQuery || undefined,
      upstreamUrl: ctx.upstreamUrl, usage,
      requestReceivedAt: ctx.startTime,
      extensionStats: ctx.preparedStats ?? undefined,
      spaceId: ctx.spaceId,
      upstreamRequestId: ctx.upstreamRequestId,
    });
  }
  try {
    await stageCredit({
      skipCreditReport: ctx.skipCreditReport,
      config: ctx.config,
      path: ctx.requestPath,
      usage,
      effectiveModel: ctx.modelId,
      upstreamUrl: ctx.upstreamUrl,
      event: "usage",
      startTime: new Date(ctx.startTime),
      reqIds: ctx.pipe.ids(),
      upstreamRequestId: ctx.upstreamRequestId,
      sessionKey: ctx.keyId,
      stream: true,
      keyId: ctx.keyId,
      routedFrom: "",
    }, ctx.pipe);
  } catch (err: unknown) {
    ctx.pipe.error("CREDIT_REPORT", err instanceof Error ? err : new Error(String(err)));
  }
  if (ctx.lf) {
    try {
      // R: report with the structured input (body.input + instructions), easing langfuse UI troubleshooting
    langfuseReportGeneration({
      traceId: ctx.lf.traceId,
      name: `workbuddy:${ctx.modelId}`,
      model: ctx.modelId,
      startTime: ctx.startTime,
      endTime,
      input: buildWorkbuddyLangfuseInput(ctx.inputBody),
      output: assistantText,
      usage: usage && Object.keys(usage).length > 0 ? usage : undefined,
      traceName: ctx.lf.traceName,
      userId: ctx.lf.userId,
      sessionId: ctx.lf.sessionId,
      tags: ctx.lf.tags,
      traceInput: ctx.lf.userQuery || undefined,
      traceOutput: assistantText,
      observationMetadata: {
        stream: true,
        response_id: responseId,
        keyId: ctx.keyId,
        upstreamUrl: ctx.upstreamUrl,
        tool_use_count: toolUseCount,
      },
    });
    } catch (err) {
      ctx.pipe.info(
        "WORKBUDDY_LANGFUSE_ERR",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Opik LLM span (bug B7, gated by stageGates.opik) ──
  const wbAgentStrategy = resolveAgentStrategy("workbuddy");
  if (ctx.config && usage && Object.keys(usage).length > 0) {
    stageOpikStreamSpan({
      config: ctx.config, gates: wbAgentStrategy.stageGates, pipe: ctx.pipe,
      // Warning: must use Opik's own trace id (ctx.traceId, a v7 UUID).
      // This used to wrongly use ctx.lf.traceId — that is Langfuse's sha256 hex,
      // and Opik rejected the whole span with a 400 "must be a version 7 UUID".
      traceId: ctx.traceId,
      forkTraceId: ctx.forkTraceId,
      keyId: ctx.keyId, modelId: ctx.modelId,
      startTime: ctx.startTime, endTime,
      inputMessages: [{ role: "user", content: JSON.stringify(ctx.inputBody?.input ?? []) }],
      outputMessage: assistantText ? { role: "assistant", content: assistantText } : null,
      usage, retried: false, upstreamUrl: ctx.upstreamUrl,
      streamTag: "stream",
    });
  }

  // ── ModelIntent telemetry (bug B4, gated by stageGates.modelIntentTelemetry) ──
  // wb-only: doesn't accumulate toolCalls, emit synthetic counter only
  if (toolUseCount > 0) {
    stageEmitModelIntent({
      gates: wbAgentStrategy.stageGates,
      sessionKey: `workbuddy:${ctx.sessionKey}`,
      turnSeq: ctx.lf?.turnSeq ?? 0,
      spaceId: ctx.spaceId,
      userId: ctx.keyId,
      agentSource: "workbuddy",
      intents: [{ name: "wb_tool_use", arguments: `count=${toolUseCount}` }],
    });
  }

  // ── recordInputTokenUsage (bug B1 stream side, gated by stageGates.rateLimit) ──
  if (ctx.config && usage && Object.keys(usage).length > 0) {
    await stageRecordTokenUsage({
      config: ctx.config, gates: wbAgentStrategy.stageGates,
      isCustomUpstream: !!ctx.skipCreditReport,
      spaceId: ctx.spaceId,
      modelId: ctx.modelId, usage, protocol: "responses",
    }).catch((rlErr: unknown) => ctx.pipe.error("RATE_LIMIT_RECORD", rlErr));
  }

  // ── TDAI L0 write + Skill extraction ──
  // Aligned with codexHandler triggerCodexArchiveHooks: trigger archiving after langfuse reporting.
  // archiveCtx=null (aux/uninitialized session/bypass) skips directly.
  // Q: toolUseCount is passed through to skill archiving as the round boundary criterion.
  if (ctx.archiveCtx && assistantText) {
    await triggerWorkbuddyArchiveHooks(ctx.archiveCtx, assistantText, toolUseCount).catch(
      (err: unknown) => {
        ctx.pipe.info(
          "WORKBUDDY_ARCHIVE_ERR",
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * WorkBuddy endpoint handler.
 *
 * 10-stage flow (aligned with the codex/anthropic/openai handlers, easing side-by-side reading):
 *   1. Auth        - verify Bearer token / x-api-key
 *   2. Body        - parse the JSON body
 *   3. Headers     - extract the lowercased request header map
 *   4. Classify    - main vs auxiliary
 *   5. Aux         - short-circuit passthrough (no injection, no langfuse reporting)
 *   6. Session ID  - extract the session id from header/body, construct the langfuse turn ctx
 *   7. Session init- reuse the CB state machine (handleSessionInit, agentSource="codex")
 *                   + codex form builder renders the Responses API SSE popup
 *   8. Mem command - / command interception (when the session is registered)
 *   9. Injection   - the generic injection pipeline, injected into body.input[0].content[]
 *   10. Forward    - forward upstream + tap SSE to report langfuse
 */
export async function runWorkbuddyPipeline(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth (via shared stageAuth) ───────────────────────────────────
  const auth = await stageAuth(c, "bearer-first");
  const apiKey = auth.apiKey;
  const spaceId = auth.spaceId;
  const userId = auth.userId;
  if (auth.rejected) {
    return c.json({ error: `Authentication failed: ${auth.rejectReason ?? "unknown"}` }, 401);
  }
  const keyId = auth.keyId;

  // ── 2. Read body (via shared stageParseBody) ─────────────────────────
  const parseResult = await stageParseBody(c);
  if (!parseResult.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // Warning: `let` must not be changed back to `const`: the § 9 injection stage below (around line 1616)
  // will replace in place with `body = injectWorkbuddyAssets(body, ...)`, the new injected object.
  // c6fa775d (stageParseBody migration) accidentally changed it to const, causing runtime to
  // throw "Assignment to constant variable", and after the catch it degraded to **passthrough without injection** —
  // workbuddy's skill/memory/session_context were all lost from then on. TS 2588 kept reporting a warning
  // but it was treated as a "refactor-leftover baseline error" and nobody fixed it.
  let body = parseResult.body;

  // ── 3. Extract headers ───────────────────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  // ── Identity instrumentation (bug B5 fix, gated by stageGates.identityRecord) ──
  const wbAgent = resolveAgentStrategy("workbuddy");
  if (wbAgent.stageGates.identityRecord) {
    stageIdentity(c, body, "workbuddy");
  }

  // ── 4. Classify request ──────────────────────────────────────────────────
  // When workbuddyRequestRouting.enabled is off, force it to main, taking the old path fully equivalent to the unrouted aux split.
  // A rollback safety for ops; enabled by default. Aligned with CC's ccRequestRouting.enabled
  // semantics, but with the opposite default (CC defaults to false for a gradual rollout; WB defaults to true as a conservative rollback).
  const wbRoutingEnabled = config.workbuddyRequestRouting?.enabled !== false;
  const requestKind = wbRoutingEnabled
    ? classifyWorkbuddyRequest(body, path, headers)
    : "main";
  const isAuxiliary = requestKind === "auxiliary";

  const requestedModel = typeof body.model === "string" ? body.model : "";

  // ── Model gate (bug B8 fix, gated by stageGates.modelGate) ──
  const _wbSpaceIdForGate = extractSpaceIdFromPath(path) ?? "";
  let _wbIsCustomUpstream = false;
  if (wbAgent.stageGates.modelGate && !isAuxiliary) {
    try {
      const { getInstanceUpstreamConfigs, resolveForAgent, shouldOverride } =
        await import("../../instance-upstream-cache.js");
      const cfgs = await getInstanceUpstreamConfigs(config.coreSkill, _wbSpaceIdForGate, config.instanceUpstream);
      _wbIsCustomUpstream = shouldOverride(resolveForAgent(cfgs, "workbuddy"));
    } catch {
      _wbIsCustomUpstream = false;
    }
    if (!_wbIsCustomUpstream) {
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

  // ── 5. Aux passthrough ───────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("WORKBUDDY_AUX", `auxiliary request → passthrough (path=${path})`);
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, null, null);
  }

  // ── 6. Session ID + langfuse turn ctx ────────────────────────────────────
  const sessionId = extractWorkbuddySessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "workbuddy";
  const isStream = body.stream !== false;
  const callerUserKey = apiKey || null;

  const turnSeq = countHumanTurnsResponses(body.input);
  const userQuery = workbuddyAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: [
      `agent_source:${agentSource}`,
      "protocol:responses",
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
    ],
    routeTags: [],
    userQuery,
  };

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ───
  //
  // WorkBuddy and codex share the same Responses API wire, and the form-popup skeleton directly reuses codex/form.ts's
  // buildFormResponse + the CB state machine (handleSessionInit + agentSource="codex").
  // The agentSource passed here is "codex" rather than "workbuddy" — because the state machine decides internally by source:
  //   - whether to take the two-step paging (codex-only)
  //   - Default gate string recognition
  //   - whether formData.{teamPage,agentPage,taskPage} is populated
  // All three are codex-client-specific behaviors, and WorkBuddy likewise. The agent_source on the langfuse tag/log side
  // remains "workbuddy" and is unaffected.
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("../../injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamIdShort: string; taskName?: string | null; bypassed?: boolean } | null = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook (via shared stage) ──
  // wb uses `codex:${sessionKey}` as the compositeKey (the workbuddy agent reuses the codex adapter/state)
  {
    const { workbuddyAdapter } = await import("../../agent-adapters/workbuddy.js");
    const userText = workbuddyAdapter.extractUserText(input) ?? "";
    const _resetResp = await stageSessionResetPreHook({
      c, config, body: body as Record<string, unknown>, agentSource, sessionKey, spaceId, userId,
      isAuxiliary: false, dshHeadless: false, isStream,
      protocol: "responses", userText, enabled: true,
      compositeKeyOverride: `codex:${sessionKey}`,
    });
    if (_resetResp) return _resetResp;
  }

  if (config.sessionInit?.enabled && sessionId) {
    try {
      // Round 18: the session-init main orchestration goes through the shared stageSessionInitOrchestrate;
      // the 4 callbacks of workbuddy:
      //   - synthesizeMessages: codexFormAnswersAsMessages(input) (symmetric with codex)
      //   - buildRecoverInitResult: systemAppend + messages:[] (responses API)
      //   - buildInterceptResponse: buildCodexFormResponse (borrowing the codex form builder)
      //   - buildDefaultGateResponse: wb-only Plan hint (including the wording branch for the reset scenario)
      // wb-only: compositeKeyOverride="codex:..." (borrowing the codex L2b binding),
      //          agentSourceForState="codex" (reusing the CB branch)
      const _orch = await stageSessionInitOrchestrate({
        agentSourceForState: "codex",
        compositeKeyOverride: `codex:${sessionKey}`,
        sessionKey, userId: userId || null, spaceId,
        config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
        kernelUserKey: apiKey,
        headers, recoveryMessages: [],
        synthesizeMessages: () => {
          const synth = codexFormAnswersAsMessages(input);
          const rawOutputs = input
            .filter((it: any) => it?.type === "function_call_output")
            .map((it: any) => ({
              call_id: it.call_id,
              output_preview: String(it.output ?? "").slice(0, 200),
            }));
          if (rawOutputs.length > 0) {
            console.log(
              `[workbuddy-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synth).slice(0, 500)}`,
            );
          }
          return synth;
        },
        buildRecoverInitResult: async (recovered) => {
          const { buildSessionContextBlockWithToggles } = await import(
            "../../session/context-injector.js"
          );
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
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        },
        buildDefaultGateResponse: (initResult) => {
          if ((initResult as any).bypassReason !== "default-gate") return null;
          pipe.info("WORKBUDDY_GATE", "Default mode gate detected → notify user (first hit)");
          const gateText = (initResult as any).resetFlow
            ? "⚠️ mem:session-reset requires Plan mode support.\n\n"
              + "The workbuddy client is not currently in Plan mode, so the asset selection form cannot be shown.\n"
              + "Please switch to Plan mode and then run mem:session-reset."
            : "Plan mode was not detected as enabled; asset injection is skipped for this session. "
              + "To manage Skill / Task / Agent, please switch to Plan mode and start a new session. "
              + "This message will be answered directly by the LLM.";
          return buildMemResponse(gateText, {
            protocol: "responses",
            stream: isStream,
            requestId: `workbuddy-gate-${Date.now()}`,
          });
        },
      });
      if (!_orch.proceed) return _orch.response!;
      const initResult = _orch.initResult!;
      const wentThroughSessionInitStateMachine = _orch.wentThroughStateMachine;
      void wentThroughSessionInitStateMachine; // wb does not use it explicitly, but the placeholder is kept for alignment with anthropic/openai

      // Bypass path → skip injection (via shared stageSessionBypass)
      // wb-only: the log carries bypassReason; the resetFlow uses the teamIdShort field
      const _bypassResult = stageSessionBypass({
        bypassed: !!initResult.bypassed,
        resetFlow: !!initResult.resetFlow,
        sessionKey,
        logPrefix: "[workbuddy]",
        extraLog: ` (reason=${(initResult as any).bypassReason ?? "unknown"})`,
        useTeamIdShort: true,
      });
      if (_bypassResult.skipInjection) injectionSkipped = true;
      if (_bypassResult.resetFlowResult) _resetFlowResult = _bypassResult.resetFlowResult as unknown as typeof _resetFlowResult;

      assetCapabilities = await stageAssetCapabilities({
        bypassed: !!initResult.bypassed,
        sessionInfo: initResult.sessionInfo,
        config, spaceId,
        userKey: callerUserKey,
        warnPrefix: "[workbuddy] asset-capability resolve failed:",
      });

      // Prewarm pre-short-circuit: a turn hit by a mem-command does not go through forward and does not consume the hook-cache;
      // prewarming as usual would waste 2-3s + 3 network requests. See the detailed note at the symmetric position in handler.ts.
      let memCommandPending = false;
      {
        try {
          const userTextPeek = workbuddyAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText } = await import("../../mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek) {
              memCommandPending = true;
              console.log(`[workbuddy] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
            }
          }
        } catch (err) {
          console.warn(
            "[workbuddy] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      await stagePrewarmInjection({
        bypassed: !!initResult.bypassed,
        justRegistered: !!initResult.justRegistered,
        sessionInfo: initResult.sessionInfo,
        agentDetail: initResult.agentDetail,
        taskDetail: initResult.taskDetail,
        memCommandPending,
        config, sessionKey, userId, agentSource, spaceId, assetCapabilities,
        callerUserKey: callerUserKey ?? undefined,
        logTag: "[workbuddy] prewarm error:",
      });

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "Unknown",
          // The agentIdShort field name keeps its historical name, but here **the full agent_id is stored** (e.g. agt-1celthr7yn).
          // Previously slice(-8) truncated it to "elthr7yn" which users could not understand, symmetric with the team truncation issue.
          agentIdShort: initResult.sessionInfo?.agent_id
            ? String(initResult.sessionInfo?.agent_id) : "",
          // teamName comes from the session-init return value (looked up from cachedTeams);
          // The teamIdShort field name keeps its historical name, but here **the full team_id is stored** (e.g. team-wyuyb7sion).
          // Previously slice(-8) kept only the last 8 characters, so users saw a truncated string like "uyb7sion"; combined with
          // teamName often being empty, the fallback path displayed very incompletely. The team id itself is short, so showing it in full is harmless.
          teamName: initResult.teamName ?? undefined,
          teamIdShort: initResult.sessionInfo?.team_id
            ? String(initResult.sessionInfo?.team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error(
        "[workbuddy] session-init error:",
        err instanceof Error ? err.message : String(err),
      );
      sessionInfo = undefined;
      injectionSkipped = true;
    }
  }

  // ── mem:session-reset completion confirmation (via shared stage) ────────────────────────
  // wb uses the teamIdShort field name, but the stage expects teamId — direct mapping
  if (_resetFlowResult) {
    const { teamIdShort, ...rest } = _resetFlowResult;
    return stageSessionResetConfirmation({
      resetFlowResult: { ...rest, teamId: teamIdShort },
      protocol: "responses",
      isStream,
    });
  }

  // ── 8. mem-command intercept ────────────────────────────────────────────
  {
    const userText = workbuddyAdapter.extractUserText(input);
    if (userText) {
      const { parseCommandFromText, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } =
        await import("../../mem-command/index.js");
      // Warning: do not use parseMemCommand(body, "workbuddy") — it only parses body.messages[] (CC/CB shape),
      // WorkBuddy uses the Responses API (body.input[]), and passing it in always returns null → the command silently passes through to the LLM.
      // Use parseCommandFromText(userText) to parse the user text directly instead. Aligned with codexHandler's approach.
      let memCmd = parseCommandFromText(userText);
      // session-reset was already handled by the pre-hook; skip to prevent duplicate execution
      if (memCmd?.command === "session-reset") memCmd = null;
      if (memCmd) {
        if (!sessionInfo || injectionSkipped) {
          const errText = `⚠️ Session not initialized, command unavailable. Please complete session initialization (select a Team/Agent) first, then retry.`;
          const errResponse = buildMemResponse(errText, {
            protocol: "responses",
            stream: isStream,
            requestId: `mem-cmd-${Date.now()}`,
          });
          console.log(
            `[workbuddy] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`,
          );
          return errResponse;
        }
        pipe.info("WORKBUDDY_MEM_CMD", `mem command intercepted: ${memCmd.command}`);
        const memResult = await executeMemCommand(memCmd, {
          sessionKey,
          agentSource: "workbuddy",
          config,
          spaceId,
          userId: userId || "",
          apiKey: apiKey || "",
          sessionInfo: sessionInfo as Record<string, unknown>,
          // Warning: WorkBuddy uses the Responses API, the same protocol as codex. Pass "responses";
          // executeMemCommand will internally use the corresponding responses SSE skeleton to render the command response.
          protocol: "responses",
          stream: isStream,
          args: memCmd.args,
          // The task command family uses recent conversation to generate a draft. The Responses API body.input[] structure:
          //   { type:"message", role, content:[{type:"input_text"|"output_text", text}] }
          // extractSimpleMessages already has built-in recognition of that shape, converting it to the minimal {role, content} format.
          bodyMessages: extractSimpleMessages(input),
          // Option D: the taskDraft LLM follows the main model — workbuddy has a fixed agent, and upstream reuses the per-agent url
          model: modelId,
          upstreamUrl: config.upstream.agents?.["workbuddy"]?.url || config.upstream.url,
          // Warning: the workbuddy client's main-path upstream goes through OpenAI chat/completions
          // (path ending: /workbuddy/<id>/chat/completions), unrelated to ctx.protocol="responses"
          // (that is only used to render the response SSE skeleton).
          upstreamProtocol: "openai",
        });

        // ── TDAI L0 write + Skill extraction (fire-and-forget) ──
        // Aligned with codexHandler's post-mem-command archive logic: the command execution result does not block the response,
        // asynchronously trigger L0 write + skill extraction + langfuse reporting.
        //
        // assistantText uses memResult.messageText (the command response the proxy gives the user), not
        // userText (the command the user entered) — the L0 write pairs "what the user asked / what the system answered",
        // and using userText as the assistant would invert the semantics.
        const memArchiveCtx = buildWorkbuddyArchiveCtx({
          config,
          sessionInfo,
          injectionSkipped,
          input,
          sessionKey,
          userId: userId || "",
          callerUserKey,
          assetCapabilities,
        });
        if (memArchiveCtx) {
          void triggerWorkbuddyArchiveHooks(memArchiveCtx, memResult.messageText ?? "").catch((err: unknown) => {
            pipe.info(
              "WORKBUDDY_MEM_ARCHIVE_ERR",
              err instanceof Error ? err.message : String(err),
            );
          });
        }

        // ── Langfuse report for mem-command ──
        const endTime = new Date().toISOString();
        try {
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: `workbuddy:${modelId}:mem-${memCmd.command}`,
            model: modelId,
            startTime: startTime,
            endTime,
            input: userText ?? undefined,
            output: memResult.messageText ?? "OK",
            usage: undefined,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: [...lf.tags, `mem_cmd:${memCmd.command}`],
            traceInput: userText ?? undefined,
            traceOutput: memResult.messageText ?? "OK",
            observationMetadata: {
              mem_command: memCmd.command,
              protocol: "responses",
            },
          });
        } catch (err: unknown) {
          pipe.info(
            "WORKBUDDY_MEM_LANGFUSE_ERR",
            err instanceof Error ? err.message : String(err),
          );
        }

        console.log(
          `[workbuddy] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`,
        );
        return memResult.response;
      }
    }
  }

  // ── 9. Asset injection (runs every round) ────────────────────────────────────────
  if (
    !injectionSkipped &&
    sessionInfo &&
    config.injection?.enabled &&
    (config.injection.injectors?.length ?? 0) > 0
  ) {
    try {
      const { getInjectionPipeline } = await import("../../injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const { buildSessionContextBlockWithToggles } = await import(
        "../../session/context-injector.js"
      );
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as import("../../session/types.js").AgentDetail | null,
        cachedTaskDetail as import("../../session/types.js").TaskDetail | null,
        config.sessionInit,
        sessionKey,
      );

      // Construct a synthetic OpenAI body for the generic pipeline to process
      const syntheticBody: Record<string, unknown> = {
        messages: [
          { role: "system", content: sessionContextBlock ?? "" },
          { role: "user", content: userQuery || "." },
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
        turnSeq,
        requestPath: path,
        custom: {
          session: sessionInfo,
          userKey: callerUserKey ?? undefined,
          assetCapabilities,
        },
      });

      const injectedMessages = injectedBody.messages as
        | Array<Record<string, unknown>>
        | undefined;
      const sysMsg = injectedMessages?.[0];
      const injectedText = typeof sysMsg?.content === "string" ? sysMsg.content : "";

      if (injectedText.length > 0) {
        body = injectWorkbuddyAssets(body, { raw: injectedText });
      }
    } catch (err: unknown) {
      console.error(
        "[workbuddy] injection pipeline error:",
        err instanceof Error ? err.message : String(err),
      );
      // Degrade gracefully: forward without injection
    }
  }

  // ── 10. Forward ──────────────────────────────────────────────────────────
  const archiveCtx = buildWorkbuddyArchiveCtx({
    config,
    sessionInfo,
    injectionSkipped,
    input,
    sessionKey,
    userId: userId || "",
    callerUserKey,
    assetCapabilities,
  });
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, archiveCtx);
}
