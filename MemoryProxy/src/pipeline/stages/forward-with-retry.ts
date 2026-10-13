/**
 * stages/forward-with-retry.ts — full fetch + retry orchestration stage.
 *
 * Extracted from the ~150-line forwardWithRetry functions in each of the openai-chat + anthropic runners.
 * Differences are preserved via parameterization:
 *   - protocol: 'openai' | 'anthropic' — rate-limit tag
 *   - retryBodyBuilder: openai overrides model, anthropic leaves it unchanged
 *   - timeoutBehavior: openai uses gate > 0, anthropic is always on
 *   - debugOutboundMd5: openai/anthropic each have their own print format, a function is passed in by the caller
 *
 * WARNING: the debug dump body part stays in the caller (openai has it, anthropic does not), because it
 * needs access to each side's own copy of the upstream body/headers, and each dump file path is gated
 * by a debug env; not stage-ified.
 */

import type { ProxyConfig } from "../../types.js";
import type { ForwardTarget } from "../../guard-adapter.js";
import type { createPipeline } from "../../logger.js";
import { enforceRateLimit, isRateLimitExceededError } from "../../rate-limit/guard.js";

export interface ForwardWithRetryInput {
  target: ForwardTarget;
  upstreamHeaders: Record<string, string>;
  upstreamBody: Record<string, unknown>;
  originalBody: Record<string, unknown>;
  originalHeaders: Record<string, string>;
  pipe: ReturnType<typeof createPipeline>;
  forwardTimeoutMs: number;
  sessionKeyForDebug?: string;
  rateLimitContext?: { config: ProxyConfig; instanceId?: string };
  protocol: "openai" | "anthropic";
  /**
   * timeout gating semantics:
   *   - "gated": openai style, AbortSignal is set only when forwardTimeoutMs > 0
   *   - "always": anthropic style, always set AbortSignal.timeout
   */
  timeoutBehavior: "gated" | "always";
  /**
   * retry body builder function. openai version: `{...originalBody, model: retryTarget.model}`;
   * anthropic version: returns originalBody as is.
   */
  buildRetryBody: (originalBody: Record<string, unknown>, retryModel: string) => Record<string, unknown>;
}

export interface ForwardWithRetryResult {
  resp: Response;
  retried: boolean;
}

/**
 * Full forward+retry orchestration. When RateLimitExceededError is thrown the upper layer must catch it (convert to 429).
 * When Error("Upstream request failed") is thrown the caller must convert it to 502.
 */
export async function stageForwardWithRetry(
  input: ForwardWithRetryInput,
): Promise<ForwardWithRetryResult> {
  let upstreamResp: Response | undefined;
  let forwardFailed = false;

  const setTimeoutSignal = (init: RequestInit) => {
    if (input.timeoutBehavior === "always") {
      init.signal = AbortSignal.timeout(input.forwardTimeoutMs);
    } else if (input.forwardTimeoutMs > 0) {
      init.signal = AbortSignal.timeout(input.forwardTimeoutMs);
    }
  };

  if (input.rateLimitContext) {
    await enforceRateLimit({
      config: input.rateLimitContext.config,
      instanceId: input.rateLimitContext.instanceId,
      modelId: input.target.model,
      protocol: input.protocol,
    });
  }

  const primaryFetchOpts: RequestInit = {
    method: "POST",
    headers: input.upstreamHeaders,
    body: JSON.stringify(input.upstreamBody),
  };
  setTimeoutSignal(primaryFetchOpts);

  try {
    upstreamResp = await fetch(input.target.url, primaryFetchOpts);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      input.pipe.error("FORWARD", `Timeout after ${input.forwardTimeoutMs / 1000}s`);
    } else {
      input.pipe.error("FORWARD", err);
    }
    forwardFailed = true;
  }

  if (upstreamResp) {
    input.pipe.forwardDone(upstreamResp.status, upstreamResp.headers.get("x-request-id") ?? undefined);
  }

  const shouldRetry = input.target.retryTarget &&
    (forwardFailed || (upstreamResp && upstreamResp.status >= 400 && upstreamResp.status < 500));

  if (shouldRetry && input.target.retryTarget) {
    const retryTarget = input.target.retryTarget;
    const reason = forwardFailed ? "timeout/error" : `${upstreamResp!.status}`;
    input.pipe.info("RETRY", `Routed model failed (${reason}), ${
      input.protocol === "anthropic"
        ? `retrying with ${retryTarget.model}`
        : `retryUrl=${retryTarget.url} model=${retryTarget.model}`
    }`);

    const retryBody = input.buildRetryBody(input.originalBody, retryTarget.model);
    const retryHeaders: Record<string, string> = { ...input.originalHeaders };
    retryHeaders["content-type"] = "application/json";
    if (input.sessionKeyForDebug) {
      retryHeaders["x-vertex-ai-session-id"] = input.sessionKeyForDebug;
    }

    try {
      if (input.rateLimitContext) {
        await enforceRateLimit({
          config: input.rateLimitContext.config,
          instanceId: input.rateLimitContext.instanceId,
          modelId: retryTarget.model,
          protocol: input.protocol,
        });
      }
      const retryFetchOpts: RequestInit = {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(retryBody),
      };
      setTimeoutSignal(retryFetchOpts);
      upstreamResp = await fetch(retryTarget.url, retryFetchOpts);
      if (upstreamResp.ok) {
        input.pipe.info("RETRY_SUCCESS", `Retry returned ${upstreamResp.status}`);
      } else {
        input.pipe.error("RETRY_FAILED", `Retry returned ${upstreamResp.status}`);
      }
      return { resp: upstreamResp, retried: true };
    } catch (retryErr: unknown) {
      if (isRateLimitExceededError(retryErr)) throw retryErr;
      if (retryErr instanceof DOMException && retryErr.name === "TimeoutError") {
        input.pipe.error("RETRY_FORWARD", `Timeout after ${input.forwardTimeoutMs / 1000}s`);
      } else {
        input.pipe.error("RETRY_FORWARD", retryErr);
      }
      throw new Error("Upstream request failed");
    }
  }

  if (forwardFailed && !shouldRetry) {
    throw new Error("Upstream request failed");
  }

  if (!upstreamResp) {
    throw new Error("No upstream response available");
  }

  return { resp: upstreamResp, retried: false };
}
