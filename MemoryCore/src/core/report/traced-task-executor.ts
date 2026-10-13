/**
 * TracedTaskExecutor — non-intrusive Trace decorator (facade layer)
 *
 * Wraps the original TaskExecutor, creating an OTel Span for each L1/L2/L3 task execution
 * and restoring the Trace Context across async boundaries from TaskPayload.data.
 *
 * Usage (in server.ts):
 *   const rawExecutor = this.buildTaskExecutor();
 *   const tracedExecutor = new TracedTaskExecutor(rawExecutor);
 *   this.pipelineWorker = new PipelineWorker(backend, tracedExecutor, ...);
 *
 * Does not modify any business code; a pure observability component.
 * The public API signature is unchanged; callers need no modification.
 */

import type { TaskPayload } from "../state/types.js";
import type { TaskExecutor } from "../../services/pipeline-worker.js";
import { getObservabilityBackend } from "./factory.js";
import { obsLogger } from "./obs-logger.js";

/** Task type → Span Name mapping */
const TASK_SPAN_NAMES: Record<string, string> = {
  L1: "core.l1.extraction",
  L2: "core.l2.extraction",
  L3: "core.l3.generation",
  flush: "core.flush",
};

/**
 * TracedTaskExecutor — wraps TaskExecutor using the decorator pattern.
 *
 * For each executeL1/L2/L3 call:
 * 1. Deserialize and restore the upstream Trace Context from task.data
 * 2. Create a CONSUMER-type Span (follow-from link)
 * 3. Execute the original executor within the Span context
 * 4. Record business attributes such as instance_id, session_id, task_type
 * 5. Set the Span Error status on error
 */
export class TracedTaskExecutor implements TaskExecutor {
  private readonly inner: TaskExecutor;

  constructor(inner: TaskExecutor) {
    this.inner = inner;
  }

  async executeL1(task: TaskPayload): Promise<void> {
    return this.executeWithTrace("L1", task, () => this.inner.executeL1(task));
  }

  async executeL2(task: TaskPayload): Promise<void> {
    return this.executeWithTrace("L2", task, () => this.inner.executeL2(task));
  }

  async executeL3(task: TaskPayload): Promise<void> {
    return this.executeWithTrace("L3", task, () => this.inner.executeL3(task));
  }

  async executeFlush?(task: TaskPayload): Promise<void> {
    if (this.inner.executeFlush) {
      return this.executeWithTrace("flush", task, () => this.inner.executeFlush!(task));
    }
    return this.executeL1(task);
  }

  async executeOffloadL1?(task: TaskPayload, signal?: AbortSignal): Promise<void> {
    if (this.inner.executeOffloadL1) {
      return this.executeWithTrace("offload-l1", task, () => this.inner.executeOffloadL1!(task, signal));
    }
  }

  async executeOffloadL15?(task: TaskPayload, signal?: AbortSignal): Promise<void> {
    if (this.inner.executeOffloadL15) {
      return this.executeWithTrace("offload-l15", task, () => this.inner.executeOffloadL15!(task, signal));
    }
  }

  async executeOffloadL2?(task: TaskPayload, signal?: AbortSignal): Promise<void> {
    if (this.inner.executeOffloadL2) {
      return this.executeWithTrace("offload-l2", task, () => this.inner.executeOffloadL2!(task, signal));
    }
  }

  /**
   * Core method: execute a task within a Trace Context.
   *
   * Prefer traceMiddleware.withSpan() so that fn executes in the active span context,
   * so that when fn internally calls metricProducer.send(), the traceId of the current span
   * can be obtained automatically via serializeTraceContext().
   *
   * Degradation strategy: if withSpan is unavailable, fall back to the trace.start()/end() mode.
   */
  private async executeWithTrace(
    taskType: string,
    task: TaskPayload,
    fn: () => Promise<void>,
  ): Promise<void> {
    const backend = getObservabilityBackend();
    const spanName = TASK_SPAN_NAMES[taskType] ?? `core.task.${taskType.toLowerCase()}`;

    // extract business attributes
    const instanceId = task.instanceId
      ?? (typeof task.data?.instanceId === "string" ? task.data.instanceId : "unknown");
    const sessionId = task.sessionId ?? "unknown";

    const attrs: Record<string, string | number | boolean> = {
      "instance_id": instanceId,
      "session_id": sessionId,
      "task_type": taskType,
      "task_id": task.id,
      "event_name": spanName,
      "messaging.system": "redis_stream",
      "messaging.operation": "process",
    };

    // preferred path: use withSpan so that fn executes in the active span context
    if (typeof backend.traceMiddleware?.withSpan === "function") {
      return backend.traceMiddleware.withSpan(spanName, attrs, async (span) => {
        try {
          await fn();
          span.setStatus({ code: 0 /* SpanStatusCode.OK */ });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: errMsg });
          span.recordException(err instanceof Error ? err : new Error(errMsg));

          obsLogger.error(`core.${taskType.toLowerCase()}.failed`, {
            instance_id: instanceId,
            session_id: sessionId,
            task_type: taskType,
            task_id: task.id,
            error: errMsg,
          }, err instanceof Error ? err : undefined);

          throw err;
        }
      });
    }

    // degraded path: when withSpan is unavailable, fall back to start/end (does not activate the context)
    const span = backend.trace.start(spanName, 4 /* SpanKind.CONSUMER */);
    span.setAttributes(attrs);

    try {
      await fn();
      span.setStatus({ code: 0 /* SpanStatusCode.UNSET → OK */ });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: errMsg });
      span.recordException(err instanceof Error ? err : new Error(errMsg));

      obsLogger.error(`core.${taskType.toLowerCase()}.failed`, {
        instance_id: instanceId,
        session_id: sessionId,
        task_type: taskType,
        task_id: task.id,
        error: errMsg,
      }, err instanceof Error ? err : undefined);

      throw err;
    } finally {
      span.end();
    }
  }
}
