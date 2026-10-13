/**
 * Passthrough ProtocolStrategy (Phase 4) — /direct/* pure passthrough.
 *
 * Legacy entry point: directHandler.ts::handleDirectPassthrough.
 * No auth / injection / mem commands / session-init / model gate.
 * Only URL rewrite + header stripping + fetch + returning the response directly.
 *
 * Most ProtocolStrategy methods do not apply — throw is kept so callers discover misuse early.
 */

import type {
  ProtocolStrategy,
  NonStreamParseResult,
  MemResponseOpts,
  StreamOutcome,
} from "./types.js";
import type { PipelineContext } from "../../context.js";

const NOT_APPLICABLE = "passthrough protocol does not implement this method";

export const passthroughProtocol: ProtocolStrategy = {
  name: "passthrough",
  extractMessages(): unknown[] { return []; },
  extractUserQuery(): string { return ""; },
  applySessionContext(): void { /* noop */ },
  applyInjection(): void { /* noop */ },
  buildUpstreamBody(body): unknown { return body; },
  buildUpstreamHeaders(): Record<string, string> { return {}; },
  createStreamTap(_ctx: PipelineContext, upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  } {
    // passthrough — client stream = upstream stream (no tap)
    return {
      clientStream: upstreamBody,
      outcome: Promise.resolve({}),
    };
  },
  parseNonStreamResponse(): NonStreamParseResult { return {}; },
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
