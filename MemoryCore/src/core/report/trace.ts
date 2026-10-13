/**
 * Trace instrumentation facade — event-as-Span + traditional Start/End
 *
 * Usage:
 *
 *   import { trace } from "./core/report/trace.js";
 *
 *   // event-as-Span (one line, the most common)
 *   trace.report("l1_extraction", {
 *     sessionKey,
 *     memoriesExtracted: extracted.length,
 *     totalDurationMs: Date.now() - startMs,
 *     success: true,
 *     error: null,
 *   });
 *
 *   // traditional Start/End (cross-service call chain scenario)
 *   const span = trace.start("memory.recall");
 *   // ... business logic ...
 *   span.end();
 *
 * This module is a facade layer that internally delegates to ITraceBackend (obtained via the global singleton).
 * The public API signature is unchanged; callers need no modification.
 */

import { getObservabilityBackend } from "./factory.js";
import type { TraceAttrs, ISpan } from "./types.js";

// re-export the Span type from @opentelemetry/api (type only, does not affect runtime)
export type { Span } from "@opentelemetry/api";

export type { TraceAttrs } from "./types.js";

/**
 * Report a business event (event-as-Span).
 *
 * Internally creates a Span, sets each field in attrs as a Span Attribute,
 * sets the Span Status based on the "success" field, then Ends it immediately.
 */
function report(event: string, attrs: TraceAttrs = {}): void {
  try {
    getObservabilityBackend().trace.report(event, attrs);
  } catch {
    // silent failure; does not block the business
  }
}

/**
 * Create a traditional Span (for cross-service call chain scenarios).
 * The caller must call span.end() manually.
 */
function start(spanName: string, kind?: number): ISpan {
  try {
    return getObservabilityBackend().trace.start(spanName, kind);
  } catch {
    return noopSpan;
  }
}

/**
 * Create a SERVER-type Span.
 */
function startServer(spanName: string): ISpan {
  try {
    return getObservabilityBackend().trace.startServer(spanName);
  } catch {
    return noopSpan;
  }
}

/**
 * Create a CLIENT-type Span.
 */
function startClient(spanName: string): ISpan {
  try {
    return getObservabilityBackend().trace.startClient(spanName);
  } catch {
    return noopSpan;
  }
}

/** Noop Span — a safe substitute when the backend is unavailable */
const noopSpan: ISpan = {
  end() {},
  setAttribute() { return this; },
  setAttributes() { return this; },
  setStatus() { return this; },
  recordException() {},
  spanContext() { return { traceId: "", spanId: "", traceFlags: 0 }; },
  isRecording() { return false; },
  updateName() { return this; },
  addEvent() { return this; },
};

export const trace = {
  report,
  start,
  startServer,
  startClient,
};
