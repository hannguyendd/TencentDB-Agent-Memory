/**
 * stages/forward.ts — forward + retry stage (Phase 4).
 *
 * Extracted from handler.ts + anthropic's forwardWithRetry (including the retryTarget branch) /
 * the single fetch of codex + wb (no retry).
 *
 * blueprint §3.1 medium risk: anthropic retry needs sanitizeForRetry(body); openai retry
 * directly uses `{...originalBody, model: retryTarget.model}`. This stage supports both styles through the
 * optional hook protocol.sanitizeForRetry?.().
 *
 * codex/wb's stageGates.forwardRetry=false + forwardTimeout=false -> single
 * fetch with no timeout (100% equivalent to the old codex/wb; Phase 5 opt-in fixes bug B9).
 */

import type { ForwardTarget } from "../../guard-adapter.js";
import type { ProtocolStrategy } from "../strategies/protocol/types.js";

export interface ForwardStageInput {
  target: ForwardTarget;
  protocol: ProtocolStrategy;
  upstreamUrl: string;
  upstreamHeaders: Record<string, string>;
  upstreamBody: unknown;
  originalBody: Record<string, unknown>;
  /** 0 = no timeout; when the forwardTimeout gate is on, the caller passes config.server.forwardTimeoutMs, when off passes 0 */
  forwardTimeoutMs: number;
  /** pass false when stageGates.forwardRetry=false, the old codex/wb behavior */
  retryEnabled: boolean;
}

export interface ForwardStageResult {
  response: Response;
  retried: boolean;
}

export async function stageForward(input: ForwardStageInput): Promise<ForwardStageResult> {
  const primaryResp = await fetchWithOptionalTimeout(
    input.upstreamUrl,
    input.upstreamHeaders,
    input.upstreamBody,
    input.forwardTimeoutMs,
  );

  // retry gate — only triggers when retryTarget exists + 4xx + retryEnabled
  if (
    input.retryEnabled
    && input.target.retryTarget
    && primaryResp.status >= 400
    && primaryResp.status < 500
  ) {
    const retryTarget = input.target.retryTarget;
    // retry body: openai = {...orig, model:retryTarget.model}; anthropic additionally goes through sanitizeForRetry
    let retryBody: Record<string, unknown> = { ...input.originalBody, model: retryTarget.model };
    if (input.protocol.sanitizeForRetry) {
      retryBody = input.protocol.sanitizeForRetry(retryBody);
    }
    try {
      const retryResp = await fetchWithOptionalTimeout(
        retryTarget.url,
        // retry headers use target.authHeaders (protocol-specific), reusing content-type etc. from the main headers
        { ...input.upstreamHeaders, ...(retryTarget.authHeaders ?? {}) },
        retryBody,
        input.forwardTimeoutMs,
      );
      return { response: retryResp, retried: true };
    } catch (err) {
      console.warn(`[stage-forward] retry failed: ${(err as Error).message}`);
      return { response: primaryResp, retried: false };
    }
  }

  return { response: primaryResp, retried: false };
}

async function fetchWithOptionalTimeout(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
  if (timeoutMs > 0) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  return fetch(url, init);
}
