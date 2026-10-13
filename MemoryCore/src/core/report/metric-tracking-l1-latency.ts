/**
 * L1 Latency Metric Reporter — reports L1 extraction-phase latency metrics.
 *
 * After L1 extraction completes, non-intrusively reports the following metrics to Kafka:
 *   - l1_extraction_latency_ms : total end-to-end L1 extraction time (ms)
 *   - l1_dedup_latency_ms     : dedup phase time (ms)
 *
 * Design principles (fully isomorphic with metric-tracking-recall):
 *   1. After extraction completes, report inside try-catch (silent failure)
 *   2. Whether reporting succeeds or fails, the extraction result is unaffected
 *   3. Do not report when extraction fails (hasError=true)
 *   4. Do not report when there is no instanceId
 *   5. dedupLatencyMs being null means the dedup path was not taken; do not report the dedup metric
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Input Interface
// ============================

export interface L1LatencyMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** Total end-to-end L1 extraction time (ms) */
  extractionLatencyMs: number;
  /** Dedup phase time (ms). null means the dedup path was not taken */
  dedupLatencyMs: number | null;
  /** Whether extraction failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Reports L1 extraction-phase latency metrics to Kafka.
 *
 * Silent-safe: any exception is swallowed by try-catch and never thrown outward.
 */
export function reportL1LatencyMetrics(input: L1LatencyMetricInput): void {
  try {
    // Guard: do not report on failure
    if (input.hasError) return;

    // Guard: do not report without instanceId
    if (!input.instanceId) return;

    // 1. report l1_extraction_latency_ms
    try {
      metricProducer.send({
        metric: "l1_extraction_latency_ms",
        instanceId: input.instanceId,
        value: Math.round(input.extractionLatencyMs),
        source: "core",
      });
    } catch {
      // silent failure
    }

    // 2. report l1_dedup_latency_ms (only when the dedup path was taken)
    if (input.dedupLatencyMs !== null) {
      try {
        metricProducer.send({
          metric: "l1_dedup_latency_ms",
          instanceId: input.instanceId,
          value: Math.round(input.dedupLatencyMs),
          source: "core",
        });
      } catch {
        // silent failure
      }
    }
  } catch {
    // outermost catch — never throw outward
  }
}
