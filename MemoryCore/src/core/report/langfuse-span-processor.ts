/**
 * Langfuse filtering SpanProcessor (facade layer).
 *
 * Forwards only LLM-related spans (ai.* / gen_ai.* prefixes) to the Langfuse OTLP endpoint;
 * other engineering call spans are dropped to avoid excessive traffic.
 *
 * Design principles:
 * - Does not affect the existing span lifecycle
 * - Silently ignores exporter failures
 * - Graceful degradation when configuration is missing
 *
 * The public API signature is unchanged; callers need no modification.
 * The concrete implementation is provided by ILLMTraceBackend.
 */

import { getObservabilityBackend } from "./factory.js";
import type { ISpanProcessor } from "./types.js";

// ============================
// Config type (exported for backward compatibility)
// ============================

export interface LangfuseConfigEnabled {
  enabled: true;
  host: string;
  publicKey: string;
  secretKey: string;
}

export interface LangfuseConfigDisabled {
  enabled: false;
}

export type LangfuseConfig = LangfuseConfigEnabled | LangfuseConfigDisabled;

// ============================
// Config parsing (exported for backward compatibility)
// ============================

/**
 * Parse Langfuse configuration from environment variables.
 *
 * Environment variables:
 * - LANGFUSE_ENABLED    : "true" to enable (default "false")
 * - LANGFUSE_HOST       : Langfuse instance address (e.g. http://langfuse.example.local:3000)
 * - LANGFUSE_PUBLIC_KEY : public key
 * - LANGFUSE_SECRET_KEY : secret key
 *
 * Returns { enabled: false } when any required configuration is missing.
 */
export function parseLangfuseConfig(): LangfuseConfig {
  const enabled = process.env.LANGFUSE_ENABLED === "true";
  if (!enabled) {
    return { enabled: false };
  }

  const host = process.env.LANGFUSE_HOST;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  // graceful degradation when any required configuration is missing
  if (!host || !publicKey || !secretKey) {
    return { enabled: false };
  }

  return { enabled: true, host, publicKey, secretKey };
}

// ============================
// Span filtering logic (exported for backward compatibility)
// ============================

/**
 * Determine whether a span is LLM-related.
 *
 * Pass-through rules (spans produced by the Vercel AI SDK's experimental_telemetry):
 * - `ai.*`     : ai.generateText, ai.streamText, ai.toolCall, ai.generateObject, etc.
 * - `gen_ai.*` : gen_ai.chat, gen_ai.embeddings, etc. (OpenTelemetry GenAI semantic conventions)
 *
 * All other spans (gateway.*, core.*, queue.*, http.*, etc.) are filtered out.
 */
export function isLLMRelatedSpan(spanName: string): boolean {
  if (!spanName) return false;
  return spanName.startsWith("ai.") || spanName.startsWith("gen_ai.");
}

// ============================
// Vercel AI SDK metadata → Langfuse OTel native attribute mapping
// ============================

/**
 * The Vercel AI SDK serializes each key in experimental_telemetry.metadata as a span attribute
 * prefixed with `ai.telemetry.metadata.<key>`. But when we send **directly** with the
 * OTLP HTTP exporter to Langfuse (without going through the official Langfuse SDK bridge), Langfuse
 * only recognizes its natively-defined attribute names (see https://langfuse.com/integrations/native/opentelemetry).
 *
 * To make Trace name / SessionId / UserId / Tags take effect in the Langfuse UI,
 * the AI SDK metadata keys are translated here into Langfuse native keys.
 *
 * Mapping rules (the target is not written when the source is missing or empty; an existing target is not overwritten):
 *   ai.telemetry.metadata.langfuseTraceName  → langfuse.trace.name
 *   ai.telemetry.metadata.sessionId          → langfuse.session.id
 *   ai.telemetry.metadata.userId             → langfuse.user.id
 *   ai.telemetry.metadata.tags               → langfuse.trace.tags
 *
 * Returns a **new object** containing all original attributes + the added langfuse.* keys. Does not modify its input.
 */
export function mapAiTelemetryToLangfuseAttrs(
  attrs: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!attrs || typeof attrs !== "object") return {};
  const out: Record<string, unknown> = { ...attrs };

  const setIfAbsent = (
    targetKey: string,
    sourceKey: string,
    check: (v: unknown) => boolean,
  ): void => {
    if (out[targetKey] !== undefined) return; // respect explicit user settings
    const v = attrs[sourceKey];
    if (v === undefined || v === null) return;
    if (!check(v)) return;
    out[targetKey] = v;
  };

  const nonEmptyStr = (v: unknown): boolean =>
    typeof v === "string" && v.length > 0;
  const nonEmptyArr = (v: unknown): boolean =>
    Array.isArray(v) && v.length > 0;

  setIfAbsent(
    "langfuse.trace.name",
    "ai.telemetry.metadata.langfuseTraceName",
    nonEmptyStr,
  );
  setIfAbsent(
    "langfuse.session.id",
    "ai.telemetry.metadata.sessionId",
    nonEmptyStr,
  );
  setIfAbsent(
    "langfuse.user.id",
    "ai.telemetry.metadata.userId",
    nonEmptyStr,
  );
  setIfAbsent(
    "langfuse.trace.tags",
    "ai.telemetry.metadata.tags",
    nonEmptyArr,
  );

  return out;
}

// ============================
// LangfuseFilteringProcessor (facade layer)
// ============================

/**
 * Create a Langfuse SpanProcessor instance.
 * Obtains the actual processor via the ILLMTraceBackend interface.
 *
 * @returns a SpanProcessor instance, or null (if Langfuse is not enabled)
 */
export function createLangfuseSpanProcessor(): ISpanProcessor | null {
  try {
    return getObservabilityBackend().llmTrace.createSpanProcessor();
  } catch {
    return null;
  }
}

/**
 * Compatibility layer: the LangfuseFilteringProcessor class.
 * Keeps backward compatibility, delegating internally to ILLMTraceBackend.
 *
 * When ILLMTraceBackend returns a valid processor, delegates to it;
 * otherwise falls back to filtering + exporting with the provided exporter (forwarding LLM spans directly).
 */
export class LangfuseFilteringProcessor implements ISpanProcessor {
  /** Processor from ILLMTraceBackend (used only when there is no exporter) */
  private _processor: ISpanProcessor | null;
  /** The real exporter passed in by otel-sdk-init.ts (highest priority) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _exporter: any;

  constructor(exporter?: unknown) {
    if (exporter) {
      // When an exporter is provided, prefer using it for the actual export.
      // otel-sdk-init.ts has already created an HttpTraceExporter pointing at the Langfuse OTLP endpoint;
      // it is used directly here instead of delegating to ILLMTraceBackend (whose processor may be an empty shell).
      this._exporter = exporter;
      this._processor = null;
    } else {
      // With no exporter, try to get a processor from ILLMTraceBackend
      this._processor = getObservabilityBackend().llmTrace.createSpanProcessor();
      this._exporter = null;
    }
  }

  onStart(span: unknown, parentContext: unknown): void {
    this._processor?.onStart(span, parentContext);
  }

  onEnd(span: unknown): void {
    try {
      const s = span as { name?: string; attributes?: Record<string, unknown> };
      // Unified filtering: forward only LLM-related spans
      if (!s.name || !isLLMRelatedSpan(s.name)) {
        return;
      }

      if (this._exporter) {
        // Before export, translate the Vercel AI SDK metadata into Langfuse native attributes,
        // so that Trace name / SessionId / UserId / Tags take effect in the Langfuse UI.
        // To avoid affecting later use of the span by other processors, a shallow-copied span object is constructed here.
        const enrichedAttrs = mapAiTelemetryToLangfuseAttrs(s.attributes);
        const enrichedSpan =
          enrichedAttrs === s.attributes
            ? span
            : Object.assign(Object.create(Object.getPrototypeOf(span) ?? {}), span, {
                attributes: enrichedAttrs,
              });
        // Use the real exporter to send to the Langfuse OTLP endpoint
        this._exporter.export([enrichedSpan], () => {});
      } else if (this._processor) {
        // Delegate to the processor of ILLMTraceBackend
        this._processor.onEnd(span);
      }
    } catch {
      // Silent failure; does not affect other SpanProcessors
    }
  }

  async forceFlush(): Promise<void> {
    if (this._exporter?.forceFlush) {
      await this._exporter.forceFlush();
    } else if (this._processor) {
      await this._processor.forceFlush();
    }
  }

  async shutdown(): Promise<void> {
    if (this._exporter?.shutdown) {
      await this._exporter.shutdown();
    }
    if (this._processor) {
      await this._processor.shutdown();
    }
  }
}
