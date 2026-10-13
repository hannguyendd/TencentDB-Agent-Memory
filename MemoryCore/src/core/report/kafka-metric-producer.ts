/**
 * Kafka Metric Producer — core component (facade layer)
 *
 * Asynchronously sends monitoring metric messages, handled by the IMetricBackend backend.
 * Internal environment: Kafka → memory-monitor consumes and aggregates, then reports to Barad + ClickHouse.
 * Open-source environment: Noop or Console output.
 *
 * Design notes:
 *   - Sends asynchronously, does not block business requests
 *   - Send failures are silently ignored (no retry, no blocking)
 *   - Does not modify any business code; a pure observability component
 *
 * Usage:
 *   import { metricProducer } from "../core/report/kafka-metric-producer.js";
 *   metricProducer.send({ metric: "l1_extraction_credit_rate", instanceId: "mem-abc", value: 150 });
 *
 * The public API signature is unchanged; callers need no modification.
 */

import { getObservabilityBackend } from "./factory.js";
import type { MetricMessage, MetricBackendConfig } from "./types.js";

// re-export types (keeps backward compatibility)
export type { MetricMessage } from "./types.js";
export type KafkaMetricConfig = MetricBackendConfig;

// ============================
// CRC32 Partition calculation (export retained for use by private modules)
// ============================

import CRC32 from "crc-32";

/**
 * Computes the Partition number using CRC32 IEEE.
 * Gives the same result as the Go side `crc32.ChecksumIEEE([]byte(instanceId)) % totalPartitions`.
 *
 * Note: the crc-32 npm package returns a signed 32-bit integer, which must be converted to unsigned.
 */
export function calculatePartition(instanceId: string, totalPartitions: number): number {
  if (totalPartitions <= 0) return 0;
  // crc-32 returns a signed int32; convert to unsigned uint32
  const checksum = CRC32.str(instanceId) >>> 0;
  return checksum % totalPartitions;
}

// ============================
// Metric Producer facade
// ============================

/**
 * Metric Producer facade.
 *
 * Keeps the same public API as the original KafkaMetricProducer:
 * - send(msg) — send one metric message
 * - initialize(config) — initialize the backend
 * - destroy() — graceful shutdown
 *
 * Internally delegates to IMetricBackend (obtained via the global singleton).
 */
class MetricProducerFacade {
  /**
   * Asynchronously sends one monitoring message.
   * If the backend is not initialized or has been shut down, silently ignored.
   *
   * Automatically injects traceId: extracts the traceId from the current OTel active span,
   * and injects it into the MetricMessage (only when the caller did not pass one manually).
   * On injection failure, silently degrades to an empty string without affecting metric sending.
   */
  send(msg: MetricMessage): void {
    try {
      // automatically inject traceId (not overridden when the caller passes one manually)
      if (msg.traceId === undefined) {
        try {
          const ctx = getObservabilityBackend().tracePropagation.serializeTraceContext();
          msg = { ...msg, traceId: (ctx as Record<string, unknown>)._traceId as string ?? "" };
        } catch {
          msg = { ...msg, traceId: "" };
        }
      }
      getObservabilityBackend().metric.send(msg);
    } catch {
      // silent failure
    }
  }

  /**
   * Initialize the Metric backend.
   * The actual initialization is done uniformly by initObservabilityBackend(),
   * this method is retained for backward compatibility.
   */
  async initialize(config: MetricBackendConfig): Promise<void> {
    try {
      await getObservabilityBackend().metric.initialize(config);
    } catch {
      // silent failure
    }
  }

  /**
   * Graceful shutdown.
   */
  async destroy(): Promise<void> {
    try {
      await getObservabilityBackend().metric.destroy();
    } catch {
      // silent failure
    }
  }
}

/** Global singleton */
export const metricProducer = new MetricProducerFacade();