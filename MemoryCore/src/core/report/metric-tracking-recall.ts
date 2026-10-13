/**
 * Recall Metric Reporter — reports recall-phase metrics.
 *
 * After recall completes, non-intrusively reports the following metrics to Kafka:
 *   - recall_hit_count   : number of L1 memories hit in this recall
 *   - recall_top_score   : highest similarity score in the recall results (TCVDB RRF score)
 *   - recall_latency_ms  : total recall time (ms, integer)
 *
 * Design principles (fully isomorphic with MetricTrackingRunner):
 *   1. After recall completes, report inside try-catch (silent failure)
 *   2. Whether reporting succeeds or fails, the recall result is unaffected
 *   3. Do not report when recall fails (hasError=true)
 *   4. Do not report when there is no instanceId
 *   5. When 0 results are recalled, still report hit_count=0 + latency, but not top_score
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Strategy Encoding (numeric for ClickHouse storage)
// ============================

const STRATEGY_CODE: Record<string, number> = {
  skipped: 0,
  keyword: 1,
  embedding: 2,
  hybrid: 3,
};

// ============================
// Input Interface
// ============================

export interface RecallMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** List of recalled L1 memories (with score) */
  recalledL1Memories: Array<{ content: string; score: number; type: string }> | undefined;
  /** Effective recall strategy */
  recallStrategy: string;
  /** Total recall time (ms) */
  recallLatencyMs: number;
  /** Whether recall failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Reports recall-phase metrics to Kafka.
 *
 * Silent-safe: any exception is swallowed by try-catch and never thrown outward.
 * Call timing: after performAutoRecallCore returns and before the result is passed to the business.
 */
export function reportRecallMetrics(input: RecallMetricInput): void {
  try {
    // Guard: do not report on failure
    if (input.hasError) return;

    // Guard: do not report without instanceId
    if (!input.instanceId) return;

    const memories = input.recalledL1Memories ?? [];
    const hitCount = memories.length;
    const latencyMs = Math.round(input.recallLatencyMs);

    // 1. report recall_hit_count (including the 0-result case)
    try {
      metricProducer.send({
        metric: "recall_hit_count",
        instanceId: input.instanceId,
        value: hitCount,
        source: "core",
      });
    } catch {
      // silent failure
    }

    // 2. report recall_top_score (only when there are memories)
    if (hitCount > 0) {
      try {
        const topScore = Math.max(...memories.map((m) => m.score));
        metricProducer.send({
          metric: "recall_top_score",
          instanceId: input.instanceId,
          value: topScore,
          source: "core",
        });
      } catch {
        // silent failure
      }
    }

    // 3. report recall_latency_ms
    try {
      metricProducer.send({
        metric: "recall_latency_ms",
        instanceId: input.instanceId,
        value: latencyMs,
        source: "core",
      });
    } catch {
      // silent failure
    }

    // 4. report recall_strategy (numeric encoding: skipped=0, keyword=1, embedding=2, hybrid=3, unknown=-1)
    try {
      const strategyCode = STRATEGY_CODE[input.recallStrategy] ?? -1;
      metricProducer.send({
        metric: "recall_strategy",
        instanceId: input.instanceId,
        value: strategyCode,
        source: "core",
      });
    } catch {
      // silent failure
    }
  } catch {
    // outermost catch — never throw outward
  }
}
