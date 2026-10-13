/**
 * Trace Context propagation utilities across async boundaries (facade layer)
 *
 * Used to serialize/deserialize the OTel Trace Context in async tasks,
 * achieving cross-async correlation from an HTTP request → Pipeline Worker.
 *
 * Usage:
 *   // on enqueue: serialize the current Trace Context into TaskPayload.data
 *   const traceCtx = serializeTraceContext();
 *   task.data = { ...task.data, ...traceCtx };
 *
 *   // on consume: deserialize and restore the Trace Context from TaskPayload.data
 *   const parentCtx = deserializeTraceContext(task.data);
 *   // create a CONSUMER Span in parentCtx
 *
 * The public API signature is unchanged; callers need no modification.
 */

import { getObservabilityBackend } from "./factory.js";

/**
 * Serialize the current Trace Context into a plain object.
 * The returned object can be spread directly into TaskPayload.data.
 *
 * If there is currently no valid Span Context, returns an empty object.
 */
export function serializeTraceContext(): Record<string, string | number> {
  try {
    return getObservabilityBackend().tracePropagation.serializeTraceContext();
  } catch {
    return {};
  }
}

/**
 * Deserialize and restore the Trace Context from TaskPayload.data.
 *
 * Returns an OTel Context that can be used to create a CONSUMER Span with a follow-from link.
 * If data has no trace information, returns ROOT_CONTEXT.
 */
export function deserializeTraceContext(
  data?: Record<string, unknown>,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): { parentContext: any; parentSpanContext: any | null } {
  try {
    return getObservabilityBackend().tracePropagation.deserializeTraceContext(data);
  } catch {
    return { parentContext: {}, parentSpanContext: null };
  }
}
