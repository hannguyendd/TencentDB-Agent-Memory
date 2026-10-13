/**
 * InjectionObserver -- observability abstraction for the injection pipeline.
 *
 * Design goals:
 *   Hook developers do not need to write any observation code. The pipeline automatically calls back the observer at key lifecycle points;
 *   the observer implementation (Noop/Logging) is injected when the pipeline is constructed and never blocks business logic.
 *
 * Architecture:
 *   InjectionPipeline → try/catch → InjectionObserver.onXxx() → log facade
 *
 * Principles:
 *   - Fire-and-forget: the observer may be async internally, but is not awaited
 *   - Error isolation: no exception in the observer propagates to the pipeline
 *   - Noop by default: zero overhead when not configured
 */

import type { AgentContextMetadata, ContextBlock, InjectionHook, InjectionPoint } from "./types.js";
import { log } from "../report/log.js";
import { createHash } from "node:crypto";
import { TraceFlags } from "@opentelemetry/api";
import { startObservation, LangfuseOtelSpanAttributes } from "@langfuse/tracing";

// ── Hook execution result ─────────────────────────────────────────────────────

/** Summary of a single hook's execution result, aggregated and reported by the pipeline at onPipelineEnd. */
export interface HookResult {
  hookId: string;
  point: InjectionPoint;
  blockCount: number;
  durationMs: number;
  error?: string;
  cacheStrategy?: string;
}

// ── Observer interface ────────────────────────────────────────────────────────

/**
 * Injection pipeline observer interface.
 *
 * The pipeline calls observer methods at the following times:
 *   process() entry     -> onPipelineStart
 *   inside the executeHooks loop -> onHookStart / onHookDone / onHookError (for each hook)
 *   process() exit      -> onPipelineEnd (success) or onPipelineError (failure)
 *
 * Default implementation: NoopInjectionObserver (zero overhead).
 * Production implementation: LoggingInjectionObserver (writes structured logs).
 */
export interface InjectionObserver {
  /** The pipeline starts processing a request. */
  onPipelineStart(meta: AgentContextMetadata): void;

  /** The pipeline completed successfully (all hooks executed). */
  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void;

  /** Pipeline-level error (e.g. unknown protocol, missing adapter); the request did not reach the hook execution stage. */
  onPipelineError(meta: AgentContextMetadata, error: Error): void;

  /** A single hook starts executing. */
  onHookStart(hook: InjectionHook, point: InjectionPoint): void;

  /** A single hook finished executing (including the case of returning empty blocks). */
  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void;

  /** A single hook threw an exception (recorded via error start->error/done). */
  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void;
}

// ── Noop implementation ───────────────────────────────────────────────────────

/**
 * No-op observer -- the default implementation, zero overhead.
 * All methods have empty bodies, with no performance loss after JIT inlining.
 */
export class NoopInjectionObserver implements InjectionObserver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineStart(_meta: AgentContextMetadata): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineEnd(_meta: AgentContextMetadata, _durationMs: number, _results: HookResult[]): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineError(_meta: AgentContextMetadata, _error: Error): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookDone(_hook: InjectionHook, _point: InjectionPoint, _blocks: ContextBlock[], _durationMs: number, _cacheStrategy?: string): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookError(_hook: InjectionHook, _point: InjectionPoint, _error: Error, _durationMs: number): void { /* noop */ }
}

// ── Logging implementation ────────────────────────────────────────────────────

/**
 * Structured-log observer -- writes to the structured logging system in `src/report/log.ts`.
 *
 * Reported events:
 *   injection.pipeline.start  -- pipeline start
 *   injection.pipeline.done   -- pipeline done (with durationMs, hookCount, totalBlockCount)
 *   injection.pipeline.error  -- pipeline-level error
 *   injection.hook.start      -- single hook start
 *   injection.hook.done       -- single hook done (with blocks summary)
 *   injection.hook.error      -- single hook failure
 *
 * Safety guarantee: all methods have an internal try/catch and never throw.
 */
export class LoggingInjectionObserver implements InjectionObserver {
  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      log.info("injection.pipeline.start", {
        traceId: meta.traceId.slice(0, 8),
        protocol: meta.protocol,
        agentSource: meta.agentSource,
        modelId: meta.modelId,
      });
    } catch { /* observer must never throw */ }
  }

  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void {
    try {
      const totalBlockCount = results.reduce((sum, r) => sum + r.blockCount, 0);
      const errorCount = results.filter((r) => r.error).length;
      log.info("injection.pipeline.done", {
        traceId: meta.traceId.slice(0, 8),
        protocol: meta.protocol,
        agentSource: meta.agentSource,
        durationMs,
        hookCount: results.length,
        totalBlockCount,
        errorCount,
      });
    } catch { /* observer must never throw */ }
  }

  onPipelineError(meta: AgentContextMetadata, error: Error): void {
    try {
      log.error(
        "injection.pipeline.error",
        {
          traceId: meta.traceId.slice(0, 8),
          protocol: meta.protocol,
          agentSource: meta.agentSource,
          errorMsg: error.message,
        },
        error,
      );
    } catch { /* observer must never throw */ }
  }

  onHookStart(hook: InjectionHook, point: InjectionPoint): void {
    try {
      log.info("injection.hook.start", {
        hookId: hook.id,
        point,
        cacheStrategy: hook.cacheStrategy ?? "none",
        priority: hook.priority,
      });
    } catch { /* observer must never throw */ }
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    try {
      const blockSummaries = blocks.map((b) => ({
        type: b.type,
        source: String(b.metadata?.source ?? "unknown"),
        preview: b.type === "text"
          ? b.content.replace(/\s+/g, " ").slice(0, 200)
          : `[${b.type}] ${b.metadata?.tool_name ?? ""}`,
      }));

      log.info("injection.hook.done", {
        hookId: hook.id,
        point,
        blockCount: blocks.length,
        durationMs,
        cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none",
        blocks: blockSummaries,
      });
    } catch { /* observer must never throw */ }
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void {
    try {
      log.warn("injection.hook.error", {
        hookId: hook.id,
        point,
        errorMsg: error.message,
        durationMs,
      });
    } catch { /* observer must never throw */ }
  }
}

// ── Langfuse implementation ───────────────────────────────────────────────────

/**
 * Deterministically derive the Langfuse traceId (same algorithm as langfuseTurnTraceId in langfuse.ts).
 * Derived from sessionKey + turnSeq via SHA-256, taking the first 32 hex characters.
 */
function deriveLangfuseTraceId(sessionKey: string, turnSeq: number): string {
  return createHash("sha256").update(`${sessionKey}:${turnSeq}`).digest("hex").slice(0, 32);
}

/** Derive the phantom parent spanId (same as deriveParentSpanId in langfuse.ts). */
function deriveParentSpanId(traceId: string): string {
  return traceId.slice(0, 16);
}

/**
 * Langfuse injection observer -- attaches each hook's execution as a span observation under the Langfuse turn trace.
 *
 * Precondition: metadata.sessionKey and metadata.turnSeq must exist,
 * otherwise all methods degrade to no-op (because the Langfuse traceId cannot be derived).
 *
 * Each hook produces one span observation:
 *   - name: `[inject] {hookId}` or `[inject] {hookId} (error)`
 *   - metadata: hookId, point, cacheStrategy, durationMs, blockCount, blocks summary
 *   - traceId: deterministically derived from sessionKey + turnSeq (shares the same trace as the upstream LLM generation)
 *
 * Safety guarantee: all methods have an internal try/catch and never throw; falls back to noop when the observer is absent or degraded.
 */
export class LangfuseInjectionObserver implements InjectionObserver {
  /** Captured from the metadata of onPipelineStart, used by subsequent hook callbacks. */
  private meta: AgentContextMetadata | null = null;

  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      this.meta = meta;
      // No span -- deferred to hook-level recording
    } catch { /* observer must never throw */ }
  }

  onPipelineEnd(
    _meta: AgentContextMetadata,
    _durationMs: number,
    _results: HookResult[],
  ): void {
    try {
      this.meta = null; // cleanup
    } catch { /* observer must never throw */ }
  }

  onPipelineError(_meta: AgentContextMetadata, _error: Error): void {
    try {
      this.meta = null;
    } catch { /* observer must never throw */ }
  }

  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void {
    // The span is created in one go in onHookDone/onHookError (with the full duration).
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    try {
      const lfTraceId = this.getLangfuseTraceId();
      if (!lfTraceId) return;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);

      const blockSummaries = blocks.map((b) => ({
        type: b.type,
        source: String(b.metadata?.source ?? "unknown"),
        preview: b.type === "text"
          ? b.content.replace(/\s+/g, " ").slice(0, 300)
          : `[${b.type}] ${b.metadata?.tool_name ?? ""}`,
      }));

      // Name format: [inject] <hookId> @ <point> -- searchable by prefix/keyword in Langfuse
      const name = blocks.length > 0
        ? `[inject] ${hook.id} @ ${point}`
        : `[inject] ${hook.id} @ ${point} (empty)`;

      const obsMeta: Record<string, unknown> = {
        hookId: hook.id,
        point,
        source: blocks[0]?.metadata?.source ?? "unknown",
        cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none",
        durationMs,
        blockCount: blocks.length,
        protocol: this.meta?.protocol ?? "unknown",
        agentSource: this.meta?.agentSource ?? "unknown",
      };

      const span = startObservation(
        name,
        {
          input: { point, cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none" },
          output: { blockCount: blocks.length, blocks: blockSummaries },
          metadata: obsMeta,
        },
        {
          asType: "span",
          startTime,
          parentSpanContext: {
            traceId: lfTraceId,
            spanId: deriveParentSpanId(lfTraceId),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      );

      // observation-level annotation
      const otelSpan = span.otelSpan;
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, JSON.stringify(obsMeta));
      // trace-level annotation: overlay the injection summary (last-write-wins; all hooks write, finally the last value is kept)
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_METADATA, JSON.stringify({
        injection: { hookId: hook.id, point, blockCount: blocks.length, durationMs },
      }));
      if (this.meta?.sessionKey) {
        otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, this.meta.sessionKey);
      }

      span.end(endTime);
    } catch { /* observer must never throw */ }
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void {
    try {
      const lfTraceId = this.getLangfuseTraceId();
      if (!lfTraceId) return;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);

      const obsMeta: Record<string, unknown> = {
        hookId: hook.id,
        point,
        errorMsg: error.message,
        durationMs,
        protocol: this.meta?.protocol ?? "unknown",
        agentSource: this.meta?.agentSource ?? "unknown",
      };

      const span = startObservation(
        `[inject] ${hook.id} @ ${point} (error)`,
        {
          input: { point, cacheStrategy: hook.cacheStrategy ?? "none" },
          output: { error: true, message: error.message },
          level: "ERROR",
          statusMessage: error.message,
          metadata: obsMeta,
        },
        {
          asType: "span",
          startTime,
          parentSpanContext: {
            traceId: lfTraceId,
            spanId: deriveParentSpanId(lfTraceId),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      );

      const otelSpan = span.otelSpan;
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, JSON.stringify(obsMeta));
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_LEVEL, "ERROR");

      span.end(endTime);
    } catch { /* observer must never throw */ }
  }

  /** Derive Langfuse traceId from stored metadata, or null if unavailable. */
  private getLangfuseTraceId(): string | null {
    if (!this.meta?.sessionKey || this.meta.turnSeq === undefined) return null;
    return deriveLangfuseTraceId(this.meta.sessionKey, this.meta.turnSeq);
  }
}
