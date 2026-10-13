// Credit usage reporting to external service (e.g. TDAI MemoryPlus).
// On LLM response, POST {SpaceId, MemoryLevel, MemoryDelta, CreditDelta} to
// configured URL. SpaceId is extracted from request path /proxy/<spaceId>/...,
// MemoryLevel is fixed "proxy", MemoryDelta is 0, CreditDelta = computed credit.

import type { CreditPricingConfig, CreditReportConfig } from "./types.js";
import { getModelPricing, resolveRulePricingDetail, resolveTierPricing } from "./pricing.js";
import { log } from "./report/log.js";

export interface CreditReportRequest {
  SpaceId: string;
  MemoryLevel: string;
  MemoryDelta: number;
  CreditDelta: number;
}

export interface CreditReportResult {
  ok: boolean;
  status?: number;
  /** Service-level response (echoed back, even on logical error). */
  response?: unknown;
  /** Transport/timeout error message. */
  error?: string;
}

/** Fixed MemoryLevel value used by this proxy when reporting credit. */
export const PROXY_MEMORY_LEVEL = "proxy";

/** Maximum length of the value placed into the `x-credit-report-error` header. */
const MAX_ERROR_HEADER_LEN = 256;

/**
 * A single usage object is shared by the JSONL/ClickHouse logger and the
 * credit reporter for a request. Cache its immutable calculation so all sinks
 * use exactly the same result and emit one audit log.
 */
interface CachedCreditCalculation {
  pricingConfig: CreditPricingConfig | null | undefined;
  modelId: string | undefined;
  upstreamUrl: string | undefined;
  requestTimeMs: number | undefined;
  credit: number;
}

const creditCalculationCache = new WeakMap<
  Record<string, unknown>,
  CachedCreditCalculation[]
>();

/**
 * Correlation ids stamped onto `credit.compute` / `credit.report`.
 *
 * Billing runs outside the pipeline logger, so without these its lines cannot
 * be joined to the rest of a request — neither to the pipeline lines in
 * proxy.log (via `requestId` / `traceId`) nor to the upstream's own logs and
 * the `upstream_request_id` column in ClickHouse.
 *
 * Purely observational: nothing here participates in the calculation or in the
 * dedupe cache key.
 */
export interface CreditLogContext {
  requestId?: string;
  traceId?: string;
  upstreamRequestId?: string;
  sessionKey?: string;
}

/** Drop empty fields so absent ids do not show up as noise in every line. */
function logIds(ctx: CreditLogContext | undefined): Record<string, string> {
  if (!ctx) return {};
  const out: Record<string, string> = {};
  if (ctx.requestId) out.requestId = ctx.requestId;
  if (ctx.traceId) out.traceId = ctx.traceId;
  if (ctx.upstreamRequestId) out.upstreamRequestId = ctx.upstreamRequestId;
  if (ctx.sessionKey) out.sessionKey = ctx.sessionKey;
  return out;
}

/**
 * Detect usage schema protocol from upstream URL path.
 *
 * - `/v1/messages` (including sub-paths `/v1/messages/count_tokens`, `/v1/messages?...`) → "anthropic"
 * - Any other path (including `/v1/chat/completions` and unrecognized paths) → "openai"
 *
 * Why openai is the fallback default: the Anthropic branch assumes input_tokens already has cache deducted,
 * so if wrongly applied to OpenAI usage it would bill the cache portion again at the input price;
 * conversely the OpenAI branch "subtracts first, then computes", so even if misapplied to Anthropic usage it only degrades to the equivalent legacy logic.
 * The risk is asymmetric, hence openai is the fallback.
 *
 * Case-insensitive.
 */
export function detectUsageProtocol(upstreamUrl: string): "anthropic" | "openai" | "responses" {
  const path = upstreamUrl.toLowerCase();
  // /v1/messages must be followed by / or ? or end of string, to avoid falsely matching /v1/messages_admin
  if (/\/v1\/messages(\/|\?|$)/.test(path)) return "anthropic";
  if (/\/v1\/responses(\/|\?|$)/.test(path) || /\/responses(\/|\?|$)/.test(path)) {
    return "responses";
  }
  return "openai";
}

/**
 * Extract SpaceId from a request path like `/proxy/<spaceId>/v1/messages`.
 *
 * Behaviour:
 * - Allows optional leading slash.
 * - Strips any `?query` suffix defensively (Hono's `c.req.path` normally has
 *   no query, but path can be provided by other code paths too).
 * - Rejects empty spaceId (`/proxy//...`), case mismatches (`/PROXY/...`),
 *   and similar-but-distinct prefixes (`/proxyfake/...`).
 *
 * @returns The spaceId string, or `null` when the path does not match the
 *   expected prefix. Callers should treat `null` as "do not report credit
 *   for this request".
 */
export function extractSpaceIdFromPath(path: string): string | null {
  // Defensive: drop query string if accidentally passed in.
  const safePath = path.split("?", 1)[0] ?? "";
  // /proxy/<spaceId>/...
  let match = /^\/?proxy\/([^/?]+)(?:\/|$)/.exec(safePath);
  if (match) return match[1] || null;
  // /<agent>/<spaceId>/...  (e.g. /claude-code/mem-example001/v1/messages)
  match = /^\/[^/]+\/([^/?]+)(?:\/|$)/.exec(safePath);
  if (match) {
    const agent = safePath.split("/").filter(Boolean)[0] ?? "";
    // Only capture spaceId when the first segment looks like an agent name
    if (/^(claude-code|codebuddy|codex|cursor|hermes|openclaw|workbuddy|dsh|opencode|pi)$/i.test(agent)) {
      return match[1] || null;
    }
  }
  return null;
}

/** Compute CreditDelta from an LLM usage object using model-specific pricing.
 *
 * Only applies pricing-based calculation when upstreamUrl contains "tokenhub".
 * For non-TokenHub upstreams (e.g. copilot), returns 0.
 *
 * Uses `detectUsageProtocol(upstreamUrl)` to choose the Anthropic or OpenAI branch:
 *
 * Anthropic branch (`/v1/messages`):
 *   - nonCacheInput = usage.input_tokens (TokenHub already deducts the cache portion)
 *   - cacheRead = usage.cache_read_input_tokens
 *   - cacheWrite5m / cacheWrite1h prefer those in `usage.cache_creation`
 *     `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`
 *   - `cache_creation_input_tokens` without TTL breakdown is priced as 5m
 *
 * OpenAI Chat branch (`/v1/chat/completions`):
 *   - nonCacheInput = max(0, usage.prompt_tokens - cached_tokens) (prompt_tokens includes cache)
 *   - cacheRead = usage.cache_read_tokens ?? usage.prompt_tokens_details.cached_tokens
 *   - cacheWrite5m = usage.cache_write_tokens (compatible with `prompt_cache_write_tokens`)
 *   - Without TTL breakdown, all cache writes are priced as 5m
 *
 * Credit formula (per 1K tokens):
 *   credit = (nonCacheInput / 1000) * pricing.input
 *          + (output / 1000) * pricing.output
 *          + (cacheRead / 1000) * pricing.cacheRead
 *          + (cacheWrite5m / 1000) * pricing.cacheWrite5m
 *          + (cacheWrite1h / 1000) * pricing.cacheWrite1h
 *
 * If upstream is not TokenHub, returns 0.
 * If upstream is TokenHub but model pricing is not found, returns 0
 *   (the raw usage lands in the raw table via clickhouse's `getRawUsageReason → "unknown_model"`
 *   path for tracing, avoiding reporting token counts as credit, which would distort billing).
 */
export function computeCreditDelta(
  usage: Record<string, unknown> | null | undefined,
  pricingConfig: CreditPricingConfig | null | undefined,
  modelId?: string,
  upstreamUrl?: string,
  requestTime?: Date,
  logContext?: CreditLogContext,
): number {
  if (!usage) return 0;

  // Only apply pricing-based calculation for TokenHub upstream
  const isTokenHub = upstreamUrl ? /tokenhub/i.test(upstreamUrl) : false;
  if (!isTokenHub) return 0;

  const requestTimeMs = requestTime?.getTime();
  const cached = creditCalculationCache.get(usage)?.find(
    (entry) =>
      entry.pricingConfig === pricingConfig &&
      entry.modelId === modelId &&
      entry.upstreamUrl === upstreamUrl &&
      Object.is(entry.requestTimeMs, requestTimeMs),
  );
  if (cached) return cached.credit;

  const protocol = detectUsageProtocol(upstreamUrl ?? "");

  // Common fields
  const output = numField(usage.completion_tokens) || numField(usage.output_tokens);

  // Extract the 5 token categories per protocol branch
  let nonCacheInput = 0;
  let cacheRead = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  let cacheWriteSource = "none";

  if (protocol === "anthropic") {
    // Anthropic (TokenHub): input_tokens already has cache deducted
    nonCacheInput = numField(usage.input_tokens);
    cacheRead = numField(usage.cache_read_input_tokens);
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
    const ephemeral5m = numField(cacheCreation?.ephemeral_5m_input_tokens);
    const ephemeral1h = numField(cacheCreation?.ephemeral_1h_input_tokens);
    const totalCacheWrite = numField(usage.cache_creation_input_tokens);
    cacheWrite5m = ephemeral5m;
    cacheWrite1h = ephemeral1h;
    // `cache_creation_input_tokens` is the total; remaining tokens with no explicit TTL use the default 5m.
    const unspecifiedCacheWrite = Math.max(0, totalCacheWrite - ephemeral5m - ephemeral1h);
    cacheWrite5m += unspecifiedCacheWrite;
    cacheWriteSource = ephemeral1h > 0
      ? unspecifiedCacheWrite > 0 ? "anthropic_ttl_detail_plus_default_5m" : "anthropic_ttl_detail"
      : totalCacheWrite > 0 ? "anthropic_default_5m" : "none";
  } else if (protocol === "responses") {
    // OpenAI Responses API: input_tokens includes cached input tokens.
    const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
    const inputTokens = numField(usage.input_tokens);
    cacheRead =
      numField(usage.cache_read_tokens) ||
      numField(inputDetails?.cached_tokens);
    nonCacheInput = Math.max(0, inputTokens - cacheRead);
    // TokenHub Responses currently has no documented cache-write field. Treat
    // a compatible future/third-party field without TTL detail as default 5m.
    cacheWrite5m = numField(usage.cache_write_tokens) || numField(usage.prompt_cache_write_tokens);
    cacheWrite1h = 0;
    cacheWriteSource = cacheWrite5m > 0 ? "openai_default_5m" : "none";
  } else {
    // OpenAI: prompt_tokens includes cache, so cached_tokens must be subtracted
    const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const promptTokens = numField(usage.prompt_tokens);
    cacheRead =
      numField(usage.cache_read_tokens) ||
      numField(promptDetails?.cached_tokens);
    nonCacheInput = Math.max(0, promptTokens - cacheRead);
    // Chat cache_write_tokens has no TTL detail; bill it at the default 5m rate.
    cacheWrite5m = numField(usage.cache_write_tokens) || numField(usage.prompt_cache_write_tokens);
    cacheWrite1h = 0;
    cacheWriteSource = cacheWrite5m > 0 ? "openai_default_5m" : "none";
  }

  // Look up pricing
  const pricing = getModelPricing(pricingConfig, modelId ?? null);

  let credit: number;
  let fallback: string | undefined;
  let ruleId: string | undefined;
  let pricingTimezone: string | undefined;
  let totalInput: number | undefined;
  let effectivePricing: ReturnType<typeof resolveTierPricing> | undefined;

  if (pricing) {
    // Tier criterion: nonCacheInput + cacheRead (i.e. total input context length)
    totalInput = nonCacheInput + cacheRead;
    const rulePricing = resolveRulePricingDetail(pricingConfig, pricing, requestTime);
    ruleId = rulePricing.ruleId;
    pricingTimezone = rulePricing.timezone;
    const selectedPricing = resolveTierPricing(
      rulePricing.pricing,
      totalInput,
    );
    effectivePricing = selectedPricing;

    // Compute the credit value (tiered as a whole; all token types use the same tier's unit price)
    credit =
      (nonCacheInput / 1000) * selectedPricing.input +
      (output / 1000) * selectedPricing.output +
      (cacheRead / 1000) * selectedPricing.cacheRead +
      (cacheWrite5m / 1000) * selectedPricing.cacheWrite5m +
      (cacheWrite1h / 1000) * selectedPricing.cacheWrite1h;
  } else {
    // Unpriced model: do not report credit, to avoid billing token counts as credit.
    // The raw usage lands in the raw table via clickhouse-side `getRawUsageReason → "unknown_model"` for tracing.
    credit = 0;
    fallback = "unknown_model";
  }

  log.debug("credit.compute", {
    ...logIds(logContext),
    protocol,
    model: modelId ?? "unknown",
    rawUsage: usage,
    nonCacheInput,
    output,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteSource,
    totalInput,
    requestTime: (requestTime ?? new Date()).toISOString(),
    pricingTimezone,
    pricingRuleId: ruleId ?? "legacy",
    effectivePricing,
    credit,
    ...(fallback ? { fallback } : {}),
  });

  const cacheEntries = creditCalculationCache.get(usage) ?? [];
  cacheEntries.push({ pricingConfig, modelId, upstreamUrl, requestTimeMs, credit });
  creditCalculationCache.set(usage, cacheEntries);

  return credit;
}

function numField(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** POST credit usage to the configured endpoint.
 *  Never throws — returns a structured result the caller can react to. */
export async function reportCreditUsage(
  config: CreditReportConfig,
  payload: CreditReportRequest,
): Promise<CreditReportResult> {
  const fetchOpts: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  if (config.timeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(config.timeoutMs);
  }
  try {
    const resp = await fetch(config.url, fetchOpts);
    const text = await resp.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep as raw text
    }
    if (!resp.ok) {
      return { ok: false, status: resp.status, response: parsed, error: `HTTP ${resp.status}` };
    }
    // The MemoryPlus service returns {code, message, data} — non-zero code = logical failure.
    if (parsed && typeof parsed === "object" && "code" in (parsed as Record<string, unknown>)) {
      const code = (parsed as Record<string, unknown>).code;
      const message = (parsed as Record<string, unknown>).message;
      if (typeof code === "number" && code !== 0) {
        return {
          ok: false,
          status: resp.status,
          response: parsed,
          error: typeof message === "string" ? message : `code=${code}`,
        };
      }
    }
    return { ok: true, status: resp.status, response: parsed };
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return {
      ok: false,
      error: isTimeout
        ? `timeout after ${config.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/** Outcome of attempting to report credit, suitable for handler decision-making. */
export interface CreditReportOutcome {
  /** True when we actually issued a network request (path had spaceId and usage was non-empty). */
  attempted: boolean;
  /** True only when `attempted` is true and the report succeeded. */
  ok: boolean;
  /** Detailed error suitable for server-side logs (includes spaceId). */
  errorMessage?: string;
  /** Compact, header-safe error string suitable for `x-credit-report-error`. */
  errorHeader?: string;
  /** Raw report result (only present when attempted=true). */
  result?: CreditReportResult;
  /** Exact billing payload submitted to MemoryPlus. */
  payload?: CreditReportRequest;
}

/**
 * Helper: extract spaceId from path, build payload, call reportCreditUsage,
 * and produce a `CreditReportOutcome` that handlers can map to logs + response
 * headers without duplicating the same 8 lines four times.
 *
 * Caller contract:
 * - If `outcome.attempted === false`: do nothing — request did not target the
 *   credit-reporting route or had no usage to report.
 * - If `outcome.attempted === true && outcome.ok === false`: log
 *   `outcome.errorMessage` and set response header
 *   `x-credit-report-error: outcome.errorHeader`.
 * - On success: nothing further needed.
 */
export async function tryReportCreditFromPath(
  config: CreditReportConfig,
  path: string,
  usage: Record<string, unknown> | null | undefined,
  pricingConfig: CreditPricingConfig | null | undefined,
  modelId?: string,
  upstreamUrl?: string,
  /**
   * Log event kind. When `"analyzer_usage"`, this function short-circuits and
   * never issues a credit report — extension telemetry events are
   * infrastructure consumption and must not be billed to the user's memory space.
   * Defaults to `"usage"` semantically when omitted (backward compatible).
   */
  event?: "usage" | "analyzer_usage",
  requestTime?: Date,
  logContext?: CreditLogContext,
): Promise<CreditReportOutcome> {
  // Defense-in-depth: extension telemetry events must never trigger a credit report.
  // Today the extension telemetry path (writeLog with event="analyzer_usage") does not
  // reach this function, but this guard ensures future refactors cannot
  // accidentally bill extension consumption to the caller's memory space.
  if (event === "analyzer_usage") {
    return { attempted: false, ok: false };
  }

  const spaceId = extractSpaceIdFromPath(path);
  if (!spaceId || !usage || Object.keys(usage).length === 0) {
    return { attempted: false, ok: false };
  }
  const payload: CreditReportRequest = {
    SpaceId: spaceId,
    MemoryLevel: PROXY_MEMORY_LEVEL,
    MemoryDelta: 0,
    CreditDelta: computeCreditDelta(usage, pricingConfig, modelId, upstreamUrl, requestTime, logContext),
  };
  const result = await reportCreditUsage(config, payload);
  log.info("credit.report", {
    ...logIds(logContext),
    spaceId,
    modelId: modelId ?? "unknown",
    upstreamUrl: upstreamUrl ?? "",
    requestTime: (requestTime ?? new Date()).toISOString(),
    payload,
    ok: result.ok,
    status: result.status,
    ...(result.ok ? {} : { error: result.error ?? "unknown" }),
  });
  if (result.ok) {
    return { attempted: true, ok: true, result, payload };
  }
  const errorText = result.error ?? "unknown";
  const errorMessage =
    `spaceId=${spaceId} error=${errorText} resp=${JSON.stringify(result.response ?? null).slice(0, 200)}`;
  const errorHeader = sanitizeHeaderValue(`spaceId=${spaceId}; error=${errorText}`);
  return { attempted: true, ok: false, errorMessage, errorHeader, result, payload };
}

/** Sanitize a string for use as an HTTP header value: strip CR/LF, cap length. */
function sanitizeHeaderValue(s: string): string {
  const cleaned = s.replace(/[\r\n]+/g, " ").trim();
  return cleaned.length > MAX_ERROR_HEADER_LEN
    ? cleaned.slice(0, MAX_ERROR_HEADER_LEN - 3) + "..."
    : cleaned;
}
