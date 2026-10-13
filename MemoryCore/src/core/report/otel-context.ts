/**
 * OTel context helpers。
 *
 * Background (why it is needed):
 *   the skill extraction worker's `runLoop()` is **lazily started** inside some HTTP request handler
 *   （`resolveConversationAdd` → `wireConversationAdd` → `worker.start()`）。
 *   OTel propagates context via AsyncLocalStorageContextManager — a `runLoop()` that **never exits**
 *   permanently inherits the active span "at the moment of startup" (that request's span),
 *   so every subsequent LLM `generateText` becomes a child span of that request's trace, and is
 *   merged by Langfuse into a single trace (tags across multiple agents, confused sessionId).
 *
 *   `runInRootContext` runs fn inside the OTel ROOT_CONTEXT, cutting this parasitism,
 *   so spans newly created inside fn (such as ai.generateText) become independent roots (each with its own traceId).
 *
 * Defensively loads @opentelemetry/api: when the package is missing (open-source / slim deployments) it degrades to executing fn directly,
 * with equivalent semantics and no error. The loading approach is aligned with otel-sdk-init.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _context: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rootContext: any = null;

try {
  const api = await import("@opentelemetry/api");
  _context = api.context;
  _rootContext = api.ROOT_CONTEXT;
} catch {
  // @opentelemetry/api unavailable → stay null; runInRootContext degrades to executing fn directly
}

/**
 * Execute fn in the OTel ROOT_CONTEXT, cutting off inheritance of the call site's active span.
 *
 * Typical use: wrap when starting a background loop that never exits, to prevent the loop from carrying the "startup-time" trace
 * context along forever. When otel is unavailable, fn is executed directly (no context isolation, but equivalent behavior).
 */
export function runInRootContext<T>(fn: () => T): T {
  if (_context && _rootContext) {
    return _context.with(_rootContext, fn) as T;
  }
  return fn();
}
