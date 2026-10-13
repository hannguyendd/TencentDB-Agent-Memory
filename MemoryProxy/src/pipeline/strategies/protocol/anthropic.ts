/**
 * Anthropic Messages ProtocolStrategy (Phase 2).
 *
 * Covers the protocol used by the claude-code agent. Legacy entry point: anthropicHandler.ts::handleAnthropicMessages.
 *
 * Phase 2 only fills in the pure-function skeleton; Phase 4 adds buildUpstreamBody (including sanitizeThinkingBlocks)
 * / createStreamTap (including the createSseThinkingFixStream middleware) / the sanitizeForRetry hook.
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";
import type { ForwardTarget } from "../../../guard-adapter.js";
import { parseAnthropicSseStream } from "./stream-parsers.js";

export const anthropicProtocol: ProtocolStrategy = {
  name: "anthropic",

  extractMessages(body): unknown[] {
    return Array.isArray(body.messages) ? body.messages as unknown[] : [];
  },

  extractUserQuery(_body, _headers): string {
    return "";
  },

  applySessionContext(body, block): void {
    // anthropic protocol: session context is appended to body.system (the original anthropicHandler
    // went through the apply of injection/agents/claude-code, see injection/adapters/anthropic-body.ts).
    // Phase 4 keeps the same semantics when going through injection/pipeline — this stub only holds a type-contract placeholder.
    if (!block) return;
    const existing = typeof body.system === "string" ? body.system : "";
    body.system = existing ? `${existing}\n${block}` : block;
  },

  applyInjection(_body, _block): void {
    // Phase 4 hooks into injection/pipeline
  },

  buildUpstreamBody(body, target: ForwardTarget): unknown {
    // Phase 4: needs sanitizeThinkingBlocks + target.bodyOverrides merge.
    // The current stub only merges bodyOverrides (same semantics as the handler openai for the non-thinking path).
    if (target.bodyOverrides) {
      return { ...body, ...target.bodyOverrides };
    }
    return body;
  },

  sanitizeForRetry(body): Record<string, unknown> {
    // Phase 4: needs to really call sanitizeThinkingBlocks (anthropicHandler.ts:279+).
    // The current stub returns a shallow copy; the contract signals that "the anthropic-only retry sanitize hook exists".
    return { ...body };
  },

  buildUpstreamHeaders(_clientHeaders, _effectiveKey, _target, _sessionKey): Record<string, string> {
    // Phase 4: SKIP_REQUEST_HEADERS_WITH_INTERNAL + x-api-key instead of Bearer
    return {};
  },

  createStreamTap(_ctx: PipelineContext, _upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    throw new Error("anthropicProtocol.createStreamTap not implemented yet (Phase 4)");
  },

  parseNonStreamResponse(text): NonStreamParseResult {
    try {
      const respJson = JSON.parse(text) as Record<string, unknown>;
      const usage = (respJson.usage && typeof respJson.usage === "object")
        ? respJson.usage as Record<string, unknown>
        : undefined;
      // anthropic non-stream: content is a blocks array [{type:"text",text:"..."}]
      const content = respJson.content as Array<Record<string, unknown>> | undefined;
      let assistantText: string | undefined;
      if (Array.isArray(content)) {
        assistantText = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("");
      }
      const upstreamRequestId = typeof respJson.id === "string" ? respJson.id : undefined;
      return { usage, assistantText, upstreamRequestId };
    } catch {
      // if upstream returns SSE rather than JSON, fall back to SSE parsing
      const parsed = parseAnthropicSseStream(text);
      return {
        usage: Object.keys(parsed.usage).length ? parsed.usage : undefined,
        assistantText: parsed.assistantText || undefined,
        upstreamRequestId: undefined,
      };
    }
  },

  buildMemResponse(_text, _opts: MemResponseOpts): Response {
    throw new Error("anthropicProtocol.buildMemResponse not implemented yet (Phase 4)");
  },

  buildErrorResponse(msg: string, status: number): Response {
    // Anthropic envelope: {type:"error", error: {type, message}}
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: status === 401 ? "authentication_error" : "invalid_request_error",
          message: msg,
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  },

  buildLangfuseInput(body): unknown {
    // Phase 4: use flattenAnthropicMessagesForOpik (present in anthropicHandler.ts)
    return { system: body.system, messages: body.messages };
  },
};
