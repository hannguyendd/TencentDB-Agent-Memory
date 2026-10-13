/**
 * Utility ProtocolStrategy (Phase 4) — count_tokens / embeddings / completions /
 * moderations endpoints.
 *
 * Legacy entry point: auxiliaryHandler.ts::handleAuxiliaryEndpoint.
 * blueprint-review §7.1 renamed "auxiliary" to "utility" to disambiguate.
 *
 * Has auth + systemUser + credit report; no session-init / injection / model gate /
 * opik / langfuse trace. The body is passed through as is.
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";

const NOT_APPLICABLE = "utility protocol does not implement this method";

export const utilityProtocol: ProtocolStrategy = {
  name: "utility",
  extractMessages(body): unknown[] {
    // utility endpoints may have messages (count_tokens) or input (embeddings)
    if (Array.isArray(body.messages)) return body.messages as unknown[];
    if (Array.isArray(body.input)) return body.input as unknown[];
    return [];
  },
  extractUserQuery(): string { return ""; },
  applySessionContext(): void { /* utility endpoints do not inject */ },
  applyInjection(): void { /* utility endpoints do not inject */ },
  buildUpstreamBody(body): unknown { return body; },
  buildUpstreamHeaders(): Record<string, string> { return {}; },
  createStreamTap(_ctx: PipelineContext, upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    return { clientStream: upstreamBody, outcome: Promise.resolve({}) };
  },
  parseNonStreamResponse(text): NonStreamParseResult {
    try {
      const respJson = JSON.parse(text) as Record<string, unknown>;
      const usage = (respJson.usage && typeof respJson.usage === "object")
        ? respJson.usage as Record<string, unknown>
        : undefined;
      return { usage, upstreamRequestId: typeof respJson.id === "string" ? respJson.id : undefined };
    } catch {
      return {};
    }
  },
  buildMemResponse(_text: string, _opts: MemResponseOpts): Response {
    throw new Error(NOT_APPLICABLE);
  },
  buildErrorResponse(msg, status): Response {
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "content-type": "application/json" },
    });
  },
  buildLangfuseInput(): unknown { return null; },
};
