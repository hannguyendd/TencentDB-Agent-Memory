/**
 * Anthropic Messages API handler.
 * Supports /v1/messages endpoint with streaming (SSE) and non-streaming modes.
 * Integrates with routing module, Opik observability, and JSONL logging.
 *
 * This handler uses ForwardTarget opaquely — no routing semantics
 * leak into the handler. All routing logic is encapsulated in the private module.
 */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "../../logger.js";
import {
  apiKeyToKeyId,
  opikCreateLlmSpan,
  opikCreateTrace,
  uuidv7,
} from "../../opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import { countHumanTurns, resolveMonotonicTurnSeq } from "../../turnSeq.js";
import type { ProxyConfig } from "../../types.js";
import {
  resolveForwardTarget,
  resolveSessionKey,
  resolveLatestUserQuery,
  reportAnalyzerTrace,
  type ForwardTarget,
} from "../../guard-adapter.js";
import { hasCostGuardMarker, isLegacyProxyPath, matchWhitelistEndpoint, resolveCostGuardMode } from "../../routes/whitelist.js";
import { writeRequestLog } from "../../requestLog.js";
import { prepareUpstreamRequest, notifyUpstreamResponse } from "../../request-prepare-adapter.js";
import {
  createCfqStripStream,
  createCfqStripObserver,
  stripCfqFromResponseText,
} from "../../common/cfq-strip.js";
import { tryReportCreditFromPath, extractSpaceIdFromPath } from "../../credit-reporter.js";
import {
  getInstanceUpstreamConfigs,
  resolveForAgent,
  resolveExtraction,
  shouldOverride,
  type Resolution,
} from "../../instance-upstream-cache.js";
import { resolveModelId, isModelInPricing } from "../../pricing.js";
import { inspectAndRecord } from "../../identity.js";
import { writeFailedReportRaw } from "../../clickhouse.js";
import { verifyUserKey } from "../../auth.js";
import { stageAuth } from "../stages/auth.js";
import { stageParseBody } from "../stages/parse-body.js";
import { stageModelGate } from "../stages/model-gate.js";
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
import { stageCredit } from "../stages/credit.js";
import { stageSystemUser } from "../stages/system-user.js";
import { stageBuildLangfuseTurnContext, stageReportAnalyzerTrace } from "../stages/observability.js";
import { stageSessionResetPreHook } from "../stages/session-reset-pre-hook.js";
import { stageResponseTailFix } from "../stages/response-tail-fix.js";
import { stageSessionResetConfirmation } from "../stages/session-reset-confirmation.js";
import { stageMemCommandIntercept } from "../stages/mem-command-intercept.js";
import { stageInjectionRunner } from "../stages/injection-runner.js";
import { stageInstanceUpstreamEarly } from "../stages/instance-upstream-early.js";
import { stageInstanceUpstreamOverride } from "../stages/instance-upstream-override.js";
import { stageResolveTargetFull } from "../stages/resolve-target-full.js";
import { stageResolveUserId } from "../stages/resolve-user-id.js";
import { stageForwardWithRetry } from "../stages/forward-with-retry.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import { handleSystemUserPassthrough } from "../../systemUserPassthrough.js";
import { TdaiClient, buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../../tdai/recorder.js";
import { trackWrite, withL0Retry } from "../../tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { emitModelIntentTelemetry } from "../../session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "../../extraction-gate.js";
import type { CcRequestKind } from "../../common/cc-request-classifier.js";
import { buildRequestDebugMetadata } from "../../common/langfuse-debug.js";
import { resolveAgentAdapter } from "../../agent-adapters/index.js";
import { resolveAgentStrategy } from "../strategies/agent/index.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "../../rate-limit/guard.js";

// SKIP header sets have been merged into common/constants.ts
// Legacy anthropic behavior: 5 WITH_INTERNAL items (including x-tdai-user-key leak protection)
import { SKIP_REQUEST_HEADERS_WITH_INTERNAL as SKIP_REQUEST_HEADERS, filterResponseHeaders } from "../../common/constants.js";

/**
 * Build a per-request TdaiClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.tdai.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
const createTdaiClient = buildTdaiClientForRequest;

/**
 * Normalize Anthropic top-level `system` field into a plain string for
 * observability. Anthropic accepts either a string or an array of content
 * blocks; here we join `text` blocks' text with "\n" and JSON-stringify
 * anything else. Returns "" when nothing textual is present.
 */
function stringifyAnthropicSystem(system: unknown): string {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      const b = block as Record<string, unknown>;
      if (b && b.type === "text" && typeof b.text === "string" && b.text) {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(system);
}

/**
 * Build the `input` payload for Langfuse / Opik. Two modes:
 *
 * - Normal mode (default): calls `flattenAnthropicMessagesForOpik` — content
 *   arrays are stringified for compact display. Loses `cache_control` markers,
 *   `thinking` blocks with signatures, native `tool_use`/`tool_result` shape.
 *
 * - Debug mode (`langfuse.debug=true`): passes the raw Anthropic body straight
 *   through, preserving every native structure. Use when investigating cache
 *   markers, thinking-signature issues, or request classification. Costs 2-5x
 *   more upload bandwidth + Langfuse storage — leave off in production.
 */
export function buildLangfuseInput(
  messages: unknown[],
  system: unknown,
  debug: boolean,
): unknown {
  if (debug) {
    // Preserve original shape end-to-end. Prepend a synthetic system message
    // when it's non-empty so the display order matches other consumers.
    const out: unknown[] = [];
    if (system !== undefined && system !== null && system !== "") {
      out.push({ role: "system", content: system });
    }
    return out.concat(messages);
  }
  return flattenAnthropicMessagesForOpik(messages, system);
}

/**
 * Flatten Anthropic messages for Opik / Langfuse display.
 *
 * Anthropic puts the system prompt on `body.system` (not inside `messages`),
 * so callers should pass it explicitly — otherwise the reported input omits
 * the system prompt entirely. When provided and non-empty, a synthetic
 * `{role:"system", content}` message is prepended to the result.
 */
export function flattenAnthropicMessagesForOpik(
  messages: unknown[],
  system?: unknown,
): unknown[] {
  const result: unknown[] = [];
  const systemText = stringifyAnthropicSystem(system);
  if (systemText) {
    result.push({ role: "system", content: systemText });
  }
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      result.push({ role, content: JSON.stringify(content) });
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${(b.thinking as string).slice(0, 200)}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

/** Extract Anthropic API key from request headers (x-api-key or Authorization Bearer). */
function extractApiKey(c: Context): string {
  const xApiKey = c.req.header("x-api-key");
  if (xApiKey) return xApiKey;

  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return "";
}

/**
 * Heuristically decide whether a `thinking` block carries a valid native
 * Anthropic/Bedrock signature.
 */
function hasValidThinkingSignature(block: Record<string, unknown>): boolean {
  const sig = block.signature;
  if (typeof sig !== "string" || sig.length < 40) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sig)) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}

/**
 * Sanitize `thinking` blocks across all assistant messages.
 *
 * Exported for unit testing.
 */
export function sanitizeThinkingBlocks(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; removed: number } {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, removed: 0 };

  let removed = 0;
  let changed = false;

  const newMessages = messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant" || !Array.isArray(m.content)) return msg;

    let msgChanged = false;
    const newContent = (m.content as unknown[]).filter((block) => {
      const b = block as Record<string, unknown>;
      const isThinking = b.type === "thinking" || b.type === "redacted_thinking";
      if (!isThinking) return true;
      if (hasValidThinkingSignature(b)) return true;
      removed += 1;
      msgChanged = true;
      return false;
    });

    if (!msgChanged) return msg;
    changed = true;
    return { ...m, content: newContent };
  });

  if (!changed) return { body, removed: 0 };
  return { body: { ...body, messages: newMessages }, removed };
}

/**
 * Build upstream body from original body + cost guard overrides.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): { body: Record<string, unknown>; sanitizedCount: number } {
  let result = body;
  if (target.bodyOverrides) {
    result = { ...result, ...target.bodyOverrides };
  }
  const sanitized = sanitizeThinkingBlocks(result);
  return { body: sanitized.body, sanitizedCount: sanitized.removed };
}

/**
 * Build upstream headers from request headers + cost guard auth overrides.
 */
function buildUpstreamHeaders(
  c: Context,
  _config: ProxyConfig,
  target: ForwardTarget,
  sessionKey?: string,
  effectiveApiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = "application/json";

  // `effectiveApiKey` is pre-resolved by the caller according to the
  // per-agent fallback rule (see the resolveEffectiveApiKey call site).
  //   - non-empty string → inject as server-side key, drop client's own
  //   - empty/undefined  → passthrough: keep whatever the client sent
  // The cost-guard extension can still fully override via target.authHeaders.
  if (effectiveApiKey && !target.authHeaders) {
    headers["x-api-key"] = effectiveApiKey;
    delete headers["authorization"];
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
      if (k === "x-api-key") delete headers["authorization"];
      if (k === "authorization") delete headers["x-api-key"];
    }
  }

  if (sessionKey) {
    headers["x-vertex-ai-session-id"] = sessionKey;
  }
  return headers;
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 * anthropic version: retryBody = originalBody (does not override model), timeout always on.
 * Delegates to stageForwardWithRetry; the unique 4-md5 debug (cache_control anchor) stays in the caller.
 */
async function forwardWithRetry(
  target: ForwardTarget,
  upstreamHeaders: Record<string, string>,
  upstreamBody: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  originalHeaders: Record<string, string>,
  pipe: ReturnType<typeof createPipeline>,
  forwardTimeoutMs: number,
  sessionKeyForDebug?: string,
  rateLimitContext?: { config: ProxyConfig; instanceId?: string },
): Promise<{ resp: Response; retried: boolean }> {
  // ── anthropic-specific md5 debug (cache_control anchor + sys, two md5s) ──
  // Used to observe KV cache hits: a hit only happens when the cache prefix bytes are identical.
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const sys = (upstreamBody as { system?: unknown }).system;
      const sysFullStr = sys === undefined ? "" : JSON.stringify(sys);
      const sysTextStr = typeof sys === "string"
        ? sys
        : Array.isArray(sys)
          ? sys.map((b) => (b as { text?: string }).text ?? "").join("\n")
          : "";
      const msgs = (upstreamBody as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      let anchorIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const content = msgs[i]?.content;
        if (Array.isArray(content)) {
          const hasCache = content.some((b) => b && typeof b === "object" && "cache_control" in (b as object));
          if (hasCache) { anchorIdx = i; break; }
        }
      }
      const prefixEnd = anchorIdx >= 0 ? anchorIdx + 1 : msgs.length;
      const msgsPrefixStr = JSON.stringify(msgs.slice(0, prefixEnd));
      const sysFullMd5 = createHash("md5").update(sysFullStr).digest("hex").slice(0, 12);
      const sysTextMd5 = createHash("md5").update(sysTextStr).digest("hex").slice(0, 12);
      const msgsPrefixMd5 = createHash("md5").update(msgsPrefixStr).digest("hex").slice(0, 12);
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} sysBytes=${sysFullStr.length} sysFullMd5=${sysFullMd5} sysTextMd5=${sysTextMd5} msgsCount=${msgs.length} msgsAnchorIdx=${anchorIdx} msgsPrefixBytes=${msgsPrefixStr.length} msgsPrefixMd5=${msgsPrefixMd5}`,
      );
    } catch (e) {
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  return stageForwardWithRetry({
    target, upstreamHeaders, upstreamBody, originalBody, originalHeaders,
    pipe, forwardTimeoutMs, sessionKeyForDebug, rateLimitContext,
    protocol: "anthropic",
    timeoutBehavior: "always",
    buildRetryBody: (orig, _retryModel) => orig, // anthropic does not override model
  });
}

/** Main handler for POST /v1/messages (Anthropic Messages API). */
export async function runAnthropicPipeline(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth (via shared stageAuth) ────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  // anthropic clients naturally carry x-api-key; use bearer-or-xapi mode to stay equivalent.
  const earlyAuth = await stageAuth(c, "xapi-first");
  const earlyApiKey = earlyAuth.apiKey;
  const earlySpaceId = earlyAuth.spaceId;
  const earlyVerify = { userId: earlyAuth.userId, rejected: earlyAuth.rejected, rejectReason: earlyAuth.rejectReason };
  if (earlyAuth.rejected) {
    return c.json({ type: "error", error: { type: "authentication_error", message: `Authentication failed: ${earlyAuth.rejectReason ?? "unknown"}` } }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  // Parse via shared stage (also PROXY_DEBUG_DUMP_INBOUND, dev-only)
  const parseResult = await stageParseBody(c);
  if (!parseResult.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // eslint-disable-next-line prefer-const
  let body = parseResult.body;

  // ── CC request classification (feature-gated, per-agent) ─────────────────
  // Classify the request via agentAdapter — each client has its own rules:
  //   - claude-code: three-way split by cache_control marker + tools/thinking
  //   - codebuddy / unknown: always main (not adapted, equivalent to the current behavior)
  //
  // When ccRequestRouting.enabled is off, force it to main and take the old path that is fully equivalent to the current behavior.
  // See docs/design/2026-07-30-cc-request-routing-plan.md for details
  const _pathPartsEarly = c.req.path.split("/").filter(Boolean);
  const _agentFromPathEarly = _pathPartsEarly[0]
    && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(_pathPartsEarly[0])
    ? _pathPartsEarly[0] : undefined;
  const _agentSourceEarly = _agentFromPathEarly ?? "claude-code";
  const agentAdapter = resolveAgentAdapter(_agentSourceEarly);
  // Resolve AgentStrategy early to gate downstream stages (identity, model gate,
  // opik, credit, rate-limit, telemetry). Default = full preset (100% behavior
  // preserved for CC/CB). Codex/WB opt-in gates per blueprint Phase 5.
  const _agentStrategy = resolveAgentStrategy(_agentSourceEarly);
  const _gates = _agentStrategy.stageGates;
  const ccRoutingEnabled = config.ccRequestRouting?.enabled === true;
  // adapter.classifyRequest's signature returns RequestKind (including "auxiliary"), but CC's adapter
  // only returns main/fork/sidequery (the anthropic protocol has no aux endpoints like /count_tokens
  // reaching here — aux endpoints are routed to handleAuxiliaryEndpoint in server.ts and do not enter this runner).
  // A forced narrowing is OK; everything downstream consumes it as CcRequestKind.
  const requestKind: CcRequestKind = (ccRoutingEnabled ? agentAdapter.classifyRequest(body) : "main") as CcRequestKind;
  // The legacy `/proxy/<spaceId>` prefix carries no agent segment, so the client identity cannot be determined; showing a form by the wrong agent
  // profile, intercepting mem commands, and injecting assets is worse than doing nothing, so memory features are all turned off.
  // Compression, routing and billing are not under this gate and take effect as usual.
  const legacyProxy = isLegacyProxyPath(c.req.path);
  /** Whether this turn is allowed to touch memory: mem commands, session-init, injection, L0, skill. */
  const memoryTurn = requestKind === "main" && !legacyProxy;

  // ── Model gate: reject requests whose `model` is not a registered display name ──
  // When the price list is configured, the client `model` must match the `modelName` of some entry (the display name,
  // case-insensitive). The real model_id is an internal detail and is not an entry point for clients. If unmatched, return
  // 400 directly, to avoid a request being forwarded successfully but going unbilled for lack of pricing. Skipped when the price list is empty (backward compatible).
  //
  // Internal/external users are treated alike — internal callers must also request by
  // `modelName`, ensuring upstream ids and billing/observability keys align
  // across all traffic.
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";

  // ── Early instance config fetch (needed before pricing gate) ──────────
  // Custom upstream (Option 2/3) may use models not in our pricing table,
  // and should NOT have their model alias-resolved to our internal IDs.
  //
  // The alias-skip gate depends on WHO is calling:
  //   - external caller → look at `type=conversation` (client's chat traffic)
  //   - systemUser (memory/knowledge/skill extraction) → look at
  //     `type=extraction` (client's memory-extraction upstream)
  // A conversation-typed row is unrelated to internal extraction traffic,
  // and vice versa. Prior code keyed off `conversation` unconditionally,
  // which regressed alias resolution for internal callers whenever the
  // instance carried any Option-2/3 conversation config.
  // ── Early instance upstream config (via shared stage, anthropic envelope) ──
  const earlyResult = await stageInstanceUpstreamEarly({
    c, config, spaceId: earlySpaceId, earlyUserId: earlyVerify.userId,
    errorEnvelope: "anthropic",
  });
  if (earlyResult.blockedResp) return earlyResult.blockedResp;
  const _earlyConvResolution = earlyResult.earlyConvResolution;
  const _earlyExtractRow = earlyResult.earlyExtractRow;
  const _earlySysMatch = earlyResult.earlySysMatch;
  const _isCustomUpstream = earlyResult.isCustomUpstream;

  // ── Model gate + alias (via shared stageModelGate, anthropic envelope) ──
  // modelGate off (codex/wb bootstrap state) → skip the 400 gate but still perform alias resolution,
  // ensuring upstream receives the canonical id; when the pricing table does not contain it, modelId falls back to requestedModel.
  let modelId: string;
  let modelAliasApplied = false;
  if (_gates.modelGate) {
    const gateResult = stageModelGate(requestedModel, config, _isCustomUpstream);
    if (!gateResult.ok) {
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
          },
        },
        400,
      );
    }
    modelId = gateResult.modelId;
    modelAliasApplied = gateResult.aliasApplied && typeof body.model === "string";
  } else {
    modelId = resolveModelId(config.creditPricing, requestedModel);
    modelAliasApplied = modelId !== requestedModel && typeof body.model === "string";
  }
  if (modelAliasApplied) body.model = modelId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Internal service accounts (see `systemUsers` config) bypass the entire
  // pipeline: no session-init, no injection, no routing. Matching key is
  // the userId resolved by verifyUserKey — NOT the raw apiKey. Auth-disabled
  // requests (userId == "") never match, so the short-circuit is inert unless
  // auth is on.
  //
  // We hand the already-parsed+alias-resolved `body` to the passthrough so
  // upstream sees the canonical model_id, aligning internal traffic with
  // external.
  if (_gates.systemUser) {
    const sysResp = await stageSystemUser(c, config, earlyVerify.userId, body);
    if (sysResp) return sysResp;
  }

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const isStream = body.stream === true;
  let hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/messages) ──
  const pathParts = c.req.path.split("/").filter(Boolean);
  const agentFromPath = pathParts[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(pathParts[0])
    ? pathParts[0] : undefined;
  const agentSource = agentFromPath ?? "claude-code";

  // ── Identity inspection ──────────────────────────────────────────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  if (_gates.identityRecord) {
    inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);
  }

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const apiKey = extractApiKey(c);
  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // ── Lowercased headers for agent profile detection + session key ──────────
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    lcHeaders[k.toLowerCase()] = v;
  }

// ── Session key: prefer conversation header, fallback to agent profile ───────────
  const { resolveConversationId } = await import("../../session/session-key.js");
  const conversationId = resolveConversationId(c);
  const sessionKey = conversationId ?? resolveSessionKey(config, lcHeaders, c.req.path, body, keyId);

  // ── Auth verification (user_key → user_id) ──────────────────────────────────────
  // Reuse the early verify result — it ran before body parse to decide the
  // system-user short-circuit; running verify again here would double the
  // network round-trip for every request.
  const spaceId = earlySpaceId;
  const userId = stageResolveUserId({ c, config, earlyVerifyUserId: earlyVerify.userId, logTag: "anthropicHandler" });
  if (userId) keyId = userId;

  // The sk-mem key (the x-tdai-user-key for TDAI ACL / MetadataClient) is the entry apiKey.
  const callerUserKey = apiKey || null;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("../../injection/index.js");
    getInjectionPipeline(config);
  }

  // ── mem:session-reset pre-hook (via shared stage) ──
  // anthropic uses memoryTurn as the gate (requestKind=main && !legacyProxy).
  // The header-only agent rejection branch + the main reset flow are all converged inside the stage.
  // The a08d67e9 dsh SSE tail fix wraps a wrapper around the header-only rejection response inside the stage.
  const _resetResp = await stageSessionResetPreHook({
    c, config, body, agentSource, sessionKey, spaceId, userId,
    isAuxiliary: false, dshHeadless: false, isStream,
    protocol: "anthropic", enabled: memoryTurn,
  });
  if (_resetResp) return stageResponseTailFix(_resetResp, agentSource, isStream);

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("../../injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped}`);
  // CC routing: SIDEQUERY skips session-init entirely (an independent small request has no concept of a conversation).
  //          FORK may go through L2b recovery to reuse the session already built by MAIN, but does not enter the form interaction path
  //          (borrowing MAIN's sessionInfo, see the kind === 'fork' branch guard below).
  const skipSessionInit = requestKind === "sidequery" || legacyProxy;
  if (config.sessionInit?.enabled && conversationId && !skipSessionInit) {
    try {
      // Round 18: the session-init main orchestration goes through the shared stageSessionInitOrchestrate;
      // the 4 callbacks of anthropic:
      //   - synthesizeMessages: body.messages as is
      //   - buildRecoverInitResult: systemAppend + messages (anthropic system is separate)
      //   - buildInterceptResponse: initResult.response directly
      //   - forkPassthroughHook: requestKind === "fork" + recover miss → passthrough (CC only)
      const compositeKey = `${agentSource}:${sessionKey}`;
      const _orch = await stageSessionInitOrchestrate({
        agentSourceForState: agentSource,
        sessionKey, userId: userId || null, spaceId,
        config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
        kernelUserKey: apiKey,
        headers: lcHeaders,
        recoveryMessages: (body.messages as Array<Record<string, unknown>>) ?? [],
        synthesizeMessages: () => (body.messages as Array<Record<string, unknown>>) ?? [],
        buildRecoverInitResult: async (recovered) => {
          const { buildSessionContextBlockWithToggles } = await import("../../session/context-injector.js");
          const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
          const systemAppend = recovered.bypassed
            ? null
            : buildSessionContextBlockWithToggles(
                recovered.agentDetail ?? null,
                recovered.taskDetail ?? null,
                config.sessionInit,
                sessionKey,
              );
          return { messages: inMsgs as Record<string, unknown>[], systemAppend };
        },
        buildReqCtx: () => ({
          stream: isStream, modelId: modelId as string, protocol: "anthropic",
        }),
        buildInterceptResponse: (initResult) => initResult.response ?? null,
        forkPassthroughHook: (recovered) => {
          // FORK L2b miss → passthrough. When MAIN is not yet initialized, fork is a no-op, letting upstream receive it as is.
          if (requestKind !== "fork") return null;
          if (recovered?.status === "initialized") return null;
          console.log(`[session-init:cc:fork] session=${compositeKey} L2b miss on fork request → passthrough`);
          return { intercepted: false, messages: body.messages as Record<string, unknown>[] };
        },
      });
      if (!_orch.proceed) return _orch.response!;
      const initResult = _orch.initResult!;
      const wentThroughSessionInitStateMachine = _orch.wentThroughStateMachine;

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${initResult.resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // sessionJustRegistered is for the checkFirst fallback of mem-command (the turn of the last step of session init,
      // "pending_task_select → initialized", where the user's very first mem: command is executed retroactively).
      // **Key**: only inherit justRegistered on the branch that really goes through the handleSessionInit state machine;
      // justRegistered=true on the L2b recovery branch is only a rebuild signal for downstream prewarm, not a session
      // init process, so sessionJustRegistered is not set then — otherwise mem-command would permanently scrape the first user message
      // in the conversation history and treat the user's very first mem:help as an "unconsumed command", executing it repeatedly every turn.
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;
      // Bypass path → skip ALL injection hooks (via shared stageSessionBypass)
      // In the reset flow, the user chose "skip" → a confirmation text must also be returned, without forwarding to the LLM
      const _bypassResult = stageSessionBypass({
        bypassed: !!initResult.bypassed,
        resetFlow: !!initResult.resetFlow,
        sessionKey,
        logPrefix: "[session-init]",
      });
      if (_bypassResult.skipInjection) injectedSkipped = true;
      if (_bypassResult.resetFlowResult) _resetFlowResult = _bypassResult.resetFlowResult as unknown as typeof _resetFlowResult;

      assetCapabilities = await stageAssetCapabilities({
        bypassed: !!initResult.bypassed,
        sessionInfo: initResult.sessionInfo,
        config, spaceId,
        userKey: callerUserKey,
        warnPrefix: "[asset-capability] resolve failed:",
      });

      // Prewarm pre-short-circuit: a turn hit by a mem-command does not forward upstream and does not consume the
      // hook-cache; prewarming as usual would waste 2-3s + 3 network requests. See the detailed note at the symmetric position in handler.ts.
      // fork/sidequery do not short-circuit (only effective when requestKind === "main").
      let memCommandPending = false;
      if (memoryTurn) {
        try {
          const { parseMemCommand } = await import("../../mem-command/index.js");
          let peek = parseMemCommand(body as Record<string, unknown>, agentSource);
          if (!peek && sessionJustRegistered) {
            peek = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
          }
          if (peek) {
            memCommandPending = true;
            console.log(`[hook-cache] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
          }
        } catch (err) {
          console.warn(
            "[mem-command] pre-prewarm peek failed (anthropic):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Await prewarm so the first-turn pipeline always hits the cache.
      // A fire-and-forget void() here caused the bug where the pipeline
      // ran before the cache was populated, silently injecting zero
      // blocks for the entire first turn.
      // When resetFlow=true clearBefore is required: session-reset switched the agent, so the old agent's
      // skill/wiki/knowledge cache must be cleared before writing the new one; always clearBefore for uniform semantics is safer.
      await stagePrewarmInjection({
        bypassed: !!initResult.bypassed,
        justRegistered: !!initResult.justRegistered,
        sessionInfo: initResult.sessionInfo,
        agentDetail: initResult.agentDetail,
        taskDetail: initResult.taskDetail,
        memCommandPending,
        config, sessionKey, userId, agentSource, spaceId, assetCapabilities,
        callerUserKey: callerUserKey ?? undefined,
        logTag: "[hook-cache] handler prewarm error (anthropic):",
      });

      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      // Anthropic: apply the session-context block onto body.system. The init
      // module cannot see body.system (it's a handler-layer concern), so it
      // hands the pre-built block back through `systemAppend` and we merge it
      // here with the same append helper used by the direct-inject path.
      if (initResult.systemAppend) {
        const { appendBlockToAnthropicSystem } = await import("../../session/context-injector.js");
        body = { ...body, system: appendBlockToAnthropicSystem(body.system, initResult.systemAppend) };
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Legacy sessions persisted before space_id was tracked will hydrate
      // with an empty space_id. Restore it from the URL each request so
      // downstream skill / knowledge / injection paths route to the correct
      // kernel tenant instead of falling back to `context-proxy` (500).
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }

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
      console.error("[session-init] Error in handleSessionInit (anthropic):", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // ── mem:session-reset completion confirmation ─────────────────────────────────────────────
  // Interaction flow of session-reset: pre-hook changes state → form pops up → user finishes the form →
  // completeRegistration → prewarm → reach here. At this point the user's original message "mem:session-reset"
  // is still in body.messages; if not intercepted it would be forwarded to the LLM, producing uncontrolled output.
  // The command execution has already completed (the new agent is bound, the cache refreshed) → return the confirmation text, do not go to the LLM.
  if (_resetFlowResult) {
    // a08d67e9 dsh SSE tail: the mem-command response to a dsh client needs a trailing \n added.
    // Warning: stageSessionResetConfirmation is async (returns Promise<Response>),
    // it must be awaited before being passed to the synchronous stageResponseTailFix — otherwise the wrapper's first-line
    // `!response.body` gate treats the Promise as "no body" and passes it through directly, and dsh v0.2+'s
    // strict SSE parser does not receive the `\n\n` ending → STREAM_CLOSED.
    // Impact: only the dsh + streaming branch actually enters the wrapper to pad bytes; all other agentSources
    // return as is at the wrapper's first-line `agentSource !== "dsh"` gate, so with or without await the
    // bytes are identical.
    const _resetConfirmResp = await stageSessionResetConfirmation({
      resetFlowResult: _resetFlowResult,
      protocol: "anthropic",
      isStream,
      thinking: !!body?.thinking,
    });
    return stageResponseTailFix(_resetConfirmResp, agentSource, isStream);
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // Detected after session init completes and before the injection pipeline.
  // On a hit: execute the command → write L0 → trigger skill extract → forge a response and return.
  // Skip injection (does not break the KV cache) and the upstream forward (zero token consumption).
  // Command interception is always enabled; unknown commands get a hint from the KNOWN_COMMANDS fallback inside executeMemCommand.
  //
  // parseMemCommand internally extracts the user input via agentAdapter.extractUserText according to client rules:
  //   - claude-code: take the last text block (skipping the <system-reminder> prefix metadata)
  //   - codebuddy / unknown: use the conservative "concatenate all text" logic
  //
  // CC routing: FORK/SIDEQUERY are requests constructed internally by the CC client; last_user does not start with `mem:`,
  //          and a forged response would break the cache assumption that fork requests rely on from MAIN. Skip interception.
  // ── mem: command intercept (via shared stage) ──
  // a08d67e9 dsh SSE tail fix: when a mem-command hits, whether the response is an error or a success,
  // dsh clients' strict parser need a trailing \n → the wrapper adds it once after the stage returns.
  {
    const { extractSimpleMessages } = await import("../../mem-command/index.js");
    const memResp = await stageMemCommandIntercept({
      enabled: memoryTurn,
      body: body as Record<string, unknown>,
      agentSource, sessionKey,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      injectionSkipped: injectedSkipped,
      sessionJustRegistered,
      config, spaceId, userId, apiKey: apiKey || "",
      callerUserKey: callerUserKey ?? undefined,
      isStream, protocol: "anthropic",
      modelId: modelId as string,
      upstreamUrl: (agentFromPath ? config.upstream.agents?.[agentFromPath]?.url : undefined) ||
        config.upstream.url,
      messages: messages as unknown[],
      createTdaiClientFn: createTdaiClient,
      bodyMessages: extractSimpleMessages(body?.messages),
      assistantContentFormat: "anthropic-blocks",
      startTime, keyId, assetCapabilities,
      upstreamProtocol: "anthropic",
      thinking: !!body?.thinking,
    });
    if (memResp) return stageResponseTailFix(memResp, agentSource, isStream);
  }

  const tdaiClient = assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
        userKey: callerUserKey,
      });
  const tdaiUserMessage = extractLatestUserMessage(messages);

  // ── Context injection (via shared stage, before cost guard) ────────────
  // CC routing:
  //   - SIDEQUERY: skip entirely (skip=true)
  //   - FORK:      readOnly=true (no self-heal on miss)
  //   - MAIN:      full pipeline
  const skipInjection = requestKind === "sidequery" || legacyProxy;
  if (skipInjection) {
    console.log(`[injection-debug] skipping injection for kind=sidequery session=${sessionKey}`);
  }
  {
    const injected = await stageInjectionRunner({
      skip: injectedSkipped || skipInjection,
      config, body, protocol: "anthropic", messages,
      traceId, keyId, modelId: modelId as string, isStream, agentSource,
      userId, spaceId, sessionKey, requestPath: c.req.path,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      assetCapabilities,
      callerUserKey: callerUserKey ?? undefined,
      readOnly: requestKind === "fork",
    });
    body = injected.body;
    messages = injected.messages;
    hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  }

  // ── Cost guard: resolve forward target (opaque — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name (URL path
  // prefix); both url and apiKey may be overridden per agent. When there's
  // no entry, we fall through to the Anthropic-specific global (costGuard
  // .anthropicUpstream) and finally to upstream.url — exactly as before.
  // ── Resolve forward target (via shared stage, anthropic protocol) ────
  const resolvedTarget = await stageResolveTargetFull({
    c, config, protocol: "anthropic", agentFromPath,
    keyId, sessionKey, messages, hasTools, body,
    modelId: modelId as string, headers: lcHeaders,
    traceId, startTime, spaceId,
  });
  const target = resolvedTarget.target;
  let effectiveApiKey = resolvedTarget.effectiveApiKey;
  const forwardEndpoint = resolvedTarget.forwardEndpoint;
  const costGuardMode = resolvedTarget.costGuardMode;

  // ── Instance upstream config override (via shared stage) ──────────────
  // The b11bf612 GLM anthropic base_url /v1 auto-insert fix goes through joinUrl, already
  // replaced manual concatenation with joinUrl(base, c.req.path) inside stageInstanceUpstreamOverride.
  const overrideResult = stageInstanceUpstreamOverride({
    earlyConvResolution: _earlyConvResolution,
    target, forwardEndpoint, apiKey, body, modelId,
    requestPath: c.req.path,
  });
  if (overrideResult.applied) {
    target.url = overrideResult.newTargetUrl;
    effectiveApiKey = overrideResult.newEffectiveApiKey;
    if (overrideResult.bodyModelUpdated) {
      body.model = overrideResult.newModelId;
      modelId = overrideResult.newModelId;
    }
  }
  const skipCreditReport = overrideResult.skipCreditReport;

  // ── Create pipeline logger ──────────────────────────────────────────────
  const pipe = createPipeline(config, traceId, target.model);
  pipe.requestReceived(messages.length, isStream);
  if (target.logLine) pipe.info("COST_GUARD", target.logLine);
  if (target.logLineExtra) pipe.info("COST_GUARD_DETAIL", target.logLineExtra);
  if (ccRoutingEnabled) {
    console.log(`[cc-routing] session=${sessionKey} kind=${requestKind} msgs=${messages.length}`);
  }



  // ── Trace-level tags ──
  // agent_source identifies the client family (codebuddy / claude-code / codex / …), for
  // filtering traces by client in Langfuse; protocol only distinguishes the wire protocol, and the same wire
  // can correspond to multiple clients.
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:anthropic",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked
  // (extension disabled/unavailable, or no-tools auxiliary request).
  // Both sources drop back to 1 when their state is lost (truncated history /
  // expired counter), colliding with the usage rows this session already wrote
  // — Redis, when enabled, turns them into a per-session sequence that only
  // ever moves forward. sidequery/fork share the sessionKey but carry a much
  // shorter history, so each kind counts on its own lane.
  // ── Turn context assembly via shared stageBuildLangfuseTurnContext ──
  // lane=requestKind: main/fork/sidequery each have an independent turnSeq lane.
  const { turnSeq, lf } = await stageBuildLangfuseTurnContext({
    config, sessionKey, keyId, target, messages, protocol: "anthropic",
    traceTags, path: c.req.path, headers: lcHeaders, body, lane: requestKind,
  });
  stageReportAnalyzerTrace({ config, target, traceId, lf, keyId, sessionKey, turnSeq, startTime, spaceId });

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // Used to capture CB / CC client fingerprints; when off it always returns {}, not polluting online metadata.
  // See common/langfuse-debug.ts for details.
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    requestKind,
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "anthropic",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = _gates.opik ? opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenAnthropicMessagesForOpik(messages, body.system) },
    tags: [...traceTags, ...target.tags],
    forkProjectName: "request_log",
    forkMetadata: {
      keyId,
      modelId: target.model,
      stream: isStream,
      upstreamUrl: target.url,
    },
  }) : undefined;

  // ── Request debug log ────────────────────────────────────────────────────
  writeRequestLog(config, body);

  // ── Build upstream request ───────────────────────────────────────────────
  // Per-agent apiKey resolution — three cases:
  //   (a) no entry in agents map           → global upstream.apiKey (fallback)
  //   (b) entry present, apiKey empty      → "" (passthrough, keep client key)
  //   (c) entry present, apiKey non-empty  → agent.apiKey (server-side key)
  // The presence of an entry (case b/c) is what cuts the global fallback —
  // effectiveApiKey already resolved above (before instance config override).
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "anthropic",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      system: body.system,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
    opikTraceId: traceId,
    opikKeyId: keyId,
    skipPrepare: costGuardMode === "cheap",
  });

  const { body: upstreamBody, sanitizedCount } = buildUpstreamBody(body, target);
  if (sanitizedCount > 0) {
    pipe.info(
      "FORWARD",
      `stripped ${sanitizedCount} invalid thinking block(s) from history`,
    );
  }

  // Retry headers: preserve original client headers (x-request-id, user-agent,
  // etc.), then force the primary upstream's auth — retry always goes to the
  // default upstream (never the alternate route), so its apiKey must be applied
  // just like the first-attempt path. Without this, retry sends the
  // client's raw auth to tokenhub and gets 401.
  const originalHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      originalHeaders[k] = v;
    }
  }
  // Retry uses the same effective key as the primary path — same three
  // cases as above. When it resolves to "" (agent entry present but no
  // apiKey), retry also runs on the client's own key: preserves the
  // "passthrough on this agent" intent even across retries.
  if (effectiveApiKey) {
    originalHeaders["x-api-key"] = effectiveApiKey;
    delete originalHeaders["authorization"];
  }

  const retryBody = sanitizeThinkingBlocks(body).body;

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  // forwardTimeout gate off (codex/wb bootstrap) → pass 0; the anthropic timeoutBehavior='always' branch
  // would use 0 as AbortSignal.timeout, behavior = abort immediately; so turning it off is only for when the caller explicitly wants "never time out".
  // Currently the anthropic runner only serves CC (full preset gates.forwardTimeout=true), so it will not hit the 0-timeout.
  const forwardTimeoutMs = _gates.forwardTimeout ? (config.server.forwardTimeoutMs ?? 600_000) : 0;
  // Pass target.url: when an override takes effect (instance-upstream custom group) and with cost-guard cheap-model routing,
  // target.url is changed; without passing it, the log would fall back to config.upstream.url and log the wrong thing (the actual fetch uses target.url,
  // but the log would mislead troubleshooting). handler.ts already does this; anthropicHandler had missed it.
  pipe.forwardStart(target.url);
  let upstreamResp: Response;
  let retried = false;

  try {
    // Rate limit only applies to official models: custom upstream uses the user's own base_url + api_key,
    // and the upstream quota is managed by the user; the proxy's QPM/TPM buckets are computed by the operator for its own upstream, and applying them to custom
    // would be a false positive. Pass undefined → the `if (rateLimitContext)` inside forwardWithRetry skips naturally.
    // Likewise skipped when the rateLimit gate is off (codex/wb bootstrap).
    const rateLimitContext = (_isCustomUpstream || !_gates.rateLimit) ? undefined : { config, instanceId: spaceId || undefined };
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      retryBody, originalHeaders,
      pipe, forwardTimeoutMs,
      sessionKey,
      rateLimitContext,
    );
    upstreamResp = result.resp;
    retried = result.retried;
  } catch (err: unknown) {
    if (isRateLimitExceededError(err)) {
      pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
      return err.response;
    }
    langfuseReportFailure({
      lf,
      model: target.model,
      startTime,
      endTime: new Date().toISOString(),
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers — via shared filterResponseHeaders
  const respHeaders = filterResponseHeaders(upstreamResp.headers);

  // Upstream request id from response header (tokenhub / Anthropic set
  // `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response (Anthropic SSE) ──────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log error body for 4xx
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errStream, clientStream] = upstreamResp.body.tee();
      const errText = await new Response(errStream).text();
      pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${errText.slice(0, 1000)}`);
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: target.model,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: true,
        usage: { error: true, status: upstreamResp.status, body: errText.slice(0, 500) },
        ...responseLogMeta,
        routedFrom,
        spaceId,
        upstreamRequestId,
      });
      langfuseReportFailure({
        lf,
        model: effectiveModel,
        startTime,
        endTime: new Date().toISOString(),
        input: buildLangfuseInput(messages, body.system, langfuseDebug),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
    }

    const [rawClientStream, tapStream] = upstreamResp.body.tee();
    pipe.streamStart();

    // Background: consume tap stream for Anthropic SSE → extract usage
    consumeAnthropicStream(tapStream, {
      config,
      modelId: effectiveModel,
      keyId,
      sessionKey,
      upstreamUrl: target.url,
      requestPath: c.req.path,
      traceId,
      forkTraceId,
      startTime,
      inputMessages: messages,
      system: body.system,
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      sessionInfo,
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      lf,
      spaceId,
      upstreamRequestId,
      requestKind,
      langfuseDebug,
      debugMetadata,
      preparedStats,
      skipCreditReport,
      isCustomUpstream: _isCustomUpstream,
      gates: _gates,
    });

    // CFQ stripping comes last: the tap goes through another tee branch and still reads the model's raw output.
    const clientStream = rawClientStream
      .pipeThrough(createSseThinkingFixStream(pipe))
      .pipeThrough(createCfqStripStream(
        "anthropic",
        preparedStats,
        createCfqStripObserver(pipe),
      ));

    return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  let respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const content = respJson.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      let thinkingPatched = false;
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text") textParts.push(block.text as string);
        // Fix thinking blocks with missing/null `thinking` field.
        // Some models (e.g. DeepSeek) emit `type: "thinking"` blocks
        // without a valid `thinking` string, causing Claude Code to crash
        // with "undefined is not an object (evaluating 's.thinking.length')".
        if (block.type === "thinking") {
          if (block.thinking === undefined || block.thinking === null) {
            block.thinking = "";
            thinkingPatched = true;
          } else if (typeof block.thinking !== "string") {
            block.thinking = String(block.thinking);
            thinkingPatched = true;
          }
        }
      }
      if (thinkingPatched) {
        respText = JSON.stringify(respJson);
        pipe.info("NONSTREAM_THINKING_FIX", "patched thinking block(s) with missing 'thinking' field");
      }
      outputContent = textParts.join("\n");
      // Preserve full content array (incl. tool_use blocks) for skill trigger.
      assistantMessage = { role: "assistant", content };

      // Report the completed response to the extension (same signal the
      // streaming path emits). Fire-and-forget.
      void notifyUpstreamResponse(
        config,
        {
          protocol: "anthropic",
          sessionKey,
          model: effectiveModel,
          stream: false,
          turnSeq: lf.turnSeq,
          text: outputContent,
          toolCalls: (content as Record<string, unknown>[])
            .filter((b) => b?.type === "tool_use")
            .map((b) => ({
              id: (b.id as string) ?? "",
              name: (b.name as string) ?? "",
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""),
            }))
            .filter((tc) => tc.id && tc.arguments),
          usage: usage ?? {},
        },
        pipe,
      );

      // Internal-use telemetry: log model_intent for each tool_use block in a non-streaming response.
      try {
        const intents = (content as Record<string, unknown>[])
          .filter((b) => b?.type === "tool_use")
          .map((b) => {
            const name = (b.name as string) ?? "";
            const input = b.input;
            const argsStr = typeof input === "string" ? input : JSON.stringify(input ?? "");
            return { name, arguments: argsStr };
          })
          .filter((i) => i.name);
        if (intents.length > 0 && _gates.modelIntentTelemetry) {
          emitModelIntentTelemetry({
            // Align with the compositeKey shape of session_init_logs
            sessionKey: `${agentSource}:${sessionKey}`,
            turnSeq: lf.turnSeq,
            spaceId,
            userId: keyId,
            agentSource,
            intents,
          });
        }
      } catch {
        // Telemetry must never block the business
      }
    }
  } catch {
    // non-JSON response
  }

  const logMeta = responseLogMeta;

  if (usage) {
    // custom upstream does not count token buckets (symmetric with enforceRateLimit: the official rate-limit bucket only counts official calls)
    // When the rateLimit gate is off, token accounting is skipped too
    if (!_isCustomUpstream && _gates.rateLimit) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId: effectiveModel,
        usage,
        protocol: "anthropic",
      });
    }
    if (_gates.writeLogUsage) {
      writeLog(config, {
        timestamp: endTime,
        event: "usage",
        modelId: effectiveModel,
        keyId,
        sessionKey,
        turnSeq: lf.turnSeq,
        userInput: lf.userQuery || undefined,
        upstreamUrl: target.url,
        stream: false,
        usage,
        requestReceivedAt: startTime,
        extensionStats: preparedStats ?? undefined,
        ...logMeta,
        routedFrom,
        spaceId,
        upstreamRequestId,
      });
    }

    if (_gates.opik) {
      opikCreateLlmSpan(config, {
        traceId,
        projectName: keyId,
        name: effectiveModel,
        startTime,
        endTime,
        inputMessages: flattenAnthropicMessagesForOpik(messages, body.system),
        outputMessage: outputContent ? { role: "assistant", content: outputContent } : null,
        model: effectiveModel,
        usage,
        tags: retried ? ["retry"] : undefined,
        forkProjectName: "request_log",
        forkTraceId,
        forkMetadata: {
          keyId,
          modelId: effectiveModel,
          stream: false,
          upstreamUrl: target.url,
        },
      });
    }

    // Langfuse: report this LLM call as a generation under the turn trace
    // When debug=true, output uses the native assistantMessage array (including tool_use / thinking /
    // native stop_reason); non-debug takes the original text concatenation to save storage.
    const langfuseOutput = langfuseDebug && assistantMessage
      ? assistantMessage
      : outputContent
      ? { role: "assistant", content: outputContent }
      : undefined;
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      output: langfuseOutput,
      usage,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: langfuseOutput,
      traceMetadata: { stream: false, retried, upstreamUrl: target.url, ...logMeta, ...debugMetadata },
      observationMetadata: { retried, ...logMeta, ...debugMetadata },
    });
  } else if (upstreamResp.status >= 400) {
    pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${respText.slice(0, 1000)}`);
    langfuseReportFailure({
      lf,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // CC routing: FORK/SIDEQUERY are spontaneous background calls by the CC client, not real user conversation turns,
  //          skip skill/L0 side effects. Credit is still reported (token consumption is real).
  const isMainDialog = memoryTurn;

  // Skill extract trigger — count tool_use blocks + buffer conversation.
  // Synchronous await: continue only after the store has persisted, ensuring the next turn reads the latest data across nodes.
  if (isMainDialog && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "anthropic",
      assetCapabilities,
    });
  } else if (isMainDialog) {
    logExtractionSkipped(config, "skill", sessionKey);
  } else {
    console.log(`[cc-routing] skip skill buffer for kind=${requestKind} session=${sessionKey}`);
  }

  // TDAI L0 write (non-streaming).
  //
  // Symmetric with the stream branch (1476-1481): write user_query + assistant reply into L0
  // short-term memory. **Previously only stream=true wrote**, and non-stream requests (such as stream:false
  // commonly used by tools/test scripts) were silently lost. Missing this call means CC non-stream scenarios
  // had no L0 memory writes at all.
  if (isMainDialog && tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
    recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, outputContent)
      .catch((err: unknown) => pipe.error("TDAI_L0", err));
  } else if (isMainDialog && tdaiClient) {
    logExtractionSkipped(config, "tdai-memory", sessionKey);
  } else if (!isMainDialog) {
    console.log(`[cc-routing] skip L0 write for kind=${requestKind} session=${sessionKey}`);
  }

  // Credit usage reporting (non-streaming) via shared stageCredit.
  if (_gates.creditReport) {
    const creditResult = await stageCredit({
      skipCreditReport,
      config,
      path: c.req.path,
      usage,
      effectiveModel,
      upstreamUrl: target.url,
      event: "usage",
      startTime: new Date(startTime),
      reqIds: pipe.ids(),
      upstreamRequestId,
      sessionKey,
      stream: false,
      keyId,
      routedFrom,
    }, pipe);
    if (creditResult.responseErrorHeader) {
      respHeaders.set("x-credit-report-error", creditResult.responseErrorHeader);
    }
  }

  // Last mile: notify / logging / billing have all seen the original response; only now do we touch the copy for the client.
  const clientRespText = stripCfqFromResponseText(
    "anthropic",
    respText,
    preparedStats,
    createCfqStripObserver(pipe),
  );
  return new Response(clientRespText, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}


/**
 * Create a TransformStream that patches Anthropic SSE events in-band.
 */
function createSseThinkingFixStream(
  pipe: ReturnType<typeof createPipeline>,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let patchedCount = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sseBuf += decoder.decode(chunk, { stream: true });

      const parts = sseBuf.split("\n\n");
      sseBuf = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part.split("\n");
        let dataLine = "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataLine = line;
          }
        }

        if (!dataLine) {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        const dataStr = dataLine.slice(6);
        if (!dataStr || dataStr === "[DONE]") {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        try {
          const evt = JSON.parse(dataStr) as Record<string, unknown>;
          let patched = false;

          if (evt.type === "content_block_start") {
            const block = evt.content_block as Record<string, unknown> | undefined;
            if (block?.type === "thinking") {
              if (block.thinking === undefined || block.thinking === null) {
                block.thinking = "";
                patched = true;
              } else if (typeof block.thinking !== "string") {
                block.thinking = String(block.thinking);
                patched = true;
              }
            }
          }

          // Fix content_block_delta with type=thinking_delta but missing thinking field.
          // Claude Code does `contentBlock.thinking += delta.thinking` which would
          // produce "null" or "undefined" strings if delta.thinking is not a string.
          if (evt.type === "content_block_delta") {
            const delta = evt.delta as Record<string, unknown> | undefined;
            if (delta?.type === "thinking_delta") {
              if (delta.thinking === undefined || delta.thinking === null) {
                delta.thinking = "";
                patched = true;
              } else if (typeof delta.thinking !== "string") {
                delta.thinking = String(delta.thinking);
                patched = true;
              }
            }
          }

          if (patched) {
            patchedCount++;
            const newDataLine = "data: " + JSON.stringify(evt);
            const newLines = lines.map((l) =>
              l.startsWith("data: ") ? newDataLine : l,
            );
            controller.enqueue(encoder.encode(newLines.join("\n") + "\n\n"));
          } else {
            controller.enqueue(encoder.encode(part + "\n\n"));
          }
        } catch {
          controller.enqueue(encoder.encode(part + "\n\n"));
        }
      }
    },

    flush(controller) {
      if (sseBuf.trim()) {
        controller.enqueue(encoder.encode(sseBuf));
      }
      if (patchedCount > 0) {
        pipe.info("SSE_FIX", `patched ${patchedCount} thinking block(s) with missing 'thinking' field`);
      }
    },
  });
}

// ── Stream processing helpers ────────────────────────────────────────────────

interface AnthropicTapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  requestPath: string;
  traceId: string;
  /** Undefined when opik gate is off (no fork trace created). */
  forkTraceId?: string;
  startTime: string;
  inputMessages: unknown[];
  /** Anthropic top-level `system` field (string or content-block array). */
  system: unknown;
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger. */
  sessionKeyForSkill: string;
  /** Client type (first URL path segment) — passed to the extract trigger as one of the three-part isolation keys. */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Tdai L0 write. */
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** CC request routing category, deciding whether skill/L0 side effects are triggered after the stream completes. */
  requestKind: CcRequestKind;
  /** The evaluated result of `config.langfuse.debug === true`, passed through to avoid re-reading config inside the stream. */
  langfuseDebug: boolean;
  /** buildRequestDebugMetadata evaluated result; {} when debug=false. */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
  /** Instance upstream config: skip credit reporting for custom model. */
  skipCreditReport?: boolean;
  /** true when the request is routed to a custom upstream (user's own base_url + api_key). */
  isCustomUpstream?: boolean;
  /** Stage-level gates from the resolved AgentStrategy. `undefined` = 100% CC behavior preserved. */
  gates?: import("../strategies/agent/types.js").StageGates;
}

/**
 * Consume Anthropic SSE stream in background, extract usage, log + Opik.
 */
function consumeAnthropicStream(stream: ReadableStream<Uint8Array>, ctx: AnthropicTapContext): void {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, system, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let streamCompleted = false;
    // For internal-use telemetry: accumulate each tool_use block by index.
    // Anthropic SSE protocol:
    //   1. content_block_start(type=tool_use)  → get index + name (input is empty {} at this point)
    //   2. content_block_delta(type=input_json_delta) → accumulate the partial_json string
    //   3. content_block_stop → this block ends
    // The earlier implementation only read the input in (1) (always empty) — now accumulate the partial_json in (2) by index.
    const toolUseAcc = new Map<number, { id: string; name: string; inputJson: string }>();

    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Anthropic stream reading exceeded 5 minutes");
        // completeStream is async; fire-and-forget here (a timeout can no longer await)
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();

      if (Object.keys(usage).length > 0) {
        await stageRecordTokenUsage({
          config, gates: ctx.gates,
          isCustomUpstream: !!ctx.isCustomUpstream,
          spaceId, modelId, usage, protocol: "anthropic",
        });
        stageWriteUsageLog({
          config, gates: ctx.gates, pipe,
          timestamp: endTime, modelId, keyId, sessionKey,
          turnSeq: lf.turnSeq, userInput: lf.userQuery || undefined,
          upstreamUrl, usage, requestReceivedAt: startTime,
          extensionStats: ctx.preparedStats ?? undefined,
          logMeta, routedFrom: ctx.routedFrom, spaceId, upstreamRequestId,
        });
        stageOpikStreamSpan({
          config, gates: ctx.gates, pipe,
          traceId, forkTraceId, keyId, modelId, startTime, endTime,
          inputMessages: flattenAnthropicMessagesForOpik(inputMessages, system),
          outputMessage: outputText ? { role: "assistant", content: outputText } : null,
          usage, retried, upstreamUrl,
          // legacy anthropic behavior: only create a span, no updateTrace, no "stream" tag
        });

        // Langfuse: report this LLM call as a generation under the turn trace
        // In a stream there is no complete native assistant content array available (tool_use blocks arrive in SSE as fragmented
        // incremental events); when debugging, stuff tool_use_count and stop_reason into metadata as a fallback.
        try {
          const streamDebugExtra = ctx.langfuseDebug
            ? {
                stream_tool_use_count: toolUseCount,
                stream_output_text_len: outputText.length,
              }
            : {};
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildLangfuseInput(inputMessages, system, ctx.langfuseDebug),
            output: outputText ? { role: "assistant", content: outputText } : undefined,
            usage,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: outputText ? { role: "assistant", content: outputText } : undefined,
            traceMetadata: {
              stream: true, retried, upstreamUrl, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
            observationMetadata: {
              retried, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
          });
        } catch (langfuseErr: unknown) {
          pipe.error("LANGFUSE_SPAN", langfuseErr);
        }
      }

      // CC routing: FORK/SIDEQUERY are not real conversation turns, skip L0/skill. Credit is still reported.
      const isMainDialog = ctx.requestKind === "main";

      // Tdai L0 write
      if (isMainDialog && ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
        // Streaming does not await (it would slow SSE stream close); trackWrite + withL0Retry handle the two packet-loss lines:
        //   - trackWrite registers the in-flight promise into a global set; on SIGTERM index.ts will
        //     flushPendingWrites as a fallback, avoiding L0 loss when the event loop exits before flushing during pod rolling.
        //   - withL0Retry retries with 3 backoffs (~3.5s), blocking tdai kernel transient drops / 5xx / network jitter.
        trackWrite(
          withL0Retry(() => recordTdaiTurn(
            ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
            outputText || null,
          )).catch((err: unknown) => pipe.error("TDAI_L0", err))
        );
      } else if (isMainDialog && ctx.tdaiClient) {
        logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
      } else if (!isMainDialog) {
        console.log(`[cc-routing] skip L0 write (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      pipe.streamDone(Object.keys(usage).length > 0 ? usage : null);

      // Report the completed response to the extension. Fire-and-forget; the
      // client has already been served by this point.
      void notifyUpstreamResponse(
        ctx.config,
        {
          protocol: "anthropic",
          sessionKey: ctx.sessionKey ?? "",
          model: modelId,
          stream: true,
          turnSeq: lf.turnSeq,
          text: outputText,
          toolCalls: Array.from(toolUseAcc.values())
            .filter((v) => v.id && v.inputJson)
            .map((v) => ({ id: v.id, name: v.name, arguments: v.inputJson })),
          usage,
        },
        pipe,
      );

      // Internal-use telemetry: each tool_use accumulated from the SSE stream emits one model_intent.
      // See docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2 F for details.
      // session_key must use the same compositeKey (agentSource:sessionKey) as session_init_logs,
      // otherwise the `session_key IN (init_sessions)` in the §4.1 CTE will not match.
      // Output sorted by index (restoring the model's generation order); inputJson is the streamed accumulated partial_json
      stageEmitModelIntent({
        gates: ctx.gates,
        sessionKey: `${ctx.agentSource}:${ctx.sessionKey}`,
        turnSeq: ctx.lf.turnSeq,
        spaceId: ctx.spaceId,
        userId: ctx.keyId,
        agentSource: ctx.agentSource,
        intents: Array.from(toolUseAcc.entries())
          .sort(([a], [b]) => a - b)
          .filter(([, v]) => v.name)
          .map(([, v]) => ({ name: v.name, arguments: v.inputJson || "{}" })),
      });

      // Skill extract trigger — after stream finalization.
      // Synchronous await: continue only after the store has persisted, ensuring the next turn reads the latest data across nodes.
      if (isMainDialog && isExtractionAllowed(ctx.config, "skill")) {
        await triggerSkillExtractIfReady({
          config: ctx.config,
          sessionKey: ctx.sessionKeyForSkill,
          agentSource: ctx.agentSource,
          sessionInfo: ctx.sessionInfo,
          inputMessages: ctx.inputMessages,
          assistantMessage: outputText
            ? { role: "assistant", content: outputText }
            : null,
          protocol: "anthropic",
          assetCapabilities: ctx.assetCapabilities,
          toolCallCountOverride: toolUseCount,
        });
      } else if (isMainDialog) {
        logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
      } else {
        console.log(`[cc-routing] skip skill buffer (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      // Credit usage reporting (streaming) via shared stageCredit.
      if (ctx.gates?.creditReport !== false) {
        stageCredit({
          skipCreditReport: ctx.skipCreditReport,
          config: ctx.config,
          path: ctx.requestPath,
          usage,
          effectiveModel: ctx.modelId,
          upstreamUrl: ctx.upstreamUrl,
          event: "usage",
          startTime: new Date(ctx.startTime),
          reqIds: pipe.ids(),
          upstreamRequestId: ctx.upstreamRequestId,
          sessionKey: ctx.sessionKey ?? "",
          stream: true,
          keyId: ctx.keyId,
          routedFrom: ctx.routedFrom,
        }, pipe).catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
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
            if (line.startsWith("data: ")) {
              dataStr = line.slice(6);
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5);
            }
          }

          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string;

            if (evtType === "message_start") {
              const message = evt.message as Record<string, unknown> | undefined;
              if (message?.usage) {
                Object.assign(usage, message.usage as Record<string, unknown>);
              }
            } else if (evtType === "message_delta") {
              if (evt.usage) {
                Object.assign(usage, evt.usage as Record<string, unknown>);
              }
            } else if (evtType === "content_block_delta") {
              const delta = evt.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                outputText += delta.text;
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                // Accumulate into the corresponding tool_use block (by index)
                try {
                  const idx = evt.index as number | undefined;
                  if (typeof idx === "number") {
                    const acc = toolUseAcc.get(idx);
                    if (acc) acc.inputJson += delta.partial_json;
                  }
                } catch {
                  // ignore — an instrumentation-level problem does not block the main path
                }
              }
            } else if (evtType === "content_block_start") {
              const block = evt.content_block as Record<string, unknown> | undefined;
              if (block?.type === "tool_use") {
                toolUseCount++;
                try {
                  const name = (block.name as string) ?? "";
                  const idx = evt.index as number | undefined;
                  if (name && typeof idx === "number") {
                    toolUseAcc.set(idx, { id: (block.id as string) ?? "", name, inputJson: "" });
                  }
                } catch {
                  // ignore — an accumulation failure does not affect the main path
                }
              }
            }
          } catch {
            // ignore malformed SSE data
          }
        }
      }

      // Drain remaining buffer
      if (sseBuf.trim()) {
        const lines = sseBuf.split("\n");
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
          }
        }
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            if (evt.type === "message_delta" && evt.usage) {
              Object.assign(usage, evt.usage as Record<string, unknown>);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("STREAM", err);
    }

    await completeStream();
  })().catch((err: unknown) => {
    pipe.error("STREAM_CONSUME", err);
  });
}
