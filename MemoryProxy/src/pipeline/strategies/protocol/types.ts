/**
 * ProtocolStrategy — strategy interface split by protocol (openai-chat / anthropic / responses / passthrough /
 * utility).
 *
 * The protocol-dimension differences across the 6 handlers are concentrated in:
 *   1. body structure (messages vs input, location of the system field)
 *   2. stream parsing (different SSE event structures)
 *   3. buildUpstreamBody (bodyOverrides / stream_options / sanitizeThinkingBlocks)
 *   4. buildUpstreamHeaders (Bearer vs x-api-key)
 *   5. error envelope (OpenAI / Anthropic / Responses)
 *   6. mem/form response format
 *
 * The concrete implementation is in Phase 2 (v2 §4 Phase 2). types.ts only defines the contract.
 */

import type { PipelineContext } from "../../context.js";
import type { ForwardTarget } from "../../../guard-adapter.js";

export type ProtocolName =
  | "openai-chat"
  | "anthropic"
  | "responses"
  | "passthrough"
  | "utility";

/** Output of the stream tap (usage / assistantText / upstreamRequestId, etc.) */
export interface StreamOutcome {
  usage?: Record<string, unknown>;
  assistantText?: string;
  upstreamRequestId?: string;
  toolCalls?: unknown[];
}

/** Non-stream response parsing result */
export interface NonStreamParseResult {
  usage?: Record<string, unknown>;
  assistantText?: string;
  upstreamRequestId?: string;
}

/** Parameters for generating a mem command response */
export interface MemResponseOpts {
  isStream: boolean;
  modelId: string;
  sessionKey: string;
}

export interface ProtocolStrategy {
  readonly name: ProtocolName;

  /** Extract a unified messages array from the raw body (openai/anthropic: body.messages; responses: body.input) */
  extractMessages(body: Record<string, unknown>): unknown[];

  /** Extract the last user input text from body/headers */
  extractUserQuery(body: Record<string, unknown>, headers: Record<string, string>): string;

  /** Inject the session context block into body (location differs per protocol) */
  applySessionContext(body: Record<string, unknown>, block: string): void;

  /** Inject assets (skill/knowledge/memory) into body */
  applyInjection(body: Record<string, unknown>, block: string): void;

  /** Build the upstream request body (protocol-specific: bodyOverrides / stream_options / sanitizeThinkingBlocks, etc.) */
  buildUpstreamBody(body: Record<string, unknown>, target: ForwardTarget): unknown;

  /** Build the upstream request headers (Bearer vs x-api-key) */
  buildUpstreamHeaders(
    clientHeaders: Headers,
    effectiveKey: string,
    target: ForwardTarget,
    sessionKey: string,
  ): Record<string, string>;

  /**
   * anthropic only: the retry body needs thinking blocks sanitized a second time.
   * Other protocols do not implement this method.
   */
  sanitizeForRetry?(body: Record<string, unknown>): Record<string, unknown>;

  /**
   * Build the stream tap: fork one copy of the stream to the client and parse usage/text/tools from the other in the background.
   *
   * Warning: blueprint §3.3 red line 6: differences in each protocol's concurrency model (inline TransformStream vs
   * tee()+coroutine) must be encapsulated inside this method and not exposed to stages.
   *
   * Warning: addendum §4.1: the CFQ fallback path must be kept here (preparedStats.cfqFallback).
   */
  createStreamTap(ctx: PipelineContext, upstreamBody: ReadableStream<Uint8Array>): {
    clientStream: ReadableStream<Uint8Array>;
    outcome: Promise<StreamOutcome>;
  };

  /** Non-stream response parsing */
  parseNonStreamResponse(text: string): NonStreamParseResult;

  /** Build the mem command response (return format differs per protocol) */
  buildMemResponse(text: string, opts: MemResponseOpts): Response;

  /** Build the error response envelope */
  buildErrorResponse(msg: string, status: number): Response;

  /** Build the langfuse input (messages structure differs per protocol) */
  buildLangfuseInput(body: Record<string, unknown>): unknown;
}
