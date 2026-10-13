/**
 * OpenAI Responses ProtocolStrategy — shared by codex + workbuddy (Phase 2).
 *
 * Legacy entry points: codexHandler.ts::handleCodexEndpoint + workbuddyHandler.ts::handleWorkbuddyEndpoint.
 *
 * Phase 2 only fills in the pure-function skeleton; Phase 4 adds:
 *   - buildUpstreamBody (including the synthetic body composition of codex/wb respectively)
 *   - createStreamTap (tee() + coroutine, incremental version of parseResponsesSseStream)
 *   - buildMemResponse (SSE form response or text)
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";
import type { ForwardTarget } from "../../../guard-adapter.js";
import { parseResponsesSseStream } from "./stream-parsers.js";

export const responsesProtocol: ProtocolStrategy = {
  name: "responses",

  extractMessages(body): unknown[] {
    // Responses API: body.input rather than body.messages
    return Array.isArray(body.input) ? body.input as unknown[] : [];
  },

  extractUserQuery(_body, _headers): string {
    return "";
  },

  applySessionContext(body, block): void {
    // Responses protocol: session context is synthesized into body.input[0] (synthetic input item)
    // see common/codex-injection.ts / common/workbuddy-injection.ts.
    // Unified when Phase 4 goes through injection/pipeline; this stub does not modify the body.
    if (!block) return;
    // keep the body reference unchanged (contract: no stub side effects)
  },

  applyInjection(_body, _block): void {},

  buildUpstreamBody(body, target: ForwardTarget): unknown {
    if (target.bodyOverrides) {
      return { ...body, ...target.bodyOverrides };
    }
    return body;
  },

  buildUpstreamHeaders(_clientHeaders, _effectiveKey, _target, _sessionKey): Record<string, string> {
    // Phase 4: SKIP_REQUEST_HEADERS_WITH_INTERNAL + Bearer (Responses keeps using openai auth)
    return {};
  },

  createStreamTap(_ctx: PipelineContext, _upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    throw new Error("responsesProtocol.createStreamTap not implemented yet (Phase 4)");
  },

  parseNonStreamResponse(text): NonStreamParseResult {
    // Responses is usually a stream, but non-stream (response object) is also supported
    try {
      const respJson = JSON.parse(text) as Record<string, unknown>;
      const usage = (respJson.usage && typeof respJson.usage === "object")
        ? respJson.usage as Record<string, unknown>
        : undefined;
      // response.output = [{type:"message",content:[{type:"output_text",text}]}, ...]
      const output = respJson.output as Array<Record<string, unknown>> | undefined;
      let assistantText: string | undefined;
      if (Array.isArray(output)) {
        const parts: string[] = [];
        for (const item of output) {
          if (item.type === "message") {
            const content = item.content as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c.type === "output_text" && typeof c.text === "string") {
                  parts.push(c.text);
                }
              }
            }
          }
        }
        if (parts.length > 0) assistantText = parts.join("");
      }
      const upstreamRequestId = typeof respJson.id === "string" ? respJson.id : undefined;
      return { usage, assistantText, upstreamRequestId };
    } catch {
      // upstream returned SSE fallback
      const parsed = parseResponsesSseStream(text);
      return {
        usage: parsed.usage ?? undefined,
        assistantText: parsed.assistantText || undefined,
        upstreamRequestId: parsed.responseId ?? undefined,
      };
    }
  },

  buildMemResponse(_text: string, _opts: MemResponseOpts): Response {
    throw new Error("responsesProtocol.buildMemResponse not implemented yet (Phase 4)");
  },

  buildErrorResponse(msg: string, status: number): Response {
    // Responses envelope: {error: {type, message}}
    return new Response(
      JSON.stringify({
        error: {
          type: status === 401 ? "authentication_error" : "invalid_request_error",
          message: msg,
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  },

  buildLangfuseInput(body): unknown {
    // Phase 4: buildCodexLangfuseInput / buildWorkbuddyLangfuseInput
    return { input: body.input };
  },
};
