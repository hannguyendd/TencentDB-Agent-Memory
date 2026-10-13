/**
 * Core HTTP Trace middleware — non-intrusive Trace instrumentation (facade layer)
 *
 * Creates a SERVER-type entry Span (core.request) for each HTTP request,
 * restoring the upstream Trace Context from the traceparent header to achieve cross-service correlation.
 *
 * Usage (in server.ts):
 *   import { wrapWithTrace } from "../core/report/trace-middleware.js";
 *   // wrap handleRequest when creating the server
 *   this.server = http.createServer((req, res) => wrapWithTrace(req, res, () => this.handleRequest(req, res)));
 *
 * Does not modify any business code; a pure observability component.
 * The public API signature is unchanged; callers need no modification.
 */

import http from "node:http";
import { getObservabilityBackend } from "./factory.js";
import type { ISpan } from "./types.js";

// re-export the Span type (keeps backward compatibility)
export type { Span } from "@opentelemetry/api";

/**
 * Wrap the HTTP request handler and add Trace instrumentation.
 *
 * @param req HTTP request
 * @param res HTTP response
 * @param handler the original request handler
 */
export async function wrapWithTrace(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: () => Promise<void>,
): Promise<void> {
  try {
    return await getObservabilityBackend().traceMiddleware.wrapWithTrace(req, res, handler);
  } catch (err) {
    // if the exception was thrown by the handler itself, it must be re-thrown
    throw err;
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

/**
 * Create a child Span (for creating finer-grained Spans inside a business handler).
 *
 * @param name Span name (e.g. "core.vdb.write")
 * @param attrs Span attributes
 * @returns the Span instance; the caller must call span.end() manually
 */
export function startChildSpan(
  name: string,
  attrs: Record<string, string | number | boolean> = {},
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  try {
    return getObservabilityBackend().traceMiddleware.startChildSpan(name, attrs);
  } catch {
    return noopSpan;
  }
}

/**
 * Execute a function in the current Span context and automatically create a child Span.
 *
 * @param name Span name
 * @param attrs Span attributes
 * @param fn the function to execute
 * @returns the return value of fn
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (span: any) => Promise<T>,
): Promise<T> {
  try {
    return await getObservabilityBackend().traceMiddleware.withSpan(name, attrs, fn);
  } catch (err) {
    // if the exception was thrown by fn itself, it must be re-thrown
    throw err;
  }
}