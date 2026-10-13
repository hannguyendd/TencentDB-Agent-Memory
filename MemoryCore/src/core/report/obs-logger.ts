/**
 * Core structured logging facade — based on the ILogBackend abstraction
 *
 * Provides info/warn/error methods that automatically correlate the current Trace Context;
 * logs are reported via the ILogBackend backend (internal environment: Zhiyan + ClickHouse).
 *
 * Usage:
 *   import { obsLogger } from "../core/report/obs-logger.js";
 *   obsLogger.error("core.llm.timeout", { instance_id: "xxx", session_id: "yyy" });
 *
 * Does not modify any business code; a pure observability component.
 * No exception affects business startup or service flow.
 * Also writes to the local log file (via FileLogger).
 *
 * The public API signature is unchanged; callers need no modification.
 */

import { FileLogger } from "./file-logger.js";
import { getObservabilityBackend } from "./factory.js";

export type LogAttrs = Record<string, string | number | boolean>;

// initialize the file writer (degradation strategy: initialization failure does not affect the business)
const obsFileLogger = new FileLogger({
  path: process.env.LOG_PATH || "/data/log/",
  filename: "observability.log",
  rotateSizeBytes: 100 * 1024 * 1024, // 100MB
  rotateBackupLimit: 10,
});

/**
 * Observability logging facade.
 * All methods are safe (never throw, never block the business).
 */
export const obsLogger = {
  /**
   * INFO level log — used to record key points of the normal flow.
   */
  info(eventName: string, attrs: LogAttrs = {}): void {
    try {
      getObservabilityBackend().log.info(eventName, attrs);
      // also write to the local log file
      obsFileLogger.write("INFO", eventName, attrs as Record<string, unknown>);
    } catch {
      // silent failure; does not affect the business
    }
  },

  /**
   * WARN level log — used to record recoverable anomalies (such as retries and degradation).
   */
  warn(eventName: string, attrs: LogAttrs = {}): void {
    try {
      getObservabilityBackend().log.warn(eventName, attrs);
      // also write to the local log file
      obsFileLogger.write("WARN", eventName, attrs as Record<string, unknown>);
    } catch {
      // silent failure; does not affect the business
    }
  },

  /**
   * ERROR level log — used to record unrecoverable errors (such as LLM timeouts and VDB write failures).
   */
  error(eventName: string, attrs: LogAttrs = {}, error?: Error): void {
    try {
      if (error) {
        attrs = { ...attrs, "error.message": error.message, "error.type": error.name };
      }
      getObservabilityBackend().log.error(eventName, attrs, error);
      // also write to the local log file
      obsFileLogger.write("ERROR", eventName, attrs as Record<string, unknown>);
    } catch {
      // silent failure; does not affect the business
    }
  },
};
