/**
 * MetricTrackingRunner / MetricTrackingRunnerFactory — LLMRunner decorator,
 * non-intrusively reports credit consumption to Kafka after an LLM call completes.
 *
 * Design principles (fully isomorphic with MetricTrackingStore):
 *   1. Run the original method first and get the result
 *   2. After the original method succeeds, report inside try-catch (silent failure)
 *   3. Whether reporting succeeds or fails, always return the original method's result
 *   4. If the original method throws, re-throw directly without any reporting
 *   5. Does not change the LLMRunner / LLMRunnerFactory interface signatures
 *
 * taskId → metric name mapping:
 *   - "l1-extraction"        → "l1_extraction_credit_rate"
 *   - "l1-conflict-detection" → "l1_dedup_credit_rate"
 *   - "scene-extract-*"      → "l2_extraction_credit_rate"
 *   - "persona-generation"   → "l3_generation_credit_rate"
 *
 * Token usage acquisition strategy:
 *   - Prefer reading exact values (distinguishing input/output) from the inner runner's lastUsage side-channel
 *   - If unavailable (OpenClaw path), estimate from character length
 *
 * Credit calculation (done on the Producer side; the Consumer side only divides by the window period to get a rate):
 *   Formula: Credit = (input_tokens/10000 × INPUT_RATE + output_tokens/10000 × OUTPUT_RATE) × multiplier
 *   1 Credit = 10000 standard Input Tokens (anchored on M2.7)
 *   Base rates:
 *     - INPUT_RATE  = 1.0 Credit / 10k tokens
 *     - CACHE_RATE  = 0.2 Credit / 10k tokens (phase 1 does not distinguish cache; everything is counted as input)
 *     - OUTPUT_RATE = 4.0 Credit / 10k tokens
 *   Model coefficients: M2.7 = 1.0, flagship = 15.0, high-speed = 0.8 (phase 1 default 1.0)
 *   Degradation strategy: when input/output cannot be distinguished, conservatively estimate everything at the input rate (1.0)
 */

import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
} from "../types.js";
import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// taskId → metric name mapping
// ============================

/** Token usage info of the LLM Runner (side-channel) */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** LLMRunner with a lastUsage side-channel (optional extension) */
export interface LLMRunnerWithUsage extends LLMRunner {
  lastUsage?: LLMUsage;
}

/**
 * Map a taskId to a Kafka metric name.
 * Returns undefined if the taskId does not need credit reporting.
 */
export function taskIdToMetricName(taskId: string): string | undefined {
  if (taskId === "l1-extraction") return "l1_extraction_credit_rate";
  if (taskId === "l1-conflict-detection") return "l1_dedup_credit_rate";
  if (taskId.startsWith("scene-extract")) return "l2_extraction_credit_rate";
  if (taskId === "persona-generation") return "l3_generation_credit_rate";
  return undefined;
}

/**
 * Map a taskId to an eval token metric prefix.
 * Returns undefined if the taskId does not need per-stage token reporting.
 *
 * Example output metric names:
 *   l1_extraction_input_tokens / l1_extraction_output_tokens
 *   l1_dedup_input_tokens / l1_dedup_output_tokens
 *   l2_extraction_input_tokens / l2_extraction_output_tokens
 *   l3_generation_input_tokens / l3_generation_output_tokens
 */
export function taskIdToTokenMetricPrefix(taskId: string): string | undefined {
  if (taskId === "l1-extraction") return "l1_extraction";
  if (taskId === "l1-conflict-detection") return "l1_dedup";
  if (taskId.startsWith("scene-extract")) return "l2_extraction";
  if (taskId === "persona-generation") return "l3_generation";
  return undefined;
}

// ============================
// Credit calculation constants and functions
// ============================

/** Token base per 1 Credit (10000 tokens = 1 Credit) */
export const TOKENS_PER_CREDIT = 10000;
/** Base rate: standard input 1.0 Credit / 10k tokens (M2.7 anchor) */
export const INPUT_RATE = 1.0;
/** Base rate: cached input 0.2 Credit / 10k tokens (phase 1 does not distinguish cache; everything is counted as input) */
export const CACHE_RATE = 0.2;
/** Base rate: model output 4.0 Credit / 10k tokens */
export const OUTPUT_RATE = 4.0;
/** Default model coefficient (M2.7 standard) */
export const DEFAULT_MULTIPLIER = 1.0;

/**
 * Round a Credit value to 5 decimal places.
 * All reporting uses this function uniformly to keep precision consistent.
 */
export function roundCredit(value: number): number {
  return Math.round(value * 100000) / 100000;
}

/**
 * Map a taskId to a memory level (for usage reporting).
 * Returns undefined if the taskId does not need reporting.
 */
export function taskIdToLevel(taskId: string): "L1" | "L2" | "L3" | undefined {
  if (taskId === "l1-extraction" || taskId === "l1-conflict-detection") return "L1";
  if (taskId.startsWith("scene-extract")) return "L2";
  if (taskId === "persona-generation") return "L3";
  return undefined;
}

/** onCreditConsumed callback parameters */
export interface CreditConsumedEvent {
  instanceId: string;
  credit: number;
  level: "L1" | "L2" | "L3";
  taskId: string;
}

/** onCreditConsumed callback type */
export type OnCreditConsumed = (event: CreditConsumedEvent) => void;

/**
 * Compute the Credit value from exact input/output token counts.
 * Formula: Credit = (input/10000 × INPUT_RATE + output/10000 × OUTPUT_RATE) × multiplier
 *
 * 1 Credit = 10000 standard Input Tokens.
 * Phase 1 simplification: does not distinguish cache tokens; everything is computed at the input rate.
 * To be refined once the LLM SDK supports returning cache-hit counts.
 */
export function computeCredit(
  inputTokens: number,
  outputTokens: number,
  multiplier: number = DEFAULT_MULTIPLIER,
): number {
  return ((inputTokens / TOKENS_PER_CREDIT) * INPUT_RATE + (outputTokens / TOKENS_PER_CREDIT) * OUTPUT_RATE) * multiplier;
}

/**
 * Roughly estimate the token count from character length, then compute the Credit.
 * English is about 4 chars/token, Chinese about 2 chars/token; a compromise of 3 chars/token is used.
 *
 * Degradation strategy: when input/output cannot be distinguished, conservatively estimate everything at the input rate (1.0).
 * Formula: Credit = estimatedTotalTokens / 10000 × INPUT_RATE × multiplier
 */
export function estimateCreditFromChars(
  inputCharLength: number,
  outputCharLength: number,
  multiplier: number = DEFAULT_MULTIPLIER,
): number {
  const estimatedTokens = Math.ceil((inputCharLength + outputCharLength) / 3);
  return (estimatedTokens / TOKENS_PER_CREDIT) * INPUT_RATE * multiplier;
}

// ============================
// MetricTrackingRunner (decorator)
// ============================

/**
 * Wraps an LLMRunner and asynchronously reports credit consumption to Kafka after run() completes.
 *
 * The reported value is the **Credit value** (Token → Credit conversion already done),
 * so the Consumer side only needs to divide by the window period to get a rate, with no further Token → Credit conversion.
 *
 * Safety guarantees:
 *   - Reporting failures are silently ignored and never affect run()'s return value
 *   - No reporting when the original method throws; the exception propagates normally
 *   - Does not change run()'s signature or return value
 */
export class MetricTrackingRunner implements LLMRunner {
  private readonly inner: LLMRunner;
  private readonly getInstanceId: () => string | undefined;
  private readonly multiplier: number;
  private readonly onCreditConsumed?: OnCreditConsumed;

  /** Accumulated credit consumed across all run() calls on this runner instance. */
  accumulatedCredit = 0;

  constructor(
    inner: LLMRunner,
    getInstanceId: () => string | undefined,
    multiplier: number = DEFAULT_MULTIPLIER,
    onCreditConsumed?: OnCreditConsumed,
  ) {
    this.inner = inner;
    this.getInstanceId = getInstanceId;
    this.multiplier = multiplier;
    this.onCreditConsumed = onCreditConsumed;
  }

  async run(params: LLMRunParams): Promise<string> {
    // 0. Inject instanceId (if the caller did not pass one, obtain it from the getInstanceId callback)
    const enrichedParams = params.instanceId
      ? params
      : { ...params, instanceId: this.getInstanceId() };

    // 1. Run the original method first and get the result (exceptions are re-thrown directly)
    const text = await this.inner.run(enrichedParams);

    // 2. After the original method succeeds, report inside try-catch (silent failure)
    try {
      const metricName = taskIdToMetricName(params.taskId);
      if (metricName) {
        const instanceId = enrichedParams.instanceId ?? this.getInstanceId();
        if (instanceId) {
          // Prefer reading the exact token count from the inner runner's lastUsage side-channel
          const innerWithUsage = this.inner as LLMRunnerWithUsage;
          let creditValue: number;
          let inputTokens: number;
          let outputTokens: number;

          if (innerWithUsage.lastUsage && innerWithUsage.lastUsage.totalTokens > 0) {
            inputTokens = innerWithUsage.lastUsage.promptTokens;
            outputTokens = innerWithUsage.lastUsage.completionTokens;
            creditValue = computeCredit(inputTokens, outputTokens, this.multiplier);
          } else {
            // When there is no exact token count, estimate from character length
            const inputChars = (params.prompt?.length ?? 0) + (params.systemPrompt?.length ?? 0);
            const outputChars = text.length;
            inputTokens = Math.ceil(inputChars / 3);
            outputTokens = Math.ceil(outputChars / 3);
            creditValue = estimateCreditFromChars(inputChars, outputChars, this.multiplier);
          }

          // Uniformly round to 5 decimal places (all reporting uses the same data)
          const roundedCredit = roundCredit(creditValue);

          // Accumulate credit for caller to read
          this.accumulatedCredit += roundedCredit;

          if (roundedCredit > 0) {
            // Report the aggregate metric (5 decimal places, silent failure)
            try {
              metricProducer.send({
                metric: metricName,
                instanceId,
                value: roundedCredit,
                source: "core",
              });
            } catch {
              // Metric send failures are silently ignored
            }

            // Report the usage callback (also 5 decimal places, silent failure)
            if (this.onCreditConsumed) {
              const level = taskIdToLevel(params.taskId);
              if (level) {
                try {
                  this.onCreditConsumed({
                    instanceId,
                    credit: roundedCredit,
                    level,
                    taskId: params.taskId,
                  });
                } catch {
                  // Silent failure; never affects the business
                }
              }
            }
          }

          // Report raw Token metrics (for the aggregation side to compute TPM)
          // Only metrics > 0 are reported; silent failure
          try {
            if (inputTokens > 0) {
              metricProducer.send({
                metric: "llm_input_tokens",
                instanceId,
                value: inputTokens,
                source: "core",
              });
            }
            if (outputTokens > 0) {
              metricProducer.send({
                metric: "llm_output_tokens",
                instanceId,
                value: outputTokens,
                source: "core",
              });
            }
          } catch {
            // Token metric report failures are silently ignored; never affect the business
          }

          // Report per-stage Token metrics (for evaluation, with traceId)
          try {
            const tokenPrefix = taskIdToTokenMetricPrefix(params.taskId);
            if (tokenPrefix && inputTokens > 0) {
              metricProducer.send({
                metric: `${tokenPrefix}_input_tokens`,
                instanceId,
                value: inputTokens,
                source: "core",
              });
            }
            if (tokenPrefix && outputTokens > 0) {
              metricProducer.send({
                metric: `${tokenPrefix}_output_tokens`,
                instanceId,
                value: outputTokens,
                source: "core",
              });
            }
          } catch {
            // silent failure
          }
        }
      }
    } catch {
      // Silent failure; never affects the business
    }

    // 3. Whether reporting succeeds or fails, return the original method's result
    return text;
  }
}

// ============================
// MetricTrackingRunnerFactory (decorator)
// ============================

/**
 * Wraps an LLMRunnerFactory so that the Runners it creates come with credit reporting built in.
 *
 * Injection point: wrap the factory in wirePipelineRunners() in tdai-core.ts.
 * This is the only "change" — it is the injection point of observability code, not a modification of business logic.
 *
 * @param multiplier model coefficient (default 1.0 = M2.7 standard).
 *   Can later be read from configuration to support dynamic multi-model switching.
 */
export class MetricTrackingRunnerFactory implements LLMRunnerFactory {
  private readonly inner: LLMRunnerFactory;
  private readonly getInstanceId: () => string | undefined;
  private readonly multiplier: number;
  private readonly onCreditConsumed?: OnCreditConsumed;

  constructor(
    inner: LLMRunnerFactory,
    getInstanceId: () => string | undefined,
    multiplier: number = DEFAULT_MULTIPLIER,
    onCreditConsumed?: OnCreditConsumed,
  ) {
    this.inner = inner;
    this.getInstanceId = getInstanceId;
    this.multiplier = multiplier;
    this.onCreditConsumed = onCreditConsumed;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const innerRunner = this.inner.createRunner(opts);
    return new MetricTrackingRunner(innerRunner, this.getInstanceId, this.multiplier, this.onCreditConsumed);
  }
}
