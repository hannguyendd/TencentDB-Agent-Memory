/**
 * stages/build-upstream.ts — stage that builds upstream request headers/body (Phase 4).
 *
 * Extracted from 4 call sites of buildUpstreamHeaders / buildUpstreamBody / prepareUpstreamRequest:
 *   - handler.ts:1546-1566 (including the prepareUpstreamRequest compression extension)
 *   - anthropicHandler.ts:1463-1479
 *   - codexHandler.ts:1219 area
 *   - workbuddyHandler.ts:591 area
 *
 * This stage only does protocol-layer dispatch (protocol.buildUpstreamBody + buildUpstreamHeaders).
 * The compression extension of prepareUpstreamRequest is not wrapped here -- it needs a lot of handler-internal state
 * (messages/sessionKey/pipe/upstreamCall/userQuery/spaceId); when Phase 4.4/4.5 assembles things,
 * the caller calls prepareUpstreamRequest directly, then passes the result to this stage's buildUpstream.
 */

import type { ForwardTarget } from "../../guard-adapter.js";
import type { ProtocolStrategy } from "../strategies/protocol/types.js";

export interface BuildUpstreamStageInput {
  protocol: ProtocolStrategy;
  /** body — may already have been modified by prepareUpstreamRequest (decided by the caller) */
  body: Record<string, unknown>;
  target: ForwardTarget;
  clientHeaders: Headers;
  effectiveApiKey: string;
  sessionKey: string;
}

export interface BuildUpstreamStageResult {
  upstreamBody: unknown;
  upstreamHeaders: Record<string, string>;
}

/** Pure protocol-layer dispatch: no side effects, no IO. */
export function stageBuildUpstream(input: BuildUpstreamStageInput): BuildUpstreamStageResult {
  const upstreamBody = input.protocol.buildUpstreamBody(input.body, input.target);
  const upstreamHeaders = input.protocol.buildUpstreamHeaders(
    input.clientHeaders,
    input.effectiveApiKey,
    input.target,
    input.sessionKey,
  );
  return { upstreamBody, upstreamHeaders };
}
