/**
 * stages/response-tail-fix.ts — client-specific response tail-byte compatibility layer.
 *
 * The upstream-merged a08d67e9 dsh SSE strict parser fix was originally inlined in anthropicHandler.ts;
 * after migrating to the pipeline it should be extracted into a stage per the refactoring standard so all runners can reuse the same implementation,
 * instead of being defined in the anthropic runner where openai-chat cannot reuse it in the future.
 *
 * Currently there is only one rule (dsh v0.2 needs SSE to be padded with a trailing \n); if other client quirks appear in the future,
 * extend them here (add a case), and the caller only needs to call stageResponseTailFix().
 */

/**
 * Client-specific SSE tail-byte patch.
 *
 * The only rule currently:
 *   agentSource === "dsh" + isStream + response.body non-empty ->
 *     append a \n at the end of the stream so the last event satisfies the SSE `\n\n` termination spec.
 *
 * Background (a08d67e9):
 *   The SSE parser of the dsh v0.2 llm-deepseek-api-key adapter (source
 *   `packages/llm/llm-deepseek/src/translate.ts:165`) strictly checks `\n\n` to end an event,
 *   while the proxy's mem-command shared response builder (mem-command/response-builder.ts)
 *   only appends one `\n` via `lines.join('\n')` at the end, so dsh never receives message_stop -> STREAM_CLOSED.
 *   The CC / Anthropic official SDK parsers are lenient and a single `\n` still gets the terminal event, so
 *   the shared builder must not be changed (changing it would affect CC); this stage pads one byte for dsh only.
 *
 * Zero impact on CC / CB / WB / opencode / codex (blocked by the hard gate on the first line).
 */
export function stageResponseTailFix(
  response: Response,
  agentSource: string,
  isStream: boolean,
): Response {
  if (agentSource !== "dsh" || !isStream || !response.body) return response;
  const src = response.body;
  const patched = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = src.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        // append the 2nd trailing `\n` so the last event satisfies the SSE `\n\n` termination spec
        controller.enqueue(new TextEncoder().encode("\n"));
      } catch (err) {
        controller.error(err);
        return;
      } finally {
        reader.releaseLock();
      }
      controller.close();
    },
  });
  const headers = new Headers(response.headers);
  return new Response(patched, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
