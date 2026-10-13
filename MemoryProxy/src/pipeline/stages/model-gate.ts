/**
 * stages/model-gate.ts — model name validation + alias write-back (Phase 1).
 *
 * Extracted from the gate + alias semantics at handler.ts:660-677 / anthropicHandler.ts:664-682:
 *   - isCustomUpstream=false: use config.creditPricing to validate whether model_name is registered;
 *     not registered -> return a 400 result object (caller converts via protocol.buildErrorResponse)
 *   - isCustomUpstream=false: resolveModelId -> get model_id; if != requestedModel
 *     then write the alias back to body.model
 *   - isCustomUpstream=true: skip all (a custom upstream may not recognize the names in pricing)
 *
 * codex/wb originally had no gate (handler-audit bug B8); after the Phase 4.2/4.3 switch they keep zero regression via
 * StageGates.modelGate=false, and Phase 5.1 flips it to true to take effect.
 *
 * WARNING: does not include the instance upstream config fetch — that stage belongs to resolve-target,
 * handled by stages/resolve-target.ts. Here isCustomUpstream is assumed to be passed in by the caller.
 */

import type { ProxyConfig } from "../../types.js";
import { isModelInPricing, resolveModelId } from "../../pricing.js";

export type ModelGateOk = {
  ok: true;
  /** model_id after alias write-back (= requestedModel for a custom upstream) */
  modelId: string;
  /** true = body.model must be overwritten by the caller with modelId */
  aliasApplied: boolean;
};

export type ModelGateErr = {
  ok: false;
  reason: "unregistered_model";
  requestedModel: string;
};

export type ModelGateResult = ModelGateOk | ModelGateErr;

/**
 * Decide the modelId + whether alias write-back is needed.
 * After getting aliasApplied=true the caller must set body.model = result.modelId itself.
 * (The stage stays a pure function and does not modify the passed-in body.)
 */
export function stageModelGate(
  requestedModel: string,
  config: Pick<ProxyConfig, "creditPricing">,
  isCustomUpstream: boolean,
): ModelGateResult {
  // Custom upstream fully skips the pricing gate + alias — let body.model pass through to upstream unchanged
  if (isCustomUpstream) {
    return { ok: true, modelId: requestedModel, aliasApplied: false };
  }
  if (!isModelInPricing(config.creditPricing, requestedModel)) {
    return { ok: false, reason: "unregistered_model", requestedModel };
  }
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  return {
    ok: true,
    modelId,
    aliasApplied: modelId !== requestedModel,
  };
}

/**
 * OpenAI-style unregistered-model error body (identical to the original text at handler.ts:662).
 * Convenient for the protocol layer to reuse the same JSON structure.
 */
export function buildUnregisteredModelErrorBody(requestedModel: string): Record<string, unknown> {
  return {
    error: {
      message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
      type: "invalid_request_error",
      code: "model_not_found",
    },
  };
}
