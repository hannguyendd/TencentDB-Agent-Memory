/**
 * stages/stream-finalize.ts — collection of reusable small helpers for the stream tap tail.
 *
 * 4 helpers (corresponding to the 4 finalize sites in openai-chat + anthropic + codex + workbuddy):
 *   1. stageWriteUsageLog      — writeLog(event:"usage") + gate + try/catch
 *   2. stageRecordTokenUsage   — recordInputTokenUsage + custom+rateLimit gate
 *   3. stageEmitModelIntent    — emitModelIntentTelemetry + gate + fanout
 *   4. stageOpikStreamSpan     — opikUpdateTrace(main) + opikUpdateTrace(fork) + opikCreateLlmSpan
 *
 * No "one giant stageStreamFinalize", because the finalize of the 4 runners:
 *   - Langfuse input formatter differs per protocol (buildLangfuseInputChat / buildLangfuseInput / codex+wb each their own)
 *   - assistantMessage assembly shapes differ (openai role+content+tool_calls / anthropic content[] / responses type+content)
 *   - notifyUpstreamResponse toolCalls mapper differs (openai/anthropic/wb specifics)
 * These stay inline in the caller; only the 4 segments that "produce the same side effects for the same parameters" are extracted.
 *
 * Each helper's internal implementation strictly preserves the old handler behavior + gate semantics:
 *   - opikGate / writeLogUsageGate / modelIntentTelemetryGate / rateLimitGate
 *   - all go through ctx.gates?.<name> !== false, default undefined = keep old behavior (run)
 */

import type { ProxyConfig } from "../../types.js";
import { writeLog, type Pipeline } from "../../logger.js";
import { opikCreateLlmSpan, opikUpdateTrace } from "../../opik.js";
import { emitModelIntentTelemetry } from "../../session/model-intent-telemetry.js";
import { recordInputTokenUsage } from "../../rate-limit/guard.js";
import type { UsageProtocol } from "../../rate-limit/usage.js";
import type { StageGates } from "../strategies/agent/types.js";

// ── 1. usage log ────────────────────────────────────────────────────────────

export interface WriteUsageLogInput {
  config: ProxyConfig;
  gates?: StageGates;
  timestamp: string;
  modelId: string;
  keyId: string;
  sessionKey: string;
  turnSeq?: number;
  userInput?: string;
  upstreamUrl: string;
  usage: Record<string, unknown> | null | undefined;
  requestReceivedAt: string;
  extensionStats?: Record<string, unknown> | undefined;
  logMeta?: Record<string, unknown>;
  routedFrom?: string;
  spaceId?: string;
  upstreamRequestId?: string;
  pipe: Pipeline;
}

export function stageWriteUsageLog(input: WriteUsageLogInput): void {
  if (input.gates?.writeLogUsage === false) return;
  try {
    writeLog(input.config, {
      timestamp: input.timestamp,
      event: "usage",
      modelId: input.modelId,
      keyId: input.keyId,
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      userInput: input.userInput,
      upstreamUrl: input.upstreamUrl,
      stream: true,
      // usage missing/null -> fall back to an empty-object placeholder (writeLog requires it; the old handler
      // always did the same fallback; UsageLogEntry.usage is only spread downstream, an empty object is harmless)
      usage: input.usage ?? {},
      requestReceivedAt: input.requestReceivedAt,
      extensionStats: input.extensionStats,
      ...(input.logMeta ?? {}),
      routedFrom: input.routedFrom,
      spaceId: input.spaceId,
      upstreamRequestId: input.upstreamRequestId,
    });
  } catch (logErr: unknown) {
    input.pipe.error("LOG_WRITE", logErr);
  }
}

// ── 2. record input token usage ─────────────────────────────────────────────

export interface RecordTokenUsageInput {
  config: ProxyConfig;
  gates?: StageGates;
  isCustomUpstream: boolean;
  spaceId?: string;
  modelId: string;
  usage: Record<string, unknown>;
  protocol: UsageProtocol;
}

export async function stageRecordTokenUsage(input: RecordTokenUsageInput): Promise<void> {
  // custom upstream does not count toward the token bucket (symmetric with enforceRateLimit)
  // skipped as well when the rateLimit gate is off (codex/wb bootstrap state)
  if (input.isCustomUpstream) return;
  if (input.gates?.rateLimit === false) return;
  await recordInputTokenUsage({
    config: input.config,
    instanceId: input.spaceId || undefined,
    modelId: input.modelId,
    usage: input.usage,
    protocol: input.protocol,
  });
}

// ── 3. emit model intent telemetry ──────────────────────────────────────────

export interface EmitModelIntentInput {
  gates?: StageGates;
  /** compositeKey shape "agentSource:sessionKey" (aligned with session_init_logs) */
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId: string;
  agentSource: string;
  intents: Array<{ name: string; arguments: string }>;
}

export function stageEmitModelIntent(input: EmitModelIntentInput): void {
  if (input.gates?.modelIntentTelemetry === false) return;
  if (input.intents.length === 0) return;
  try {
    emitModelIntentTelemetry({
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      spaceId: input.spaceId,
      userId: input.userId,
      agentSource: input.agentSource,
      intents: input.intents,
    });
  } catch {
    // tracking never blocks the business flow
  }
}

// ── 4. opik update trace + create llm span ──────────────────────────────────

export interface OpikStreamSpanInput {
  config: ProxyConfig;
  gates?: StageGates;
  traceId: string;
  forkTraceId?: string;
  keyId: string;
  modelId: string;
  startTime: string;
  endTime: string;
  inputMessages: unknown[];
  outputMessage: Record<string, unknown> | null;
  usage: Record<string, unknown>;
  retried: boolean;
  upstreamUrl: string;
  pipe: Pipeline;
  /**
   * openai-chat specific: after the stream completes, both update trace + create llm span are done.
   * The anthropic runner only creates the span (the trace is managed separately by the caller), off by default.
   *
   * true = go through updateTrace(main + fork) + createLlmSpan (the old openai-chat behavior)
   * false = only go through createLlmSpan (the old anthropic behavior)
   */
  updateTrace?: boolean;
  /** custom stream tag append (anthropic has no "stream" tag, only adds "retry" on retry) */
  streamTag?: string;
}

export function stageOpikStreamSpan(input: OpikStreamSpanInput): void {
  if (input.gates?.opik === false) return;
  const outputMessages = input.outputMessage ? [input.outputMessage] : [];
  try {
    if (input.updateTrace) {
      opikUpdateTrace(input.config, {
        traceId: input.traceId,
        projectName: input.keyId,
        endTime: input.endTime,
        output: outputMessages,
        usage: input.usage,
      });
      if (input.forkTraceId && !input.config.opik.stripRequestLogContent) {
        opikUpdateTrace(input.config, {
          traceId: input.forkTraceId,
          projectName: "request_log",
          endTime: input.endTime,
          output: outputMessages,
          usage: input.usage,
        });
      }
    }
    const tags: string[] = [];
    if (input.streamTag) tags.push(input.streamTag);
    if (input.retried) tags.push("retry");
    opikCreateLlmSpan(input.config, {
      traceId: input.traceId,
      projectName: input.keyId,
      name: input.modelId,
      startTime: input.startTime,
      endTime: input.endTime,
      inputMessages: input.inputMessages,
      outputMessage: input.outputMessage,
      model: input.modelId,
      usage: input.usage,
      tags: tags.length > 0 ? tags : undefined,
      forkProjectName: "request_log",
      forkTraceId: input.forkTraceId,
      forkMetadata: {
        keyId: input.keyId,
        modelId: input.modelId,
        stream: true,
        upstreamUrl: input.upstreamUrl,
      },
    });
  } catch (opikErr: unknown) {
    input.pipe.error("OPIK_SPAN", opikErr);
  }
}
