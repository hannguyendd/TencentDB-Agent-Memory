/**
 * Log structured logging facade — Debug/Info/Warn/Error
 *
 * Usage:
 *
 *   import { log } from "./core/report/log.js";
 *
 *   log.info("recall completed", { count: 10, latencyMs: 42 });
 *   log.error("embedding failed", { provider: "zhipu", error: err.message });
 *
 * Structured logs are sent via ILogBackend (internal environment: OTel Logs API → Zhiyan + ClickHouse).
 * Automatically correlates the current Trace context (logs written inside a Span automatically carry TraceID/SpanID).
 * Also writes to the local log file (via FileLogger).
 * If the backend is not initialized, falls back to file + console.
 *
 * The public API signature is unchanged; callers need no modification.
 */

import { FileLogger } from "./file-logger.js";
import { getObservabilityBackend } from "./factory.js";

// initialize the file writer (degradation strategy: initialization failure does not affect the business)
const fileLogger = new FileLogger({
  path: process.env.LOG_PATH || "/data/log/",
  filename: "core.log",
  rotateSizeBytes: 100 * 1024 * 1024, // 100MB
  rotateBackupLimit: 10,
});

/**
 * Send one structured log entry.
 * Reported via ILogBackend, and also written to the local file.
 */
function emit(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, data?: Record<string, unknown>): void {
  try {
    // build attributes (accept primitive types only)
    const attrs: Record<string, string | number | boolean> = {};
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          attrs[key] = value;
        }
      }
    }

    // report via ILogBackend
    const backend = getObservabilityBackend().log;
    switch (level) {
      case "DEBUG":
        backend.debug?.(message, attrs);
        break;
      case "INFO":
        backend.info(message, attrs);
        break;
      case "WARN":
        backend.warn(message, attrs);
        break;
      case "ERROR":
        backend.error(message, attrs);
        break;
    }

    // also write to the local log file (regardless of whether the backend is available)
    fileLogger.write(level, message, data);
  } catch {
    // do not block the business
  }
}

export const log = {
  debug(message: string, data?: Record<string, unknown>): void {
    emit("DEBUG", message, data);
  },

  info(message: string, data?: Record<string, unknown>): void {
    emit("INFO", message, data);
  },

  warn(message: string, data?: Record<string, unknown>): void {
    emit("WARN", message, data);
  },

  error(message: string, data?: Record<string, unknown>): void {
    emit("ERROR", message, data);
  },
};
