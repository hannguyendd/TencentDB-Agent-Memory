/**
 * Noop Observability Backend — no-op implementation.
 *
 * All methods are no-ops and produce no side effects.
 * The default implementation when no observability backend is configured in open-source environments.
 *
 * Design principles:
 * - No method throws
 * - No I/O or side effects
 * - Zero performance overhead
 */

import type http from "node:http";
import type {
  ITraceBackend,
  ILogBackend,
  IMetricBackend,
  ILLMTraceBackend,
  ITraceMiddleware,
  ITracePropagation,
  IObservabilityBackend,
  ISpan,
  ISpanProcessor,
  TraceAttrs,
  LogAttrs,
  MetricMessage,
  MetricBackendConfig,
  ObservabilityConfig,
} from "./types.js";

// ============================
// Noop Span
// ============================

/** No-op Span — all methods are no-ops */
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

// ============================
// Noop SpanProcessor
// ============================

/** No-op SpanProcessor */
const noopSpanProcessor: ISpanProcessor = {
  onStart() {},
  onEnd() {},
  async forceFlush() {},
  async shutdown() {},
};

// ============================
// NoopTraceBackend
// ============================

export class NoopTraceBackend implements ITraceBackend {
  readonly type = "noop";

  report(_event: string, _attrs?: TraceAttrs): void {
    // no-op
  }

  start(_spanName: string, _kind?: number): ISpan {
    return noopSpan;
  }

  startServer(_spanName: string): ISpan {
    return noopSpan;
  }

  startClient(_spanName: string): ISpan {
    return noopSpan;
  }
}

// ============================
// NoopLogBackend
// ============================

export class NoopLogBackend implements ILogBackend {
  readonly type = "noop";

  info(_eventName: string, _attrs?: LogAttrs): void {
    // no-op
  }

  warn(_eventName: string, _attrs?: LogAttrs): void {
    // no-op
  }

  error(_eventName: string, _attrs?: LogAttrs, _error?: Error): void {
    // no-op
  }

  debug(_eventName: string, _attrs?: LogAttrs): void {
    // no-op
  }
}

// ============================
// NoopMetricBackend
// ============================

export class NoopMetricBackend implements IMetricBackend {
  readonly type = "noop";

  send(_msg: MetricMessage): void {
    // no-op
  }

  async initialize(_config: MetricBackendConfig): Promise<void> {
    // no-op
  }

  async destroy(): Promise<void> {
    // no-op
  }
}

// ============================
// NoopLLMTraceBackend
// ============================

export class NoopLLMTraceBackend implements ILLMTraceBackend {
  readonly type = "noop";

  createSpanProcessor(): ISpanProcessor | null {
    return noopSpanProcessor;
  }

  async flush(): Promise<void> {
    // no-op
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}

// ============================
// NoopTraceMiddleware
// ============================

export class NoopTraceMiddleware implements ITraceMiddleware {
  readonly type = "noop";

  async wrapWithTrace(
    _req: http.IncomingMessage,
    _res: http.ServerResponse,
    handler: () => Promise<void>,
  ): Promise<void> {
    // pass straight through to the original handler
    return handler();
  }

  startChildSpan(
    _name: string,
    _attrs?: Record<string, string | number | boolean>,
  ): ISpan {
    return noopSpan;
  }

  async withSpan<T>(
    _name: string,
    _attrs: Record<string, string | number | boolean>,
    fn: (span: ISpan) => Promise<T>,
  ): Promise<T> {
    return fn(noopSpan);
  }
}

// ============================
// NoopTracePropagation
// ============================

export class NoopTracePropagation implements ITracePropagation {
  serializeTraceContext(): Record<string, string | number> {
    return {};
  }

  deserializeTraceContext(_data?: Record<string, unknown>): {
    parentContext: unknown;
    parentSpanContext: { traceId: string; spanId: string; traceFlags: number; isRemote: boolean } | null;
  } {
    return { parentContext: {}, parentSpanContext: null };
  }
}

// ============================
// NoopObservabilityBackend — aggregation
// ============================

/**
 * No-op observability backend — all sub-backends are no-ops.
 * The default implementation in open-source environments.
 */
export class NoopObservabilityBackend implements IObservabilityBackend {
  readonly type = "noop";
  readonly trace: ITraceBackend = new NoopTraceBackend();
  readonly log: ILogBackend = new NoopLogBackend();
  readonly metric: IMetricBackend = new NoopMetricBackend();
  readonly llmTrace: ILLMTraceBackend = new NoopLLMTraceBackend();
  readonly traceMiddleware: ITraceMiddleware = new NoopTraceMiddleware();
  readonly tracePropagation: ITracePropagation = new NoopTracePropagation();

  async initialize(_config: ObservabilityConfig): Promise<void> {
    // no-op
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
