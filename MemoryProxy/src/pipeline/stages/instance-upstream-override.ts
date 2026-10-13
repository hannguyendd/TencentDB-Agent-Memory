/**
 * stages/instance-upstream-override.ts — instance upstream override application stage.
 *
 * Extracted from the identical ~18-line override application block in the openai-chat + anthropic runners:
 *   1. routedToCheapModel gate (cost-guard already routed to cheap -> do not apply override)
 *   2. kind=override -> replace target.url / effectiveApiKey / body.model / modelId
 *   3. skipCreditReport=true (custom upstream is paid by the user, not billed to the platform)
 *
 * This is a stateful mutation (body/target change); the stage returns new values for the caller to apply.
 */

import type { Resolution } from "../../instance-upstream-cache.js";
import { joinUrl } from "../../guard-adapter.js";

export interface InstanceUpstreamOverrideInput {
  earlyConvResolution: Resolution;
  target: { url: string; routedFrom: string };
  forwardEndpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
  modelId: string;
  /**
   * The original request path (c.req.path). When passed, the override URL is smartly joined via joinUrl(base, path),
   * so an anthropic base without /v1 still works (b11bf612 GLM /v1 fix); it also fixes the double-append of the old
   * hand-concatenation when the base already contains the full endpoint.
   *
   * When not passed, falls back to the old hand-concatenation behavior (base + forwardEndpoint), keeping backward compatibility.
   */
  requestPath?: string;
}

export interface InstanceUpstreamOverrideResult {
  /** whether override was triggered — if false all other fields are invalid */
  applied: boolean;
  /** new target.url (only when applied=true) */
  newTargetUrl: string;
  /** new effectiveApiKey (only when applied=true; custom_passthrough -> the original apiKey) */
  newEffectiveApiKey: string;
  /** new modelId (only non-empty when applied=true and the row has model_id; otherwise = the original modelId) */
  newModelId: string;
  /** whether body.model was modified (only when applied and row.model_id) */
  bodyModelUpdated: boolean;
  /** custom upstream is paid by the user, credit skipped */
  skipCreditReport: boolean;
}

export function stageInstanceUpstreamOverride(
  input: InstanceUpstreamOverrideInput,
): InstanceUpstreamOverrideResult {
  const { earlyConvResolution, target, forwardEndpoint, apiKey, modelId } = input;
  const routedToCheapModel = target.routedFrom !== "";

  if (routedToCheapModel || earlyConvResolution.kind !== "override") {
    return {
      applied: false,
      newTargetUrl: target.url,
      newEffectiveApiKey: apiKey,
      newModelId: modelId,
      bodyModelUpdated: false,
      skipCreditReport: false,
    };
  }

  const row = earlyConvResolution.row;
  // Prefer joinUrl(base, requestPath) smart joining (b11bf612): an anthropic base without /v1 is auto-completed,
  // a base that already contains the full endpoint returns early without double-append. When requestPath is not passed, fall back to the old hand-concatenation for compatibility.
  const newTargetUrl = input.requestPath
    ? joinUrl(row.base_url, input.requestPath)
    : `${row.base_url.replace(/\/+$/, "")}${forwardEndpoint}`;
  const newEffectiveApiKey = row.mode === "custom_unified"
    ? row.api_key
    : apiKey; // custom_passthrough
  const bodyModelUpdated = !!row.model_id;
  const newModelId = row.model_id || modelId;

  return {
    applied: true,
    newTargetUrl,
    newEffectiveApiKey,
    newModelId,
    bodyModelUpdated,
    skipCreditReport: true,
  };
}
