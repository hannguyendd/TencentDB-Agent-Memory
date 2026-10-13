/**
 * L2 Scene Extraction Metric Reporter — reports L2 scene extraction metrics.
 *
 * After L2 scene extraction completes, non-intrusively reports the following metrics to Kafka:
 *   - l2_extraction_latency_ms  : total end-to-end L2 scene extraction time (ms)
 *   - l2_llm_duration_ms       : L2 LLM call duration (ms)
 *   - l2_scene_count_before    : scene count before extraction
 *   - l2_scene_count_after     : scene count after extraction
 *   - l2_scenes_created        : number of scenes created in this run
 *   - l2_scenes_updated        : number of scenes updated in this run
 *   - l2_scenes_deleted        : number of scenes deleted in this run
 *
 * Trace correlation notes:
 *   All metrics automatically inject the traceId of the current active span via metricProducer.send().
 *   L2 runs inside TracedTaskExecutor.executeL2() → withSpan("core.l2.extraction"),
 *   whose child spans include the ai.generateText / gen_ai.chat spans automatically produced by the Vercel AI SDK,
 *   carrying the gen_ai.request.model attribute. Via the traceId you can look up:
 *     - which model was used
 *     - LLM request/response details
 *     - the time of each step in the entire L2 extraction chain
 *
 * Design principles:
 *   1. After extraction completes, report inside try-catch (silent failure)
 *   2. Whether reporting succeeds or fails, the extraction result is unaffected
 *   3. Do not report when extraction fails (hasError=true)
 *   4. Do not report when there is no instanceId
 *   5. llmDurationMs being null means there is no LLM call timing; do not report l2_llm_duration_ms
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Input Interface
// ============================

export interface L2LatencyMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** Total end-to-end L2 scene extraction time (ms) */
  extractionLatencyMs: number;
  /** LLM call duration (ms). null means there is no LLM call timing */
  llmDurationMs: number | null;
  /** Scene count before extraction */
  sceneCountBefore: number;
  /** Scene count after extraction */
  sceneCountAfter: number;
  /** Number of scenes created in this run */
  scenesCreated: number;
  /** Number of scenes updated in this run */
  scenesUpdated: number;
  /** Number of scenes deleted in this run */
  scenesDeleted: number;
  /** Whether extraction failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Reports L2 scene extraction metrics to Kafka.
 *
 * Silent-safe: any exception is swallowed by try-catch and never thrown outward.
 */
export function reportL2LatencyMetrics(input: L2LatencyMetricInput): void {
  try {
    // Guard: do not report on failure
    if (input.hasError) return;

    // Guard: do not report without instanceId
    if (!input.instanceId) return;

    // 1. report l2_extraction_latency_ms
    try {
      metricProducer.send({
        metric: "l2_extraction_latency_ms",
        instanceId: input.instanceId,
        value: Math.round(input.extractionLatencyMs),
        source: "core",
      });
    } catch {
      // silent failure
    }

    // 2. report l2_llm_duration_ms (only when LLM timing is available)
    if (input.llmDurationMs !== null) {
      try {
        metricProducer.send({
          metric: "l2_llm_duration_ms",
          instanceId: input.instanceId,
          value: Math.round(input.llmDurationMs),
          source: "core",
        });
      } catch {
        // silent failure
      }
    }

    // 3. report l2_scene_count_before
    try {
      metricProducer.send({
        metric: "l2_scene_count_before",
        instanceId: input.instanceId,
        value: input.sceneCountBefore,
        source: "core",
      });
    } catch {
      // silent failure
    }

    // 4. report l2_scene_count_after
    try {
      metricProducer.send({
        metric: "l2_scene_count_after",
        instanceId: input.instanceId,
        value: input.sceneCountAfter,
        source: "core",
      });
    } catch {
      // silent failure
    }

    // 5. report l2_scenes_created
    try {
      metricProducer.send({
        metric: "l2_scenes_created",
        instanceId: input.instanceId,
        value: input.scenesCreated,
        source: "core",
      });
    } catch {
      // silent failure
    }

    // 6. report l2_scenes_updated
    try {
      metricProducer.send({
        metric: "l2_scenes_updated",
        instanceId: input.instanceId,
        value: input.scenesUpdated,
        source: "core",
      });
    } catch {
      // silent failure
    }

    // 7. report l2_scenes_deleted
    try {
      metricProducer.send({
        metric: "l2_scenes_deleted",
        instanceId: input.instanceId,
        value: input.scenesDeleted,
        source: "core",
      });
    } catch {
      // silent failure
    }
  } catch {
    // outermost catch — never throw outward
  }
}
