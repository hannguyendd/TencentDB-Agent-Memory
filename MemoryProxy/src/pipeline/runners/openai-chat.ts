/** Core request handler: intercept → forward → parse usage → log. */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "../../logger.js";
import {
  apiKeyToKeyId,
  extractBearerToken,
  opikCreateLlmSpan,
  opikCreateTrace,
  opikUpdateTrace,
  uuidv7,
} from "../../opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import {
  buildLangfuseInputChat,
  buildRequestDebugMetadata,
} from "../../common/langfuse-debug.js";
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
import { stageModelGate, buildUnregisteredModelErrorBody } from "../stages/model-gate.js";
import { stageCredit } from "../stages/credit.js";
import { stageSystemUser } from "../stages/system-user.js";
import { stageBuildLangfuseTurnContext, stageReportAnalyzerTrace } from "../stages/observability.js";
import { stageSessionResetPreHook } from "../stages/session-reset-pre-hook.js";
import { stageSessionResetConfirmation } from "../stages/session-reset-confirmation.js";
import { stageMemCommandIntercept } from "../stages/mem-command-intercept.js";
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
import { stageInjectionRunner } from "../stages/injection-runner.js";
import { stageInstanceUpstreamEarly } from "../stages/instance-upstream-early.js";
import { stageInstanceUpstreamOverride } from "../stages/instance-upstream-override.js";
import { stageResolveTargetFull } from "../stages/resolve-target-full.js";
import { stageResolveUserId } from "../stages/resolve-user-id.js";
import { stageForwardWithRetry } from "../stages/forward-with-retry.js";
import { resolveAgentStrategy } from "../strategies/agent/index.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import { handleSystemUserPassthrough } from "../../systemUserPassthrough.js";
import { TdaiClient, buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../../tdai/recorder.js";
import { opencodeAdapter } from "../../agent-adapters/opencode.js";
import { trackWrite, withL0Retry } from "../../tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { emitModelIntentTelemetry } from "../../session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "../../extraction-gate.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "../../rate-limit/guard.js";

/**
 * Build a per-request TdaiClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.tdai.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
// TDAI client factory has been merged into tdai/client.ts::buildTdaiClientForRequest
const createTdaiClient = buildTdaiClientForRequest;

/**
 * Flatten messages into Opik-friendly chat messages (no truncation).
 */
export function flattenMessagesForOpik(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push(msg);
      continue;
    }

    if (!Array.isArray(content)) {
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        if (typeof content === "string" && content) {
          result.push({ role: "assistant", content });
        }
        for (const tc of m.tool_calls as unknown[]) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
        continue;
      }
      result.push(msg);
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
          textParts.push(`[thinking] ${b.thinking as string}`);
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
      const topLevelToolCalls = m.tool_calls;
      if (Array.isArray(topLevelToolCalls)) {
        for (const tc of topLevelToolCalls) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
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

// SKIP header sets have been merged into common/constants.ts
// Legacy handler.ts behavior: 4 HOP_BY_HOP items (without the x-tdai-user-key leak protection) —
// kept for compatibility; can be upgraded to the WITH_INTERNAL version in the future.
import { SKIP_REQUEST_HEADERS_HOP_BY_HOP as SKIP_REQUEST_HEADERS, filterResponseHeaders } from "../../common/constants.js";

/** Extract usage object from a block of OpenAI SSE text. */
export function extractSseUsage(sseText: string): Record<string, unknown> | null {
  let lastUsage: Record<string, unknown> | null = null;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      if (evt.usage && typeof evt.usage === "object") {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    } catch {
      // ignore malformed SSE lines
    }
  }

  return lastUsage;
}

/**
 * Build upstream body from original body + cost guard overrides.
 * The host does NOT branch on routing — it just applies overrides if present.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): Record<string, unknown> {
  let upstreamBody = body;
  if (target.bodyOverrides) {
    upstreamBody = { ...body, ...target.bodyOverrides };
  }
  return upstreamBody;
}

/**
 * Build upstream headers from request headers + routing auth overrides.
 * If config.upstream.apiKey is set, it overrides the request's Authorization header
 * only for the default route (not alternate model route).
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

  // `effectiveApiKey` is pre-resolved by the caller — see the resolveEffective
  // block near the call site. Non-empty → inject as server-side Bearer;
  // empty/undefined → passthrough (client's own Authorization survives).
  // cost-guard's `target.authHeaders` still gets to override everything.
  if (effectiveApiKey && !target.authHeaders) {
    headers["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
    }
  }

  if (sessionKey) {
    headers["x-vertex-ai-session-id"] = sessionKey;
  }
  return headers;
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 * openai version: retryBody overrides model, timeout gated on > 0.
 * Delegates to the shared stageForwardWithRetry implementation; the unique debug dump (body + md5) stays
 * inline in the caller (openai-specific md5 format).
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
  // ── Optional full-body dump (dev only) ── PROXY_DEBUG_DUMP_BODY=/tmp/xxx
  if (process.env.PROXY_DEBUG_DUMP_BODY) {
    try {
      const fs = await import("node:fs");
      const dir = process.env.PROXY_DEBUG_DUMP_BODY;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const fn = `${dir}/${ts}-${sessionKeyForDebug ?? "nosid"}.json`;
      fs.writeFileSync(fn, JSON.stringify({ url: target.url, headers: upstreamHeaders, body: upstreamBody }, null, 2));
      console.log(`[dump-body] wrote ${fn}`);
    } catch (e) {
      console.log(`[dump-body] error: ${(e as Error).message}`);
    }
  }

  // ── openai-specific md5 debug (two md5s: sys + all msgs) ──
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const msgs = (upstreamBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const sysMsg = msgs.find((m) => m.role === "system");
      const sysStr = typeof sysMsg?.content === "string"
        ? sysMsg.content
        : sysMsg?.content ? JSON.stringify(sysMsg.content) : "";
      const msgsFullStr = JSON.stringify(msgs);
      const sysMd5 = createHash("md5").update(sysStr).digest("hex").slice(0, 12);
      const msgsFullMd5 = createHash("md5").update(msgsFullStr).digest("hex").slice(0, 12);
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} protocol=openai sysBytes=${sysStr.length} sysMd5=${sysMd5} msgsCount=${msgs.length} msgsFullBytes=${msgsFullStr.length} msgsFullMd5=${msgsFullMd5}`,
      );
    } catch (e) {
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  return stageForwardWithRetry({
    target, upstreamHeaders, upstreamBody, originalBody, originalHeaders,
    pipe, forwardTimeoutMs, sessionKeyForDebug, rateLimitContext,
    protocol: "openai",
    timeoutBehavior: "gated",
    buildRetryBody: (orig, retryModel) => ({ ...orig, model: retryModel }),
  });
}

/** Main handler for POST /v1/chat/completions (OpenAI compat). */
export async function runOpenaiChatPipeline(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth (via shared stageAuth) ────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  // Historical handler.ts behavior: only accepts Bearer, ignores x-api-key → use bearer-only mode to stay equivalent.
  const earlyAuth = await stageAuth(c, "bearer-only");
  const earlyApiKey = earlyAuth.apiKey;
  const earlySpaceId = earlyAuth.spaceId;
  const earlyVerify = { userId: earlyAuth.userId, rejected: earlyAuth.rejected, rejectReason: earlyAuth.rejectReason };
  if (earlyAuth.rejected) {
    return c.json({ error: `Authentication failed: ${earlyAuth.rejectReason ?? "unknown"}` }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  // Parse via shared stage (also handles PROXY_DEBUG_DUMP_INBOUND dev-only dump)
  const parseResult = await stageParseBody(c);
  if (!parseResult.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // eslint-disable-next-line prefer-const
  let body = parseResult.body;

  // ── DEBUG: dump tools/instructions/metadata (Phase 1 workbuddy investigation) ──
  // Enabled only when sessionInit.debugVerboseLogging=true; off by default in production.
  if (config.sessionInit?.debugVerboseLogging) {
  try {
    const dbgPath = c.req.path;
    if (dbgPath.includes("/workbuddy/")) {
      // Keep only the condensed fields (do not dump the raw tools array, to avoid being truncated for excessive length)
      const dumpKeys = [
        "tool_choice",
        "toolset",
        "tool_config",
        "response_format",
        "metadata",
        "client_metadata",
      ];
      const dump: Record<string, unknown> = { path: dbgPath, model: body.model };
      for (const k of dumpKeys) {
        if (k in body) dump[k] = (body as Record<string, unknown>)[k];
      }
      const toolsField = body?.tools;
      if (Array.isArray(toolsField)) {
        dump.tools_summary = toolsField.map((t: unknown) => {
          const tt = t as Record<string, unknown>;
          const fn = (tt as any).function ?? {};
          const paramProps = fn.parameters?.properties;
          return {
            type: tt.type,
            name: (tt as any).name ?? fn.name,
            description:
              typeof (tt as any).description === "string"
                ? String((tt as any).description).slice(0, 400)
                : typeof fn.description === "string"
                  ? String(fn.description).slice(0, 400)
                  : undefined,
            param_keys: paramProps && typeof paramProps === "object"
              ? Object.keys(paramProps)
              : undefined,
          };
        });
      }
      // If messages[0] is system, dump it too (it may declare tool usage)
      const msgs = body?.messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const first = msgs[0] as Record<string, unknown>;
        if (first?.role === "system") {
          const content = typeof first.content === "string"
            ? first.content
            : JSON.stringify(first.content);
          dump.system_head = content.slice(0, 2000);
          dump.system_length = content.length;
        }
        dump.messages_count = msgs.length;
      }
      console.log(
        `[wb-tools-dump] path=${dbgPath} tools_count=${Array.isArray(toolsField) ? toolsField.length : 0}`,
      );
      console.log(`[wb-tools-dump-json] ${JSON.stringify(dump).slice(0, 60000)}`);

      // Extra: separately dump the full schema of AskUserQuestion (key investigation of Phase 1)
      if (Array.isArray(toolsField)) {
        const askTool = toolsField.find((t: unknown) => {
          const tt = t as any;
          const name = tt?.name ?? tt?.function?.name;
          return name === "AskUserQuestion";
        });
        if (askTool) {
          console.log(
            `[wb-ask-user-schema] ${JSON.stringify(askTool).slice(0, 20000)}`,
          );
        }
      }
    }
  } catch (e) {
    console.log(`[wb-tools-dump] error: ${String(e)}`);
  }
  } // debugVerboseLogging gate

  // ── Early AgentStrategy resolve: stageGates drive the systemUser/modelGate/identity gates ──
  // Earlier than model gate + systemUser + identity, because they all depend on stageGates.
  const _pathPartsEarly = c.req.path.split("/").filter(Boolean);
  const _agentFromPathEarly = _pathPartsEarly[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(_pathPartsEarly[0])
    ? _pathPartsEarly[0] : undefined;
  const _agentSourceEarly = _agentFromPathEarly ?? "claude-code";
  const _agentStrategy = resolveAgentStrategy(_agentSourceEarly);
  const _gates = _agentStrategy.stageGates;

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
  // instance carried any Option-2/3 conversation config (fix: 64e989a0 →
  // this file's next revision).
  // ── Early instance upstream config (via shared stage) ─────────────────
  // See docs/design/2026-08-25-instance-upstream-config.md §7.3 / §7.5 for details.
  const earlyResult = await stageInstanceUpstreamEarly({
    c, config, spaceId: earlySpaceId, earlyUserId: earlyVerify.userId,
    errorEnvelope: "openai",
  });
  if (earlyResult.blockedResp) return earlyResult.blockedResp;
  const _earlyAgent = earlyResult.agent;
  const _legacyProxy = earlyResult.legacyProxy;
  const _earlyConvResolution = earlyResult.earlyConvResolution;
  const _earlyExtractRow = earlyResult.earlyExtractRow;
  const _earlySysMatch = earlyResult.earlySysMatch;
  const _isCustomUpstream = earlyResult.isCustomUpstream;

  // ── Model gate + alias (gated by stageGates.modelGate) ────────────────
  // Gate not enabled → skip the pricing check entirely, no alias either (behavior equivalent to codex/wb minimal preset).
  let modelId: string;
  if (_gates.modelGate) {
    const gateResult = stageModelGate(requestedModel, config, _isCustomUpstream);
    if (!gateResult.ok) {
      return c.json(buildUnregisteredModelErrorBody(requestedModel), 400);
    }
    modelId = gateResult.modelId;
    const modelAliasApplied = gateResult.aliasApplied && typeof body.model === "string";
    if (modelAliasApplied) body.model = modelId;
  } else {
    // When the gate is off: modelId still needs to be resolved so downstream langfuse/logging have a value
    modelId = _isCustomUpstream ? requestedModel : resolveModelId(config.creditPricing, requestedModel);
  }

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

  // [debug] Log last 3 message roles and content types to diagnose session-init issues
  if (config.sessionInit?.enabled && messages.length > 2) {
    const tail = messages.slice(-3);
    const summary = tail.map((m: any, idx: number) => {
      const role = m.role;
      const ct = m.content;
      const contentType = typeof ct === "string" ? `string(${ct.slice(0, 80)})` :
        Array.isArray(ct) ? `array[${ct.map((b: any) => b.type).join(",")}]` :
        ct === null ? "null" : typeof ct;
      const tcid = m.tool_call_id;
      const tcs = m.tool_calls ? `tool_calls[${m.tool_calls.map((t: any) => t.id).join(",")}]` : "";
      return `[${idx}]role=${role} content=${contentType} tool_call_id=${tcid} ${tcs}`;
    }).join(" | ");
    console.log(`[session-init-debug] raw-tail msgs=${messages.length} ${summary}`);
  }

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/chat/completions) ──
  const pathParts = c.req.path.split("/").filter(Boolean);
  const agentFromPath = pathParts[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(pathParts[0])
    ? pathParts[0] : undefined;
  const agentSource = agentFromPath ?? "claude-code";
  // _agentStrategy / _gates were already resolved earlier (agentSource may differ from _agentSourceEarly
  // because pathParts below uses filter(Boolean)[0] to extract; the early resource uses the same rule so should be equivalent)

  // ── Identity inspection (gated by stageGates.identityRecord) ────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  if (_gates.identityRecord) {
    inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);
  }

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const apiKey = extractBearerToken(authHeader);
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
  let userId = stageResolveUserId({ c, config, earlyVerifyUserId: earlyVerify.userId, logTag: "handler" });
  if (userId) keyId = userId;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("../../injection/index.js");
    getInjectionPipeline(config);
  }

  // ── Request kind classification (auxiliary detection for OpenAI-chat clients) ──
  // dsh (deepseek-harness) sends compaction requests with the `x-deepseek-harness-compact: 1`
  // header, and title-gen relies on body characteristics, three-in-one. Such requests **must not** go through the session-init form,
  // nor trigger mem interception / L0 writes / skill extraction — they should pass straight through to upstream.
  // The codebuddy / claude-code client adapter classifyRequest always returns "main", behavior unchanged.
  const { resolveAgentAdapter } = await import("../../agent-adapters/index.js");
  const _adapter = resolveAgentAdapter(agentSource);
  const _requestKind = _adapter.classifyRequest(body as Record<string, unknown>, c.req.path, lcHeaders);
  // The legacy `/proxy/<spaceId>` prefix shares this gate with auxiliary: neither should touch memory.
  // The former is because the agent identity cannot be obtained (agentSource falls back to claude-code), and injecting by the wrong
  // profile is worse than not injecting; compression and billing are not under this gate and take effect as usual.
  const isAuxiliary = _requestKind === "auxiliary" || _legacyProxy;
  if (isAuxiliary) {
    const _reason = _legacyProxy ? "legacy /proxy prefix" : "auxiliary";
    console.log(`[request-classify] session=${sessionKey} agent=${agentSource} → ${_reason} (skip session-init/mem/injection/L0/skill)`);
  }

  // ── dsh (deepseek-harness) CLI headless / no-preset bypass ──────────────
  // When a dsh client is in a headless bundle or has no ask-user preset attached, body.tools
  // does not contain the `ask_user_question` tool. If the proxy stuffs in a fake `ask_user_question` tool_call,
  // the dsh agent-loop validates it as an unknown tool and throws directly. In that case bypass
  // session-init directly instead of showing a form — forcing a form in a no-UI scenario is meaningless.
  //
  // Decision: agentSource=dsh and body.tools non-empty and not containing ask_user_question.
  // (An empty tools array means pure conversation/aux, no fallback needed; ask_user_question being in tools means
  // a preset has attached a UI tool, so the form goes as normal.)
  //
  // NOTE(opencode): the opencode CLI likewise does not support the virtual ask_followup_question tool,
  // but goes through an independent header-driven session-init branch (see the opencode specialization block below),
  // so it does not need the headless bypass here — opencode can consume plain-text mem command responses,
  // and also needs injection / L0 / skill extraction, it just cannot show a form.
  const _dshHeadless = agentSource === "dsh" && (() => {
    const tools = (body as { tools?: unknown }).tools;
    if (!Array.isArray(tools) || tools.length === 0) return false;
    return !tools.some((t) => {
      const fn = (t as { function?: { name?: string }; name?: string })?.function;
      const n = fn?.name ?? (t as { name?: string })?.name;
      return n === "ask_user_question";
    });
  })();
  if (_dshHeadless) {
    console.log(`[request-classify] session=${sessionKey} agent=dsh headless/no-preset (no ask_user_question tool) → bypass session-init, direct passthrough`);
  }

  // ── Client capabilities detection ─────────────────────────────────────────
  // Probe whether the client "can respond to a fake ask tool_call initiated by the proxy".
  //
  // Currently only workbuddy gets a substantive decision: the new workbuddy official tool set dropped
  // AskUserQuestion (only 20 tools remain now); if the proxy side keeps sending tool_calls, the client
  // accepts them but does not know how to render them → stuck at pending. In that case it must degrade to text mode
  // (content chunk + markdown + plain-text parsing).
  //
  // Other clients (codebuddy / claude-code / dsh / codex / opencode / hermes /
  // openclaw) always get askUserQuestion=true, keeping existing behavior unchanged. The dsh headless scenario goes through
  // the independent _dshHeadless bypass branch above and is unaffected by this probe.
  const { detectClientCapabilities } = await import("../../session/client-capabilities.js");
  const _capabilities = detectClientCapabilities(agentSource, body);
  if (agentSource === "workbuddy" && !_capabilities.askUserQuestion) {
    console.log(`[request-classify] session=${sessionKey} agent=workbuddy no-AskUserQuestion tool → text-mode session-init`);
  }

  // ── mem:session-reset pre-hook (via shared stage) ──
  const resetResp = await stageSessionResetPreHook({
    c, config, body, agentSource, sessionKey, spaceId, userId,
    isAuxiliary, dshHeadless: _dshHeadless, isStream,
    protocol: "openai",
  });
  if (resetResp) return resetResp;

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("../../injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId || isAuxiliary || _dshHeadless;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} kind=${_requestKind} dshHeadless=${_dshHeadless} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped} spaceId=${spaceId}`);
  if (config.sessionInit?.enabled && conversationId && !isAuxiliary && !_dshHeadless) {
    try {
      // Round 18: the session-init main orchestration goes through the shared stageSessionInitOrchestrate;
      // the 4 callbacks of openai-chat:
      //   - synthesizeMessages: body.messages as is
      //   - buildRecoverInitResult: injectSessionContextWithToggles → messages (openai)
      //   - buildInterceptResponse: initResult.response directly (built into the state machine)
      //   - buildReqCtx: protocol="openai" + questionsAsArray detection + capabilities passthrough
      //
      // kernel /v3/meta/* uses x-tdai-user-key auth;
      // priority: client Authorization bearer > config.tdai.apiKey (openai-chat only).
      // Aligned with the kernelUserKey logic in workbuddyHandler.ts (client first there too).
      const kernelUserKey = apiKey || config.tdai?.apiKey || "";
      const _orch = await stageSessionInitOrchestrate({
        agentSourceForState: agentSource,
        sessionKey, userId: userId || null, spaceId,
        config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
        kernelUserKey,
        headers: lcHeaders,
        recoveryMessages: (body.messages as Array<Record<string, unknown>>) ?? [],
        synthesizeMessages: () => (body.messages as Array<Record<string, unknown>>) ?? [],
        buildRecoverInitResult: async (recovered) => {
          const { injectSessionContextWithToggles } = await import("../../session/context-injector.js");
          const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
          const outMsgs = recovered.bypassed
            ? inMsgs
            : injectSessionContextWithToggles(
                inMsgs,
                recovered.agentDetail ?? null,
                recovered.taskDetail ?? null,
                config.sessionInit,
                sessionKey,
              );
          return { messages: outMsgs as Record<string, unknown>[] };
        },
        buildReqCtx: () => {
          // Detect whether the questions field in the client's ask_followup_question schema is declared as array;
          // CB v1.106+ declares it as array and does type checks; old versions have no schema or questions has no type
          let questionsAsArray = true;
          const clientTools = Array.isArray(body.tools) ? body.tools as unknown[] : [];
          const afqTool = clientTools.find((t: any) =>
            t?.function?.name === "ask_followup_question" || t?.name === "ask_followup_question"
          ) as Record<string, unknown> | undefined;
          if (afqTool) {
            const params = (afqTool as any).function?.parameters ?? (afqTool as any).parameters;
            const qType = params?.properties?.questions?.type;
            questionsAsArray = qType === "array";
          } else if (clientTools.length === 0) {
            questionsAsArray = false;
          }
          return { stream: isStream, modelId: modelId as string, protocol: "openai", questionsAsArray, capabilities: _capabilities };
        },
        buildInterceptResponse: (initResult) => initResult.response ?? null,
      });
      if (!_orch.proceed) return _orch.response!;
      const initResult = _orch.initResult!;
      const wentThroughSessionInitStateMachine = _orch.wentThroughStateMachine;

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${(initResult as any).resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // See the symmetric position in anthropicHandler: only inherit when actually going through the sessionInit state machine.
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;

      // Case 1.5: Bypass path → skip ALL injection hooks (via shared stageSessionBypass)
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
        userKey: apiKey || null,
        warnPrefix: "[asset-capability] resolve failed:",
      });

      // Restore space_id from the URL BEFORE prewarm. Recovery paths and
      // legacy sessions can hydrate a SessionInfo whose `space_id` is empty;
      // prewarm calls (skill-injector, memory-injector) route to the correct
      // kernel tenant via this field, so a missing value at this point
      // silently poisons the prewarm cache with empty results.
      // See BUG-skill-injection-multinode.md §3.3(B).
      const { restoreSessionSpaceId } = await import("../../session/restore-space-id.js");
      restoreSessionSpaceId(
        initResult.sessionInfo as Record<string, unknown> | null | undefined,
        spaceId,
      );

      // Prewarm pre-short-circuit: a turn hit by a mem-command does not forward upstream and does not consume the
      // hook-cache; prewarming as usual would waste 2-3s + 3 network requests (knowledge's
      // 33% timeout would be amplified). Do a pure string parse first (<1ms, no side effects);
      // on a hit set memCommandPending so the prewarm branch short-circuits; the actual mem-command execution
      // still happens at the original position below, with L0 write / skill extract / langfuse all kept.
      //
      // fallback semantics: sessionJustRegistered is finalized here (see L786 above),
      // the checkFirst scenario can safely reuse it.
      let memCommandPending = false;
      if (!isAuxiliary && !_dshHeadless) {
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
            "[mem-command] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
          // A peek failure does not block the main path; degrade to the original behavior (normal prewarm).
        }
      }

      // Case 2 success → await prewarm so the first-turn pipeline always
      // hits the cache. A fire-and-forget void() here caused the bug where
      // the pipeline ran before the cache was populated, silently injecting
      // zero blocks for the entire first turn.
      await stagePrewarmInjection({
        bypassed: !!initResult.bypassed,
        justRegistered: !!initResult.justRegistered,
        sessionInfo: initResult.sessionInfo,
        agentDetail: initResult.agentDetail,
        taskDetail: initResult.taskDetail,
        memCommandPending,
        config, sessionKey, userId, agentSource, spaceId, assetCapabilities,
        callerUserKey: apiKey ?? undefined,
        logTag: "[hook-cache] handler prewarm error:",
      });

      // Case 2: Messages were cleaned → update body
      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Belt-and-suspenders: also restore on the local `sessionInfo` alias.
      // In practice this is the same object reference as
      // `initResult.sessionInfo` (already restored above), but the second
      // call is a no-op and guards against future refactors that copy
      // the object between these two lines.
      restoreSessionSpaceId(sessionInfo, spaceId);

      // Record the resetFlow info to the outer scope, used after the session-init block ends to return the confirmation response
      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "Unknown",
          // The agentIdShort field name keeps its historical name, but here **the full agent_id is stored** (e.g. agt-1celthr7yn).
          // Previously slice(-8) kept only the last 8 characters, displaying a truncated string like "elthr7yn" that users could not understand at all,
          // the same root cause as the team truncation issue. The agent id itself is short, so showing it in full is harmless and more readable.
          agentIdShort: initResult.sessionInfo?.agent_id
            ? String(initResult.sessionInfo?.agent_id) : "",
          // teamName comes from session-init (cachedTeams[selected].team_name);
          // teamId stores the **full** team_id (e.g. team-wyuyb7sion) — previously slice(-8)
          // would display "uyb7sion" which users could not understand, and the fallback was even worse when teamName was empty.
          teamName: initResult.teamName ?? undefined,
          teamId: initResult.sessionInfo?.team_id
            ? String(initResult.sessionInfo?.team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[session-init] Error in handleSessionInit:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // ── mem:session-reset completion confirmation (via shared stage) ────────────────────────
  if (_resetFlowResult) {
    return stageSessionResetConfirmation({
      resetFlowResult: _resetFlowResult,
      protocol: "openai",
      isStream,
    });
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // Position aligned with anthropicHandler.ts:847 — after session init completes, before injection.
  // On a hit: execute the command → write L0 → trigger skill extract → forge an OpenAI response and return, skipping
  // injection (does not break the KV cache) and the upstream forward (zero token consumption). Command interception is always enabled;
  // unknown commands get a hint from the KNOWN_COMMANDS fallback inside executeMemCommand.
  //
  // The pitfall solved: CodeBuddy goes through the OpenAI protocol and hits this handler; previously the mem-command intercept
  // was only attached to anthropicHandler, so when a CB user sent `mem:help` it passed straight through to the upstream LLM, returning
  // a "help text" hallucinated by the LLM (containing commands that do not exist at all, such as mem:atoms/mem:profile/mem:conversations).
  // Confirmed by this capture (langfuse trace d814929a...) and then filled in.
  //
  // Request classification: the OpenAI protocol does not do CC's fork/sidequery splitting (handler.ts is not wired into CC
  // routing), and all requests are treated as main — consistent with the codebuddy adapter classifyRequest.
  // ── mem: command intercept (via shared stage) ────────────────────────
  {
    const { extractSimpleMessages } = await import("../../mem-command/index.js");
    const memResp = await stageMemCommandIntercept({
      enabled: !isAuxiliary && !_dshHeadless,
      body: body as Record<string, unknown>,
      agentSource, sessionKey,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      injectionSkipped: injectedSkipped,
      sessionJustRegistered,
      config, spaceId, userId, apiKey: apiKey || "",
      isStream, protocol: "openai",
      modelId: modelId as string,
      upstreamUrl: (agentFromPath ? config.upstream.agents?.[agentFromPath]?.url : undefined) ||
        config.upstream.url,
      messages: messages as unknown[],
      createTdaiClientFn: createTdaiClient,
      bodyMessages: extractSimpleMessages(body.messages),
      assistantContentFormat: "openai-string",
      startTime, keyId, assetCapabilities,
      upstreamProtocol: "openai",
    });
    if (memResp) return memResp;
  }

  // aux requests (compaction/title) / dsh headless (no UI, no preset) do not write L0 — passed straight through
  const tdaiClient = isAuxiliary || _dshHeadless || assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
  // OpenCode places a fresh human turn at the end of messages. A tool-loop
  // continuation ends with a tool message and must not be counted as another
  // human input. Capture this before injection can prepend recalled memories.
  const lastInboundMessage = messages[messages.length - 1] as Record<string, unknown> | undefined;
  const opencodeUserQuery = agentSource === "opencode"
    ? (lastInboundMessage?.role === "user" && !isAuxiliary
        ? (opencodeAdapter.extractUserText(lastInboundMessage.content) ?? "")
        : "")
    : null;
  const tdaiUserMessage: TdaiMessage | null = agentSource === "opencode"
    ? (opencodeUserQuery ? { role: "user", content: opencodeUserQuery } : null)
    : extractLatestUserMessage(messages);

  // ── Context injection (via shared stage, before cost guard) ─────────────
  {
    const injected = await stageInjectionRunner({
      skip: injectedSkipped,
      config, body, protocol: "openai", messages,
      traceId, keyId, modelId: modelId as string, isStream, agentSource,
      userId, spaceId, sessionKey, requestPath: c.req.path,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      assetCapabilities,
      callerUserKey: apiKey,
    });
    body = injected.body;
    messages = injected.messages;
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve forward target (opaque extension — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name — same lookup
  // as anthropicHandler. Empty / missing entry → fall back to upstream.url,
  // preserving legacy behavior for configs that don't declare `agents:` at all.
  // ── Resolve forward target (via shared stage) ────────────────────────
  const resolvedTarget = await stageResolveTargetFull({
    c, config, protocol: "openai", agentFromPath,
    keyId, sessionKey, messages, hasTools, body,
    modelId: modelId as string, headers: lcHeaders,
    traceId, startTime, spaceId,
  });
  const target = resolvedTarget.target;
  let effectiveApiKey = resolvedTarget.effectiveApiKey;
  const forwardEndpoint = resolvedTarget.forwardEndpoint;
  const costGuardMode = resolvedTarget.costGuardMode;

  // ── Instance upstream config override (via shared stage) ──────────────
  // The b11bf612 GLM /v1 auto-insert fix goes through joinUrl; stageInstanceUpstreamOverride internally
  // already replaced manual concatenation with joinUrl(row.base_url, c.req.path); the openai protocol's joinUrl does not add /v1
  // (anthropic-only criterion), behavior consistent with the old manual concatenation.
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

  // ── Trace-level tags ──
  // agent_source identifies the client family (codebuddy / claude-code / codex / …), for
  // filtering traces by client in Langfuse; protocol only distinguishes the wire protocol, and the same wire
  // can correspond to multiple clients.
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:openai",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked.
  // Both sources drop back to 1 when their state is lost (truncated history /
  // expired counter), colliding with the usage rows this session already wrote
  // — Redis, when enabled, turns them into a per-session sequence that only
  // ever moves forward. See resolveMonotonicTurnSeq.
  // ── Turn context assembly via shared stageBuildLangfuseTurnContext ──
  // 58e4c55b opencode fix: opencode's userQuery is computed by the caller and overwritten, not going through
  // the stage's default resolveLatestUserQuery (see the opencodeUserQuery computation and comments above).
  const { turnSeq, lf } = await stageBuildLangfuseTurnContext({
    config, sessionKey, keyId, target, messages, protocol: "openai",
    traceTags, path: c.req.path, headers: lcHeaders, body,
    userQueryOverride: opencodeUserQuery,
  });
  stageReportAnalyzerTrace({ config, target, traceId, lf, keyId, sessionKey, turnSeq, startTime, spaceId });

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // CB / cursor / windsurf go through the OpenAI protocol and hit this handler; when debug is on, the request
  // structure + client fingerprint are stuffed into Langfuse observationMetadata, for capture analysis.
  // Off by default ({}), to avoid polluting online traces. See common/langfuse-debug.ts for details.
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    // This handler does not do CC client's fork/sidequery splitting (only anthropicHandler goes through that)
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "openai",
  });

  // ── Opik: create trace (gated by stageGates.opik) ─────────────────────
  const forkTraceId = _gates.opik ? opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenMessagesForOpik(messages) },
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
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "openai",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
    opikTraceId: traceId,
    opikKeyId: keyId,
    skipPrepare: costGuardMode === "cheap",
  });

  const upstreamBody = buildUpstreamBody(body, target);
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
  // Retry uses the same effective key as the primary path — when it
  // resolves to "" (agent entry present but no apiKey), retry also runs
  // on the client's own key, preserving the passthrough intent.
  if (effectiveApiKey) {
    originalHeaders["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  // Inject stream_options.include_usage for OpenAI compat
  if (isStream) {
    upstreamBody.stream_options = {
      ...(typeof upstreamBody.stream_options === "object" && upstreamBody.stream_options !== null
        ? (upstreamBody.stream_options as object)
        : {}),
      include_usage: true,
    };
  }

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  // forwardTimeout gate off → pass 0 so the timeoutBehavior='gated' branch of stageForwardWithRetry does not set an AbortSignal
  const forwardTimeoutMs = _gates.forwardTimeout ? (config.server.forwardTimeoutMs ?? 600_000) : 0;
  // Pass target.url so the FORWARD log reflects the actual per-agent upstream
  // (otherwise it prints the global default and misleads triage).
  pipe.forwardStart(target.url);
  let upstreamResp: Response;
  let retried = false;

  try {
    // Rate limit only applies to official models: custom upstream uses the user's own base_url + api_key,
    // and the upstream quota is managed by the user; the proxy's QPM/TPM buckets are computed by the operator for its own upstream, and applying them to custom
    // would be a false positive. Pass undefined → the `if (rateLimitContext)` inside forwardWithRetry skips naturally.
    // Likewise skipped when the rateLimit gate is off (for the codex/wb bootstrap B1 fix).
    const rateLimitContext = (_isCustomUpstream || !_gates.rateLimit) ? undefined : { config, instanceId: spaceId || undefined };
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      body, originalHeaders,
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
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers (strip hop-by-hop) — via shared filterResponseHeaders
  const respHeaders = filterResponseHeaders(upstreamResp.headers);

  // Upstream request id from response header (tokenhub / OpenAI-compatible
  // gateways set `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  // `routedFrom` is also present in cost-guard's opaque logMeta. Keep the
  // normalized post-retry value authoritative so fallback requests never book
  // savings or carry stale route attribution.
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response ───────────────────────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log upstream error body for 4xx responses
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errBodyStream, clientPassStream] = upstreamResp.body.tee();
      const errText = await new Response(errBodyStream).text();
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
        input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientPassStream, { status: upstreamResp.status, headers: respHeaders });
    }

    pipe.streamStart();

    const tapCtx: TapContext = {
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
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      isAuxiliary,
      isDshHeadless: _dshHeadless,
      sessionInfo,
      lf,
      spaceId,
      upstreamRequestId,
      langfuseDebug,
      debugMetadata,
      preparedStats,
      skipCreditReport,
      isCustomUpstream: _isCustomUpstream,
      gates: _gates,
    };
    const passthrough = createUsageTapTransform(tapCtx);
    // Order matters: tap first, reading the model's raw output; stripping after, only affecting the copy sent to the client.
    const tappedStream = upstreamResp.body
      .pipeThrough(passthrough)
      .pipeThrough(createCfqStripStream(
        "openai",
        preparedStats,
        createCfqStripObserver(pipe),
      ));

    return new Response(tappedStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  const respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const choices = respJson.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as Record<string, unknown>).message;
      if (msg && typeof msg === "object") {
        assistantMessage = msg as Record<string, unknown>;
      }
    }
  } catch {
    // non-JSON upstream response
  }

  const logMeta = responseLogMeta;

  // Report the completed response to the extension (same signal the streaming
  // path emits from its tap). Fire-and-forget.
  void notifyUpstreamResponse(
    config,
    {
      protocol: "openai",
      sessionKey,
      model: effectiveModel,
      stream: false,
      turnSeq: lf.turnSeq,
      text: typeof assistantMessage?.content === "string" ? assistantMessage.content : "",
      toolCalls: (Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : [])
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const argsVal = fn?.arguments;
          return {
            id: (t.id as string) ?? "",
            name: (fn?.name as string) ?? "",
            arguments: typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? ""),
          };
        })
        .filter((tc) => tc.id && tc.arguments),
      usage: usage ?? {},
    },
    pipe,
  );

  // Internal-use telemetry: log model_intent for each tool_calls in a non-streaming response.
  try {
    const toolCalls = assistantMessage?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const intents = toolCalls
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const name = (fn?.name as string) ?? "";
          const argsVal = fn?.arguments;
          const argsStr = typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? "");
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
    }
  } catch {
    // Telemetry must never block the business
  }

  if (usage) {
    // custom upstream does not count token buckets (symmetric with enforceRateLimit: the official rate-limit bucket only counts official calls)
    // When the rateLimit gate is off, token accounting is skipped too, symmetric with rate limiting itself
    if (!_isCustomUpstream && _gates.rateLimit) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId: effectiveModel,
        usage,
        protocol: "openai",
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

    const outputMessages = assistantMessage ? [assistantMessage] : [];
    if (_gates.opik) {
      opikUpdateTrace(config, {
        traceId,
        projectName: keyId,
        endTime,
        output: outputMessages,
        usage,
      });
      if (forkTraceId && !config.opik.stripRequestLogContent) {
        opikUpdateTrace(config, {
          traceId: forkTraceId,
          projectName: "request_log",
          endTime,
          output: outputMessages,
          usage,
        });
      }
    }

    // 58e4c55b: the opik LLM span stays inside the usage block (the span needs usage data);
    // recordTdaiTurn + langfuseReportGeneration are moved out to the upstreamResp.ok block below,
    // so that a "upstream 200 but no usage" successful response also writes L0 + langfuse generation as usual.
    if (_gates.opik) {
      opikCreateLlmSpan(config, {
        traceId,
        projectName: keyId,
        name: effectiveModel,
        startTime,
        endTime,
        inputMessages: flattenMessagesForOpik(messages),
        outputMessage: assistantMessage,
        model: effectiveModel,
        usage,
        tags: [
          "non-stream",
          ...(retried ? ["retry"] : []),
        ],
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
  }

  // A successful completion still has a conversation and a trace when the
  // upstream omits usage. Only token accounting requires usage data.
  if (upstreamResp.ok) {
    if (!usage) pipe.info("USAGE_MISSING", "non-stream response had no usage object");
    if (tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
      await recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistantContentForTdai(assistantMessage));
    } else if (tdaiClient) {
      logExtractionSkipped(config, "tdai-memory", sessionKey);
    }

    // Langfuse: report this LLM call as a generation under the turn trace.
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      output: assistantMessage,
      usage: usage ?? undefined,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: assistantMessage ?? undefined,
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
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // Skill extract trigger — count tool calls + buffer conversation.
  // Synchronous await: continue only after the store has persisted, ensuring the next turn reads the latest data across nodes.
  // aux requests (compaction/title) / dsh headless do not trigger skill extraction — keeping the archive buffer semantics clean
  if (!isAuxiliary && !_dshHeadless && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "openai",
      assetCapabilities,
    });
  } else if (!isAuxiliary && !_dshHeadless) {
    logExtractionSkipped(config, "skill", sessionKey);
  }

  // Credit usage reporting (non-streaming, gated by stageGates.creditReport).
  // Failures are exposed through the x-credit-report-error response header, without overwriting the LLM response body; a billing failure
  // also writes a CH raw fallback record. skipCreditReport: instance custom model → paid by the user, skipped.
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
    "openai",
    respText,
    preparedStats,
    createCfqStripObserver(pipe),
  );
  return new Response(clientRespText, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}


function assistantContentForTdai(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n") || null;
  }
  return content == null ? null : JSON.stringify(content);
}

function outputMessageContent(message: Record<string, unknown> | null): string | null {
  return assistantContentForTdai(message);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface TapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  traceId: string;
  /** Undefined when opik gate is off (no fork trace created). */
  forkTraceId?: string;
  requestPath: string;
  startTime: string;
  inputMessages: unknown[];
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger; null when session_init is disabled. */
  sessionKeyForSkill: string;
  /** Client type (first URL path segment) — passed to the extract trigger as one of the three-part isolation keys. */
  agentSource: string;
  /** True when this request was classified as auxiliary (compaction/title-gen) —
   * downstream L0/skill extract paths must skip to keep buffer semantics clean. */
  isAuxiliary: boolean;
  /** True when this dsh request came from CLI headless / no-preset (no ask_user_question
   * in tools) — behaves like aux for downstream side-effects. */
  isDshHeadless: boolean;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** The evaluated result of `config.langfuse.debug === true`. */
  langfuseDebug: boolean;
  /** buildRequestDebugMetadata result; {} when debug=false. */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
  /** Instance upstream config: skip credit reporting for custom model. */
  skipCreditReport?: boolean;
  /** true when the request is routed to a custom upstream (user's own base_url + api_key). */
  isCustomUpstream?: boolean;
  /** stageGates — decides whether each stage at the stream tail triggers */
  gates?: import("../strategies/agent/types.js").StageGates;
}

/** Accumulated tool call state during SSE streaming. */
interface ToolCallAccumulator {
  id: string;
  type: string;
  functionName: string;
  functionArguments: string;
}

/** Result of extracting content + tool_calls from SSE text. */
interface SseExtractResult {
  content: string;
  toolCallDeltas: Array<{ index: number; id?: string; type?: string; functionName?: string; functionArguments?: string }>;
}

/** Extract assistant content and tool_call deltas from OpenAI SSE text. */
function extractSseContentAndTools(sseText: string): SseExtractResult {
  let content = "";
  const toolCallDeltas: SseExtractResult["toolCallDeltas"] = [];

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const choices = evt.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string") {
          content += delta.content;
        }
        const tcArr = delta?.tool_calls;
        if (Array.isArray(tcArr)) {
          for (const tc of tcArr) {
            const t = tc as Record<string, unknown>;
            const idx = typeof t.index === "number" ? t.index : 0;
            const fn = t.function as Record<string, unknown> | undefined;
            toolCallDeltas.push({
              index: idx,
              id: typeof t.id === "string" ? t.id : undefined,
              type: typeof t.type === "string" ? t.type : undefined,
              functionName: typeof fn?.name === "string" ? fn.name : undefined,
              functionArguments: typeof fn?.arguments === "string" ? fn.arguments : undefined,
            });
          }
        }
      }
    } catch {
      // ignore malformed SSE lines
    }
  }
  return { content, toolCallDeltas };
}

/** Merge accumulated tool_call deltas into complete tool_call objects. */
function mergeToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
  deltas: SseExtractResult["toolCallDeltas"],
): void {
  for (const d of deltas) {
    let acc = accumulators.get(d.index);
    if (!acc) {
      acc = { id: "", type: "function", functionName: "", functionArguments: "" };
      accumulators.set(d.index, acc);
    }
    if (d.id) acc.id = d.id;
    if (d.type) acc.type = d.type;
    if (d.functionName) acc.functionName += d.functionName;
    if (d.functionArguments) acc.functionArguments += d.functionArguments;
  }
}

/** Create a TransformStream that passes bytes through unchanged,
 *  while extracting usage/content/tool_calls from SSE events in-band.
 */
function createUsageTapTransform(ctx: TapContext): TransformStream<Uint8Array, Uint8Array> {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  const decoder = new TextDecoder();
  let sseBuf = "";
  let lastUsage: Record<string, unknown> | null = null;
  let assistantContent = "";
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

  function processSseChunk(chunk: string): void {
    sseBuf += chunk;
    const parts = sseBuf.split("\n\n");
    sseBuf = parts.pop() ?? "";
    for (const part of parts) {
      const usage = extractSseUsage(part);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(part);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }
  }

  async function finalize(): Promise<void> {
    if (sseBuf.trim()) {
      const usage = extractSseUsage(sseBuf);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(sseBuf);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }

    const endTime = new Date().toISOString();

    let outputMessage: Record<string, unknown> | null = null;
    if (assistantContent || toolCallAccumulators.size > 0) {
      if (toolCallAccumulators.size > 0) {
        const toolCallEntries = Array.from(toolCallAccumulators.entries())
          .sort(([a], [b]) => a - b)
          .map(([, acc]) => JSON.stringify({ tool_call_id: acc.id, tool_name: acc.functionName, arguments: acc.functionArguments }, null, 2))
          .join("\n\n");
        const parts: string[] = [];
        if (assistantContent) parts.push(assistantContent);
        parts.push(toolCallEntries);
        outputMessage = { role: "assistant", content: parts.join("\n\n") };
      } else {
        outputMessage = { role: "assistant", content: assistantContent };
      }
    }

    // Report the completed response to the extension. Fire-and-forget; the
    // client has already been served by this point.
    void notifyUpstreamResponse(
      config,
      {
        protocol: "openai",
        sessionKey,
        model: modelId,
        stream: true,
        turnSeq: lf.turnSeq,
        text: assistantContent,
        toolCalls: Array.from(toolCallAccumulators.values())
          .filter((acc) => acc.id && acc.functionArguments)
          .map((acc) => ({
            id: acc.id,
            name: acc.functionName,
            arguments: acc.functionArguments,
          })),
        usage: lastUsage ?? {},
      },
      pipe,
    );

    // Internal-use telemetry: one model_intent per tool_use intent (fan-out).
    stageEmitModelIntent({
      gates: ctx.gates,
      // Align with the compositeKey shape of session_init_logs
      sessionKey: `${ctx.agentSource}:${sessionKey}`,
      turnSeq: lf.turnSeq,
      spaceId: spaceId,
      userId: keyId,
      agentSource: ctx.agentSource,
      intents: Array.from(toolCallAccumulators.values())
        .filter((acc) => acc.functionName)
        .map((acc) => ({ name: acc.functionName, arguments: acc.functionArguments })),
    });

    if (lastUsage) {
      // 58e4c55b: token accounting + usage log + opik span stay inside the usage block
      // (all three need usage data); the langfuseReportGeneration below is moved out,
      // so that a stream "upstream 200 but no usage chunk" also reports the generation as usual.
      await stageRecordTokenUsage({
        config, gates: ctx.gates,
        isCustomUpstream: !!ctx.isCustomUpstream,
        spaceId, modelId, usage: lastUsage, protocol: "openai",
      });
      stageWriteUsageLog({
        config, gates: ctx.gates, pipe,
        timestamp: endTime, modelId, keyId, sessionKey,
        turnSeq: lf.turnSeq, userInput: lf.userQuery || undefined,
        upstreamUrl, usage: lastUsage, requestReceivedAt: startTime,
        extensionStats: ctx.preparedStats ?? undefined,
        logMeta: ctx.logMeta, routedFrom: ctx.routedFrom, spaceId, upstreamRequestId,
      });
      stageOpikStreamSpan({
        config, gates: ctx.gates, pipe,
        traceId, forkTraceId: ctx.forkTraceId, keyId, modelId,
        startTime, endTime, inputMessages, outputMessage,
        usage: lastUsage, retried, upstreamUrl,
        updateTrace: true, streamTag: "stream",
      });
    }

    if (!lastUsage) pipe.info("USAGE_MISSING", "stream completed without usage chunk");
    // Langfuse: report the completed turn even if the upstream omitted usage.
    // Streaming path inputMessages stay as they are (other downstream pipelines use the same reference);
    // when debug=true, stuff the accumulated tool_call count into metadata as a fallback.
    try {
      const streamDebugExtra = ctx.langfuseDebug
        ? {
            stream_tool_call_count: toolCallAccumulators.size,
            stream_assistant_content_len: assistantContent.length,
          }
        : {};
      langfuseReportGeneration({
        traceId: lf.traceId,
        name: modelId,
        model: modelId,
        startTime,
        endTime,
        input: buildLangfuseInputChat(inputMessages, ctx.langfuseDebug, flattenMessagesForOpik),
        output: outputMessage,
        usage: lastUsage ?? undefined,
        traceName: lf.traceName,
        userId: lf.userId,
        sessionId: lf.sessionId,
        tags: lf.tags,
        traceInput: lf.userQuery || undefined,
        traceOutput: outputMessage ?? undefined,
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

    if (ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
      // Streaming does not await (it would slow the SSE stream-close feel), changed to trackWrite + retry:
      //   - trackWrite registers the in-flight promise into a global set; on SIGTERM index.ts will
      //     flushPendingWrites to wait or time out as a fallback, avoiding lost L0 during pod rolling.
      //   - withL0Retry handles tdai kernel transient drops / 5xx (3 backoffs, ~3.5s total).
      trackWrite(
        withL0Retry(() => recordTdaiTurn(
          ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
          outputMessageContent(outputMessage),
        )).catch((err: unknown) => pipe.error("TDAI_L0", err))
      );
    } else if (ctx.tdaiClient) {
      logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
    }

    pipe.streamDone(lastUsage);

    // Skill extract trigger — after stream finalization.
    // Synchronous await: continue only after the store has persisted, ensuring the next turn reads the latest data across nodes.
    // aux requests (compaction/title) / dsh headless skip skill triggering, keeping the archive buffer semantics clean.
    if (!ctx.isAuxiliary && !ctx.isDshHeadless && isExtractionAllowed(ctx.config, "skill")) {
      await triggerSkillExtractIfReady({
        config: ctx.config,
        sessionKey: ctx.sessionKeyForSkill,
        agentSource: ctx.agentSource,
        sessionInfo: ctx.sessionInfo,
        inputMessages: ctx.inputMessages,
        assistantMessage: outputMessage,
        protocol: "openai",
        assetCapabilities: ctx.assetCapabilities,
        toolCallCountOverride: toolCallAccumulators.size,
      });
    } else if (!ctx.isAuxiliary && !ctx.isDshHeadless) {
      logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
    }

    // Credit usage reporting (streaming) via shared stageCredit — the client has received the stream,
    // a failure can only be logged and written to CH raw (response headers cannot be appended).
    if (ctx.gates?.creditReport !== false) {
      stageCredit({
        skipCreditReport: ctx.skipCreditReport,
        config: ctx.config,
        path: ctx.requestPath,
        usage: lastUsage,
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

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        processSseChunk(decoder.decode(chunk, { stream: true }));
      } catch (err: unknown) {
        pipe.error("STREAM_TAP", err);
      }
    },
    async flush() {
      try {
        await finalize();
      } catch (err: unknown) {
        pipe.error("STREAM_FINALIZE", err);
      }
    },
  });
}
