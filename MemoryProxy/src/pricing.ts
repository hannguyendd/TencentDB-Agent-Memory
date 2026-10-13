/**
 * Credit pricing lookup for LLM usage → cost calculation.
 *
 * Billing rules issued by TDAI are in units of Credit / 1K Tokens, priced separately per token type
 * (input / output / cacheRead / cacheWrite5m / cacheWrite1h).
 * The pricing table lives in `creditPricing.models` in config.yaml and supports hot reload.
 *
 * Matching rule (`getModelPricing`):
 *   Case-insensitive whole-word match -- modelId and config.name must be exactly equal ignoring case.
 *   Returns null when unmatched; the caller degrades to the raw token count.
 */

import type {
  CreditPricingConfig,
  CreditPricingEntry,
  PricingRule,
  PricingWeekday,
  TieredPricing,
} from "./types.js";

/**
 * Look up model pricing by case-insensitive full-word match.
 *
 * @param config - Credit pricing configuration (from config.yaml).
 * @param modelId - Model identifier (usually the `model` field from usage).
 * @returns Matched pricing entry, or `null` if no match.
 */
export function getModelPricing(
  config: CreditPricingConfig | null | undefined,
  modelId: string | null | undefined,
): CreditPricingEntry | null {
  if (!config?.models?.length || !modelId) return null;

  const lower = modelId.toLowerCase();
  return config.models.find((m) => m.name.toLowerCase() === lower) ?? null;
}

/**
 * Resolve the model's display name (for UI/reports).
 *
 * Matching logic:
 * 1. `modelId` empty/null/undefined → return `""`
 * 2. Pricing table hit and entry.modelName non-empty → return entry.modelName (e.g. "Claude Sonnet 4")
 * 3. Pricing table miss, or hit but modelName not configured/empty → **fall back to modelId itself**
 *    (the frontend always has a non-empty display; for an unknown model at least the internal ID is visible)
 *
 * Shares the same matching logic as `getModelPricing` (case-insensitive whole-word match).
 *
 * @param config - Credit pricing configuration.
 * @param modelId - Model identifier from usage.
 * @returns Display name string (never null, may be "").
 */
export function resolveModelName(
  config: CreditPricingConfig | null | undefined,
  modelId: string | null | undefined,
): string {
  if (!modelId) return "";
  const entry = getModelPricing(config, modelId);
  return entry?.modelName || modelId;
}

/** Normalizes a client-facing model name for comparison without changing its display casing. */
export function normalizePublicModelName(modelName: string | null | undefined): string {
  return modelName?.trim().toLowerCase() ?? "";
}

/**
 * Reverse resolution: translate the client-side display name (`modelName`) back to the real `model_id` (`entry.name`).
 *
 * Client display names and price-table display names are both matched with leading/trailing whitespace trimmed and case-insensitively; this is consistent with the IDs
 * returned by `/v1/models`, ensuring discovered models can be called directly.
 */
export function resolveModelId(
  config: CreditPricingConfig | null | undefined,
  requested: string | null | undefined,
): string {
  if (!requested) return requested ?? "";
  if (!config?.models?.length) return requested;

  const normalizedRequested = normalizePublicModelName(requested);
  if (!normalizedRequested) return requested;
  const entry = config.models.find((m) => {
    const normalizedModelName = normalizePublicModelName(m.modelName);
    return !!normalizedModelName && normalizedModelName === normalizedRequested;
  });
  return entry?.name || requested;
}

/**
 * Validate that the client request's `model` is registered in the price table's **`modelName` (display name)**.
 *
 * Used as the gate at the request entry: when a price table is configured, clients may only request using the display name (`modelName`);
 * the real `model_id` (`entry.name`) is treated as an internal detail and is no longer a public entry point.
 * Any unmatched model is rejected, avoiding the silent under-billing problem of "forwarded successfully but cannot be billed".
 *
 * Rules:
 * 1. `config` / `config.models` empty → **return true** (skip validation when the price table is not configured,
 *    backward compatible with old deployments; `computeCreditDelta` handles it via the raw tracing path).
 * 2. `requested` empty/null/undefined → **return false** (the model must be provided explicitly to be let through).
 * 3. Hits any entry's **non-empty** `modelName` (case-insensitive whole-word match) → true.
 * 4. Otherwise → false.
 *
 * Note: entries without `modelName` cannot be hit by client requests (such a model is "internal only",
 * used only for internal forwarding and not exposed to clients).
 *
 * @param config - Credit pricing configuration.
 * @param requested - Value of the `model` field in the client request.
 * @returns Whether to let it through.
 */
export function isModelInPricing(
  config: CreditPricingConfig | null | undefined,
  requested: string | null | undefined,
): boolean {
  // Price table not configured: skip validation (backward compatible)
  if (!config?.models?.length) return true;
  // Explicitly require a non-empty model
  if (!requested) return false;

  const normalizedRequested = normalizePublicModelName(requested);
  if (!normalizedRequested) return false;
  return config.models.some((m) => {
    const normalizedModelName = normalizePublicModelName(m.modelName);
    return !!normalizedModelName && normalizedModelName === normalizedRequested;
  });
}

/** Pricing rates used for credit calculation (subset of PricingTier). */
export interface EffectivePricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Billing rules are defined in Beijing time and must not be configurable. */
const BEIJING_TIMEZONE = "Asia/Shanghai";
const WEEKDAY_BY_SHORT_NAME: Record<string, PricingWeekday> = {
  Sun: "sun",
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
};

/**
 * Select the time-based rule that applies to this request.
 *
 * Rules are evaluated by descending priority; ties preserve YAML order. If no
 * rule matches (or no rules are configured), the entry's legacy top-level
 * pricing is used, preserving all existing configurations.
 */
export function resolveRulePricing(
  config: CreditPricingConfig | null | undefined,
  entry: CreditPricingEntry,
  requestTime: Date = new Date(),
): TieredPricing {
  return resolveRulePricingDetail(config, entry, requestTime).pricing;
}

export interface ResolvedRulePricing {
  pricing: TieredPricing;
  ruleId?: string;
  timezone: string;
}

/** Select a time rule and retain its audit metadata. */
export function resolveRulePricingDetail(
  _config: CreditPricingConfig | null | undefined,
  entry: CreditPricingEntry,
  requestTime: Date = new Date(),
): ResolvedRulePricing {
  const timezone = BEIJING_TIMEZONE;
  if (!entry.rules?.length) return { pricing: entry, timezone };

  const localTime = getLocalPricingTime(requestTime);
  const matchingRule = entry.rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => (b.rule.priority ?? 0) - (a.rule.priority ?? 0) || a.index - b.index)
    .find(({ rule }) => ruleMatches(rule, localTime));

  return matchingRule
    ? { pricing: matchingRule.rule.pricing, ruleId: matchingRule.rule.id, timezone }
    : { pricing: entry, timezone };
}

function getLocalPricingTime(requestTime: Date): { weekday: PricingWeekday; minuteOfDay: number } {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: BEIJING_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = format.formatToParts(requestTime);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_BY_SHORT_NAME[values.weekday] ?? "sun";
  return {
    weekday,
    minuteOfDay: Number(values.hour ?? 0) * 60 + Number(values.minute ?? 0),
  };
}

function ruleMatches(rule: PricingRule, localTime: { weekday: PricingWeekday; minuteOfDay: number }): boolean {
  const when = rule.when;
  if (!when) return true;
  if (when.weekdays?.length && !when.weekdays.includes(localTime.weekday)) return false;
  if (!when.timeRanges?.length) return true;
  return when.timeRanges.some((range) => {
    const start = parseTime(range.start);
    const end = parseTime(range.end);
    if (start === null || end === null || start === end) return false;
    return start < end
      ? localTime.minuteOfDay >= start && localTime.minuteOfDay < end
      : localTime.minuteOfDay >= start || localTime.minuteOfDay < end;
  });
}

function parseTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Select the effective pricing tier by total input tokens.
 *
 * Matching rule: iterate `entry.tiers` in ascending order; the first one satisfying
 * `totalInputTokens ≤ tier.maxInputTokens` (or `maxInputTokens == null`) hits.
 * Once hit, **all token types** of the request are billed at that tier's unit price (tiered as a whole, not progressive).
 *
 * With no `tiers` or an empty array, return the entry's top-level unit price directly (backward compatible).
 *
 * @param entry - The matched model pricing entry.
 * @param totalInputTokens - Tier criterion = nonCacheInput + cacheRead.
 */
export function resolveTierPricing(
  entry: TieredPricing,
  totalInputTokens: number,
): EffectivePricing {
  if (!entry.tiers?.length) return entry;

  for (const tier of entry.tiers) {
    if (tier.maxInputTokens == null || totalInputTokens <= tier.maxInputTokens) {
      return tier;
    }
  }
  // No tier matched (in theory impossible, the last tier should be null) → fall back to the top level
  return entry;
}
