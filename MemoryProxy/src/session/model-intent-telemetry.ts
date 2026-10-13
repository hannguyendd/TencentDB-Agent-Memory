/**
 * Model intent (tool_use) telemetry helper — shared by handler.ts and anthropicHandler.ts.
 *
 * Design: after the SSE stream closes, convert all tool_use entries in the current turn's toolCallAccumulators
 *      into telemetry entries of kind='model_intent' and emit them in one go.
 *
 * Hard constraints (§7.-1):
 *   - Returns void synchronously, never throws
 *   - A sink throwing on one entry does not affect the others
 *   - Empty intents / empty name are skipped directly
 */
import { writeToolCallRow, type ToolCallLogInput } from "../clickhouse.js";

/** Minimal description of a model tool-call intent. */
export interface ModelIntent {
  /** function.name / tool_use.name */
  name: string;
  /** function.arguments / JSON.stringify(tool_use.input) — original text, not truncated */
  arguments: string;
}

export interface ModelIntentInput {
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  agentSource: string;
  intents: ModelIntent[];
}

/**
 * Emit one model_intent telemetry entry for every tool_use accumulated in the current turn.
 * Empty arrays or empty names are skipped; a sink exception on one entry does not affect later ones.
 */
export function emitModelIntentTelemetry(
  input: ModelIntentInput,
  sink: (row: ToolCallLogInput) => void = writeToolCallRow,
): void {
  try {
    if (!input.intents || input.intents.length === 0) return;
    const ts = new Date().toISOString();
    for (const intent of input.intents) {
      if (!intent || !intent.name) continue; // empty name → partial SSE frame, skip
      try {
        sink({
          timestamp: ts,
          sessionKey: input.sessionKey,
          turnSeq: input.turnSeq,
          spaceId: input.spaceId,
          userId: input.userId,
          agentSource: input.agentSource,
          kind: "model_intent",
          bridgeSource: "",
          initiatedTool: intent.name,
          executedEndpoint: "",
          requestBody: intent.arguments ?? "",
          upstreamStatus: 0,
          elapsedMs: 0,
        });
      } catch {
        // One entry failed → continue with the next; telemetry never blocks business logic
      }
    }
  } catch {
    // Top-level fallback
  }
}
