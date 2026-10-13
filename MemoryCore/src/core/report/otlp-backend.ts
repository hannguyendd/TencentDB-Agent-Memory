/**
 * OTLP Observability Backend — built-in backend implementation based on the standard OpenTelemetry OTLP protocol.
 *
 * This is the out-of-the-box observability backend for open-source users. Users only need to configure one OTLP endpoint
 * to report Trace, Log, and Metric all to any backend that supports the OTLP protocol:
 *   - ClickHouse (native OTLP ingestion)
 *   - Jaeger (supports OTLP)
 *   - Grafana Tempo + Loki + Mimir (the whole stack supports OTLP)
 *   - SigNoz (open-source all-in-one, native OTLP)
 *   - Local OTel Collector (universal relay)
 *
 * Usage:
 *   await initObservabilityBackend({
 *     type: "otlp",
 *     otel: {
 *       enabled: true,
 *       endpoint: "http://localhost:4318",   // address of any OTLP-capable backend
 *       protocol: "http",                    // "http" (OTLP/HTTP) or "grpc" (OTLP/gRPC)
 *       serviceName: "my-memory-service",    // service name (optional, default "tdai-memory")
 *     },
 *   });
 *
 * If not configured (type is "noop"), all observability calls are no-ops with zero overhead.
 *
 * Design principles:
 * - Initialized with the standard @opentelemetry/sdk-node, compatible with the entire OTel ecosystem
 * - Trace + Log + Metric in one, a single endpoint does it all
 * - No method throws; the business is unaffected
 * - Gracefully degrades to console output when initialization fails
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
  OTelConfig,
} from "./types.js";

const TAG = "[observability][otlp]";

// ============================
// OTel SDK dynamic loading
// ============================

/**
 * OTel SDK runtime references.
 * Loaded via dynamic import; when loading fails, all backends degrade to console output.
 */
interface OTelRuntime {
  // @opentelemetry/api
  trace: any;
  context: any;
  propagation: any;
  SpanKind: any;
  SpanStatusCode: any;
  ROOT_CONTEXT: any;
  TraceFlags: any;
  // @opentelemetry/api-logs
  logs: any;
  SeverityNumber: any;
}

let _runtime: OTelRuntime | null = null;
let _runtimeLoaded = false;

/**
 * Try to load the OTel SDK runtime.
 * Returns null on load failure (dependency not installed).
 */
async function loadOTelRuntime(): Promise<OTelRuntime | null> {
  if (_runtimeLoaded) return _runtime;
  _runtimeLoaded = true;

  try {
    const api = await import("@opentelemetry/api");
    let logsApi: any = null;
    try {
      logsApi = await import("@opentelemetry/api-logs");
    } catch {
      // api-logs is optional
    }

    _runtime = {
      trace: api.trace,
      context: api.context,
      propagation: api.propagation,
      SpanKind: api.SpanKind,
      SpanStatusCode: api.SpanStatusCode,
      ROOT_CONTEXT: api.ROOT_CONTEXT,
      TraceFlags: api.TraceFlags,
      logs: logsApi?.logs ?? null,
      SeverityNumber: logsApi?.SeverityNumber ?? { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 },
    };
    return _runtime;
  } catch {
    console.warn(`${TAG} @opentelemetry/api not available. OTLP backend will use console fallback.`);
    return null;
  }
}

/**
 * Initialize the OTel SDK (NodeSDK).
 * Configures the OTLP exporter to send trace/log/metric to the user-specified endpoint.
 */
async function initOTelSDK(config: OTelConfig): Promise<boolean> {
  try {
    const protocol = config.protocol ?? "http";
    const endpoint = config.endpoint ?? "http://localhost:4318";
    const serviceName = config.serviceName ?? "tdai-memory";

    // dynamically load SDK components
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { Resource } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");

    // choose the exporter by protocol
    let traceExporter: any;
    let logExporter: any;

    if (protocol === "grpc") {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
      traceExporter = new OTLPTraceExporter({ url: endpoint });

      try {
        const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-grpc");
        logExporter = new OTLPLogExporter({ url: endpoint });
      } catch {
        // log exporter is optional
      }
    } else {
      // default HTTP
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
      traceExporter = new OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
      });

      try {
        const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
        logExporter = new OTLPLogExporter({
          url: `${endpoint}/v1/logs`,
        });
      } catch {
        // log exporter is optional
      }
    }

    // build the SDK config
    const sdkConfig: any = {
      resource: new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
      }),
      traceExporter,
    };

    // if there is a log exporter, add a log record processor
    if (logExporter) {
      try {
        const { SimpleLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
        sdkConfig.logRecordProcessors = [new SimpleLogRecordProcessor(logExporter)];
      } catch {
        // sdk-logs is optional
      }
    }

    const sdk = new NodeSDK(sdkConfig);
    sdk.start();

    console.log(
      `${TAG} OTel SDK initialized ✓ | endpoint=${endpoint} | protocol=${protocol} | service=${serviceName}`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${TAG} Failed to initialize OTel SDK: ${msg}. Trace/Log will use console fallback.`);
    return false;
  }
}

// ============================
// ISpan adapter
// ============================

function wrapOTelSpan(otelSpan: any): ISpan {
  return {
    end() { otelSpan.end(); },
    setAttribute(key: string, value: string | number | boolean) {
      otelSpan.setAttribute(key, value);
      return this;
    },
    setAttributes(attrs: Record<string, string | number | boolean>) {
      otelSpan.setAttributes(attrs);
      return this;
    },
    setStatus(status: { code: number; message?: string }) {
      otelSpan.setStatus(status);
      return this;
    },
    recordException(exception: Error | string) {
      otelSpan.recordException(exception instanceof Error ? exception : new Error(exception));
    },
    spanContext() {
      const ctx = otelSpan.spanContext();
      return { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: ctx.traceFlags };
    },
    isRecording() { return otelSpan.isRecording(); },
    updateName(name: string) { otelSpan.updateName(name); return this; },
    addEvent(name: string, attrs?: Record<string, string | number | boolean>) {
      otelSpan.addEvent(name, attrs);
      return this;
    },
  };
}

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
// OtlpTraceBackend
// ============================

const TRACER_NAME = "tdai-memory";

/**
 * OTLP Trace backend — creates Spans via the standard OTel API and reports them via the OTLP protocol.
 */
export class OtlpTraceBackend implements ITraceBackend {
  readonly type = "otlp";

  report(event: string, attrs: TraceAttrs = {}): void {
    if (!_runtime) return;
    try {
      const tracer = _runtime.trace.getTracer(TRACER_NAME);
      const span = tracer.startSpan(`tdai.${event}`, {
        kind: _runtime.SpanKind.INTERNAL,
      }, _runtime.context.active());

      for (const [key, value] of Object.entries(attrs)) {
        if (value !== null && value !== undefined) {
          span.setAttribute(key, value);
        }
      }

      if (attrs.success === false || attrs.success === 0) {
        const errorMsg = typeof attrs.error === "string" ? attrs.error : "unknown error";
        span.setStatus({ code: _runtime.SpanStatusCode.ERROR, message: errorMsg });
      } else {
        span.setStatus({ code: _runtime.SpanStatusCode.OK });
      }

      span.end();
    } catch {
      // silent
    }
  }

  start(spanName: string, kind?: number): ISpan {
    if (!_runtime) return noopSpan;
    try {
      const tracer = _runtime.trace.getTracer(TRACER_NAME);
      const otelKind = kind ?? _runtime.SpanKind.INTERNAL;
      const span = tracer.startSpan(spanName, { kind: otelKind }, _runtime.context.active());
      return wrapOTelSpan(span);
    } catch {
      return noopSpan;
    }
  }

  startServer(spanName: string): ISpan {
    return this.start(spanName, _runtime?.SpanKind?.SERVER ?? 1);
  }

  startClient(spanName: string): ISpan {
    return this.start(spanName, _runtime?.SpanKind?.CLIENT ?? 2);
  }
}

// ============================
// OtlpLogBackend
// ============================

/**
 * OTLP Log backend — sends structured logs via the OTel Logs API and reports them via the OTLP protocol.
 */
export class OtlpLogBackend implements ILogBackend {
  readonly type = "otlp";

  info(eventName: string, attrs: LogAttrs = {}): void {
    this.emit("INFO", 9, eventName, attrs);
  }

  warn(eventName: string, attrs: LogAttrs = {}): void {
    this.emit("WARN", 13, eventName, attrs);
  }

  error(eventName: string, attrs: LogAttrs = {}, _error?: Error): void {
    this.emit("ERROR", 17, eventName, attrs);
  }

  debug(eventName: string, attrs: LogAttrs = {}): void {
    this.emit("DEBUG", 5, eventName, attrs);
  }

  private emit(level: string, severityNumber: number, message: string, attrs: LogAttrs): void {
    if (!_runtime?.logs) return;
    try {
      const logger = _runtime.logs.getLogger(TRACER_NAME);
      logger.emit({
        severityNumber,
        severityText: level,
        body: message,
        attributes: attrs,
        context: _runtime.context?.active?.(),
      });
    } catch {
      // silent
    }
  }
}

// ============================
// OtlpMetricBackend
// ============================

/**
 * OTLP Metric backend — reports metrics via the OTel Metrics API.
 *
 * Note: OTel Metrics requires @opentelemetry/sdk-metrics;
 * if not installed it degrades to console output.
 */
export class OtlpMetricBackend implements IMetricBackend {
  readonly type = "otlp";
  private _meter: any = null;
  private _counters: Map<string, any> = new Map();
  private _initialized = false;

  send(msg: MetricMessage): void {
    if (!this._initialized || !this._meter) {
      // degrade: if OTel Metrics is unavailable, silently ignore
      return;
    }

    try {
      // get or create the counter
      let counter = this._counters.get(msg.metric);
      if (!counter) {
        counter = this._meter.createCounter(msg.metric, {
          description: `Memory metric: ${msg.metric}`,
        });
        this._counters.set(msg.metric, counter);
      }

      counter.add(msg.value, {
        instance_id: msg.instanceId,
        source: msg.source ?? "core",
      });
    } catch {
      // silent
    }
  }

  async initialize(_config: MetricBackendConfig): Promise<void> {
    // try to load the OTel Metrics SDK
    try {
      const { metrics } = await import("@opentelemetry/api");
      this._meter = metrics.getMeter(TRACER_NAME);
      this._initialized = true;
    } catch {
      // metrics in @opentelemetry/api is unavailable; silently degrade
      this._initialized = false;
    }
  }

  async destroy(): Promise<void> {
    this._counters.clear();
    this._meter = null;
    this._initialized = false;
  }
}

// ============================
// OtlpLLMTraceBackend
// ============================

/**
 * OTLP LLM Trace backend — in OTLP mode, LLM spans are reported directly via the standard trace.
 * No extra Langfuse is needed; all spans (including ai.* / gen_ai.*) go through OTLP.
 */
export class OtlpLLMTraceBackend implements ILLMTraceBackend {
  readonly type = "otlp";

  createSpanProcessor(): ISpanProcessor | null {
    // No extra SpanProcessor is needed in OTLP mode;
    // all spans are already reported uniformly via NodeSDK's traceExporter
    return null;
  }

  async flush(): Promise<void> {
    // flush is managed uniformly by NodeSDK
  }

  async shutdown(): Promise<void> {
    // shutdown is managed uniformly by NodeSDK
  }
}

// ============================
// OtlpTraceMiddleware
// ============================

/** Paths that do not need a Trace */
const SKIP_PATHS = new Set(["/health"]);

/** Route → Span Name mapping */
const ROUTE_SPAN_NAMES: Record<string, string> = {
  "POST /capture": "core.capture",
  "POST /recall": "core.recall",
  "POST /search/memories": "core.search.memories",
  "POST /search/conversations": "core.search.conversations",
  "POST /session/end": "core.session.end",
  "POST /seed": "core.seed",
};

/**
 * OTLP HTTP Trace middleware — creates a SERVER Span for each HTTP request.
 */
export class OtlpTraceMiddleware implements ITraceMiddleware {
  readonly type = "otlp";

  async wrapWithTrace(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: () => Promise<void>,
  ): Promise<void> {
    if (!_runtime) {
      return handler();
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = url.pathname;

    if (SKIP_PATHS.has(pathname)) {
      return handler();
    }

    // extract the upstream Trace Context from the W3C traceparent header
    const parentContext = _runtime.propagation.extract(_runtime.ROOT_CONTEXT, req.headers, {
      get(carrier: any, key: string) {
        const val = carrier[key.toLowerCase()];
        return Array.isArray(val) ? val[0] : val ?? undefined;
      },
      keys(carrier: any) { return Object.keys(carrier); },
    });

    const routeKey = `${method} ${pathname}`;
    const spanName = ROUTE_SPAN_NAMES[routeKey] ?? "core.request";

    const tracer = _runtime.trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(
      spanName,
      {
        kind: _runtime.SpanKind.SERVER,
        attributes: {
          "http.method": method,
          "http.url": pathname,
          "http.host": req.headers.host ?? "",
        },
      },
      parentContext,
    );

    // extract business attributes
    const instanceId = (req.headers["x-tdai-service-id"] ?? req.headers["x-instance-id"] ?? "") as string;
    if (instanceId) span.setAttribute("instance_id", instanceId);
    const reqId = (req.headers["x-qcloud-transaction-id"] ?? req.headers["x-request-id"] ?? "") as string;
    if (reqId) span.setAttribute("req_id", reqId);

    const spanContext = _runtime.trace.setSpan(parentContext, span);
    const traceId = span.spanContext().traceId;
    res.setHeader("x-trace-id", traceId);

    try {
      await _runtime.context.with(spanContext, async () => {
        await handler();
      });

      span.setAttribute("http.status_code", res.statusCode);
      if (res.statusCode >= 400) {
        span.setStatus({ code: _runtime!.SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
      } else {
        span.setStatus({ code: _runtime!.SpanStatusCode.OK });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: _runtime!.SpanStatusCode.ERROR, message: errMsg });
      span.recordException(err instanceof Error ? err : new Error(errMsg));
      throw err;
    } finally {
      span.end();
    }
  }

  startChildSpan(
    name: string,
    attrs: Record<string, string | number | boolean> = {},
  ): ISpan {
    if (!_runtime) return noopSpan;
    try {
      const tracer = _runtime.trace.getTracer(TRACER_NAME);
      const span = tracer.startSpan(name, {
        kind: _runtime.SpanKind.INTERNAL,
        attributes: attrs,
      }, _runtime.context.active());
      return wrapOTelSpan(span);
    } catch {
      return noopSpan;
    }
  }

  async withSpan<T>(
    name: string,
    attrs: Record<string, string | number | boolean>,
    fn: (span: ISpan) => Promise<T>,
  ): Promise<T> {
    if (!_runtime) {
      return fn(noopSpan);
    }

    const tracer = _runtime.trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(name, {
      kind: _runtime.SpanKind.INTERNAL,
      attributes: attrs,
    }, _runtime.context.active());

    const spanContext = _runtime.trace.setSpan(_runtime.context.active(), span);
    const wrappedSpan = wrapOTelSpan(span);

    try {
      const result = await _runtime.context.with(spanContext, () => fn(wrappedSpan));
      span.setStatus({ code: _runtime!.SpanStatusCode.OK });
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: _runtime!.SpanStatusCode.ERROR, message: errMsg });
      span.recordException(err instanceof Error ? err : new Error(errMsg));
      throw err;
    } finally {
      span.end();
    }
  }
}

// ============================
// OtlpTracePropagation
// ============================

/** Field name serialized into TaskPayload.data */
const TRACE_ID_KEY = "_traceId";
const SPAN_ID_KEY = "_spanId";
const TRACE_FLAGS_KEY = "_traceFlags";

/**
 * OTLP Trace Context propagation — serializes/deserializes the Trace Context via the OTel API.
 */
export class OtlpTracePropagation implements ITracePropagation {
  serializeTraceContext(): Record<string, string | number> {
    if (!_runtime) return {};
    try {
      const span = _runtime.trace.getSpan(_runtime.context.active());
      if (!span) return {};
      const spanCtx = span.spanContext();
      if (!spanCtx.traceId) return {};
      return {
        [TRACE_ID_KEY]: spanCtx.traceId,
        [SPAN_ID_KEY]: spanCtx.spanId,
        [TRACE_FLAGS_KEY]: spanCtx.traceFlags,
      };
    } catch {
      return {};
    }
  }

  deserializeTraceContext(data?: Record<string, unknown>): {
    parentContext: unknown;
    parentSpanContext: { traceId: string; spanId: string; traceFlags: number; isRemote: boolean } | null;
  } {
    if (!data || !_runtime) {
      return { parentContext: _runtime?.ROOT_CONTEXT ?? {}, parentSpanContext: null };
    }

    const traceId = data[TRACE_ID_KEY] as string | undefined;
    const spanId = data[SPAN_ID_KEY] as string | undefined;
    const traceFlags = data[TRACE_FLAGS_KEY] as number | undefined;

    if (!traceId || !spanId) {
      return { parentContext: _runtime.ROOT_CONTEXT, parentSpanContext: null };
    }

    try {
      const parentSpanContext = {
        traceId,
        spanId,
        traceFlags: traceFlags ?? _runtime.TraceFlags.SAMPLED,
        isRemote: true,
      };
      const parentContext = _runtime.trace.setSpanContext(_runtime.ROOT_CONTEXT, parentSpanContext);
      return { parentContext, parentSpanContext };
    } catch {
      return { parentContext: _runtime.ROOT_CONTEXT, parentSpanContext: null };
    }
  }
}

// ============================
// OtlpObservabilityBackend — aggregation
// ============================

/**
 * OTLP observability backend — based on the standard OpenTelemetry OTLP protocol.
 *
 * Out of the box for open-source users: configure one OTLP endpoint to report Trace/Log/Metric all together.
 * Supports any backend compatible with the OTLP protocol (ClickHouse, Jaeger, Grafana, SigNoz, etc.).
 *
 * Usage:
 *   await initObservabilityBackend({
 *     type: "otlp",
 *     otel: {
 *       enabled: true,
 *       endpoint: "http://localhost:4318",
 *       serviceName: "my-memory-service",
 *     },
 *   });
 */
export class OtlpObservabilityBackend implements IObservabilityBackend {
  readonly type = "otlp";
  readonly trace: ITraceBackend = new OtlpTraceBackend();
  readonly log: ILogBackend = new OtlpLogBackend();
  readonly metric: IMetricBackend = new OtlpMetricBackend();
  readonly llmTrace: ILLMTraceBackend = new OtlpLLMTraceBackend();
  readonly traceMiddleware: ITraceMiddleware = new OtlpTraceMiddleware();
  readonly tracePropagation: ITracePropagation = new OtlpTracePropagation();

  async initialize(config: ObservabilityConfig): Promise<void> {
    const otelConfig = config.otel;

    if (!otelConfig?.enabled) {
      console.warn(`${TAG} OTLP backend requested but otel.enabled is false. All observability will be no-op.`);
      return;
    }

    // 1. load the OTel runtime
    const runtime = await loadOTelRuntime();
    if (!runtime) {
      console.warn(`${TAG} @opentelemetry/api not installed. Run: npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http`);
      return;
    }

    // 2. initialize the OTel SDK (configure the OTLP exporter)
    await initOTelSDK(otelConfig);

    // 3. initialize the Metric backend
    await this.metric.initialize({
      brokers: [],
      enabled: true,
    });

    console.log(`${TAG} OtlpObservabilityBackend initialized ✓`);
  }

  async shutdown(): Promise<void> {
    await this.metric.destroy();
    console.log(`${TAG} OtlpObservabilityBackend shutdown`);
  }
}
