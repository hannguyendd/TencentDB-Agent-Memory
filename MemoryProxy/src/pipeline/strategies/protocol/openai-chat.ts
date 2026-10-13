/**
 * OpenAI Chat Completions ProtocolStrategy (Phase 2).
 *
 * Covers the protocol used by the codebuddy / dsh / opencode / pi / default agents.
 * Legacy entry point: handler.ts::handleChatCompletions.
 *
 * Warning: this file currently fills in only 3 kinds of methods:
 *   1. pure functions (extractMessages / extractUserQuery / applyInjection)
 *   2. buildErrorResponse (openai envelope)
 *   3. delegation to stream-parsers (parseNonStreamResponse)
 *
 * Methods not yet filled in (to be added when Phase 4 assembles):
 *   - buildUpstreamBody: needs target already resolved + prepareUpstreamRequest logic
 *   - buildUpstreamHeaders: needs effectiveApiKey + SKIP_REQUEST_HEADERS
 *   - createStreamTap: needs the full ctx (lf/tdai/opik/cfq) — finalized in Phase 4
 *   - buildMemResponse / buildLangfuseInput: many parameters, added on demand in Phase 4
 *
 * So this strategy is currently incomplete and cannot be used directly by runPipeline; it is a transitional form of
 * "types.ts contract + first batch of reusable pure functions placed together". All methods will be filled in before Phase 4.
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";
import type { ForwardTarget } from "../../../guard-adapter.js";
import { extractOpenaiSseUsage, extractOpenaiSseAssistantText } from "./stream-parsers.js";

/** OpenAI Chat protocol strategy — Phase 2 skeleton with pure helpers. */
export const openaiChatProtocol: ProtocolStrategy = {
  name: "openai-chat",

  extractMessages(body): unknown[] {
    return Array.isArray(body.messages) ? body.messages as unknown[] : [];
  },

  extractUserQuery(_body, _headers): string {
    // The actual implementation in handler.ts uses resolveLatestUserQuery + resolveAgentProfile to get the latest user input;
    // wired in when Phase 4 assembles. The current stub returns empty — callers that need it should bridge via
    // resolveLatestUserQuery in stages/observability.ts.
    return "";
  },

  applySessionContext(body, block): void {
    // openai protocol: session context is appended to the tail of messages[0].content
    // (original handler logic, see the apply implementation in injection/agents).
    // When Phase 4 hooks into injection/pipeline it will go through pipeline.process uniformly; the stub is kept here.
    const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
    if (messages.length === 0 || !block) return;
    const first = messages[0];
    if (typeof first.content === "string") {
      first.content = `${first.content}\n${block}`;
    }
  },

  applyInjection(_body, _block): void {
    // Phase 4 hooks into injection/pipeline (injection is already an independent module, no protocol customization needed)
  },

  buildUpstreamBody(body, target: ForwardTarget): unknown {
    // handler.ts:255 buildUpstreamBody semantics: the body directly, or body + target.bodyOverrides
    if (target.bodyOverrides) {
      return { ...body, ...target.bodyOverrides };
    }
    return body;
  },

  buildUpstreamHeaders(_clientHeaders, _effectiveKey, _target, _sessionKey): Record<string, string> {
    // Phase 4 assembles the full version; needs SKIP_REQUEST_HEADERS_HOP_BY_HOP + target.authHeaders
    return {};
  },

  createStreamTap(_ctx: PipelineContext, _upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    throw new Error("openaiChatProtocol.createStreamTap not implemented yet (Phase 4)");
  },

  parseNonStreamResponse(text): NonStreamParseResult {
    try {
      const respJson = JSON.parse(text) as Record<string, unknown>;
      const usage = (respJson.usage && typeof respJson.usage === "object")
        ? respJson.usage as Record<string, unknown>
        : undefined;
      const choices = respJson.choices as Array<Record<string, unknown>> | undefined;
      const first = choices?.[0];
      const message = first?.message as Record<string, unknown> | undefined;
      const assistantText = typeof message?.content === "string" ? message.content : undefined;
      const upstreamRequestId = typeof respJson.id === "string" ? respJson.id : undefined;
      return { usage, assistantText, upstreamRequestId };
    } catch {
      // upstream returned non-JSON → let the stream helper fall back
      return {
        usage: undefined,
        assistantText: extractOpenaiSseAssistantText(text) || undefined,
        upstreamRequestId: undefined,
      };
    }
  },

  buildMemResponse(_text: string, _opts: MemResponseOpts): Response {
    throw new Error("openaiChatProtocol.buildMemResponse not implemented yet (Phase 4)");
  },

  buildErrorResponse(msg: string, status: number): Response {
    // error envelope in handler.ts: `{error: {message, type, code}}`
    // also compatible with the simple `{error: msg}` form (401 auth failed uses the simple form) — use the conservative, generic parameter form
    return new Response(
      JSON.stringify({ error: { message: msg, type: "invalid_request_error" } }),
      { status, headers: { "content-type": "application/json" } },
    );
  },

  buildLangfuseInput(body): unknown {
    // reuse the handler.ts flattenMessagesForOpik semantics; import directly in Phase 4
    return Array.isArray(body.messages) ? body.messages : [];
  },
};
