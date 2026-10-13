/**
 * Pure SSE parsing functions that extract usage / assistant text / tool_call intents per protocol.
 *
 * Extracted from the stream tap internals of the 3 handlers and turned into pure functions to facilitate:
 *   1. Phase 2 fixture tests (blueprint-review §3 hard gate)
 *   2. Reuse by the tap coroutine when Phase 4 assembles protocol.createStreamTap
 *
 * Warning: difference from the old handlers: the old implementation accumulated incrementally over the stream (maintaining state),
 * whereas the functions here "parse the whole SSE text in one pass", used for:
 *   - fixture tests (input the full SSE text, assert the final usage / assistantText)
 *   - non-stream fallback (upstream returns a stream but the client is non-stream)
 *
 * The incremental version (for createStreamTap) will be extracted in Phase 4; for now the semantics are pinned down first.
 */

// ── OpenAI Chat Completions ──────────────────────────────────────────────

/**
 * Extract usage from the whole openai SSE text (last-write-wins).
 * Reuses the handler.ts:228 extractSseUsage semantics.
 */
export function extractOpenaiSseUsage(sseText: string): Record<string, unknown> | null {
  let lastUsage: Record<string, unknown> | null = null;
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      if (evt.usage && typeof evt.usage === "object") {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    } catch {
      // ignore malformed line
    }
  }
  return lastUsage;
}

/**
 * Accumulate assistant text (choices[0].delta.content) from the whole openai SSE text.
 */
export function extractOpenaiSseAssistantText(sseText: string): string {
  let text = "";
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const choices = evt.choices as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const delta = choices[0]?.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === "string") {
        text += delta.content;
      }
    } catch {
      // ignore
    }
  }
  return text;
}

// ── Anthropic Messages ──────────────────────────────────────────────────

export interface AnthropicStreamParsed {
  usage: Record<string, unknown>;
  assistantText: string;
  /** accumulation of tool_use blocks (for emitModelIntentTelemetry) */
  toolUses: Array<{ name: string; inputJson: string }>;
}

/**
 * Parse Anthropic SSE (event: xxx\ndata: {...}\n\n), extracting usage / text / tool_uses in one pass.
 * Reuses the event switch at anthropicHandler.ts:2400+.
 */
export function parseAnthropicSseStream(sseText: string): AnthropicStreamParsed {
  const usage: Record<string, unknown> = {};
  let assistantText = "";
  const toolUseByIndex = new Map<number, { name: string; inputJson: string }>();

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr) continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const evtType = evt.type as string;
      if (evtType === "message_start") {
        const message = evt.message as Record<string, unknown> | undefined;
        if (message?.usage && typeof message.usage === "object") {
          Object.assign(usage, message.usage);
        }
      } else if (evtType === "message_delta") {
        if (evt.usage && typeof evt.usage === "object") {
          Object.assign(usage, evt.usage);
        }
      } else if (evtType === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          assistantText += delta.text;
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const idx = evt.index as number | undefined;
          if (typeof idx === "number") {
            const acc = toolUseByIndex.get(idx);
            if (acc) acc.inputJson += delta.partial_json;
          }
        }
      } else if (evtType === "content_block_start") {
        const block = evt.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          const idx = evt.index as number | undefined;
          if (typeof idx === "number") {
            toolUseByIndex.set(idx, { name: (block.name as string) ?? "", inputJson: "" });
          }
        }
      }
    } catch {
      // ignore malformed
    }
  }

  return {
    usage,
    assistantText,
    toolUses: Array.from(toolUseByIndex.values()),
  };
}

// ── OpenAI Responses (codex / workbuddy) ────────────────────────────────

export interface ResponsesStreamParsed {
  usage: Record<string, unknown> | null;
  assistantText: string;
  /** accumulation of function_call (name + arguments) */
  functionCalls: Array<{ name: string; arguments: string }>;
  /** response.id at the end of the response (for backfilling upstreamRequestId) */
  responseId: string | null;
}

/**
 * Parse openai Responses API SSE; event types:
 *   - response.output_text.delta: accumulate text
 *   - response.output_item.done (function_call): append to functionCalls
 *   - response.completed: response.usage + response.id
 * Reuses the event table at codexHandler.ts:1520 + the completed branch at 1695.
 */
export function parseResponsesSseStream(sseText: string): ResponsesStreamParsed {
  let usage: Record<string, unknown> | null = null;
  let assistantText = "";
  const functionCalls: Array<{ name: string; arguments: string }> = [];
  let responseId: string | null = null;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr) continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const evtType = evt.type as string;
      if (evtType === "response.output_text.delta") {
        const delta = evt.delta;
        if (typeof delta === "string") {
          assistantText += delta;
        }
      } else if (evtType === "response.output_item.done") {
        const item = evt.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          functionCalls.push({
            name: (item.name as string) ?? "",
            arguments: (item.arguments as string) ?? "",
          });
        }
      } else if (evtType === "response.completed") {
        const response = evt.response as Record<string, unknown> | undefined;
        if (response?.usage && typeof response.usage === "object") {
          usage = response.usage as Record<string, unknown>;
        }
        if (typeof response?.id === "string") {
          responseId = response.id;
        }
      }
    } catch {
      // ignore
    }
  }

  return { usage, assistantText, functionCalls, responseId };
}
