/**
 * stages/credit.ts — billing report stage (Phase 1).
 *
 * Extracted from the complete "report +
 * failure header + failure raw" logic at handler.ts:1972-2006 / anthropicHandler.ts:1896-1930; the two are 100% semantically identical.
 *
 * codex/wb originally lacked it (handler-audit bug B2 P0); after Phase 5.6 opt-in it goes through this stage
 * and is filled in automatically; before that, when codex/wb went through the pipeline stageGates.creditReport=false kept zero regression.
 *
 * WARNING: relevant to both stream/non-stream: called once after the stream completes, called
 * once after a non-stream response is received, each covered separately (the original handler also had these as two separate call sites).
 * This stage does not hardcode "stream" vs "non-stream"; the caller distinguishes them via the event parameter.
 */

import type { ProxyConfig } from "../../types.js";
import { tryReportCreditFromPath } from "../../credit-reporter.js";
import { writeFailedReportRaw } from "../../clickhouse.js";
import type { Pipeline } from "../../logger.js";

export interface CreditStageInput {
  /** when true, skip entirely (custom upstream scenario); undefined is treated as false */
  skipCreditReport: boolean | undefined;
  config: Pick<ProxyConfig, "creditReport" | "creditPricing">;
  path: string;
  usage: Record<string, unknown> | null | undefined;
  effectiveModel: string;
  upstreamUrl: string;
  event: "usage";
  startTime: Date;
  /** PipelineIds compatible: the old handler passed pipe.ids() straight in, and the stage only spreads it internally */
  reqIds: object;
  /** upstream x-request-id; when empty/absent, downstream uses an empty value */
  upstreamRequestId?: string;
  sessionKey: string;
  stream: boolean;
  keyId: string;
  routedFrom: string;
}

export interface CreditStageResult {
  /** whether a report was triggered (false when skipCreditReport=true) */
  attempted: boolean;
  /** whether the report succeeded (meaningless when attempted=false) */
  ok: boolean;
  /** value of x-credit-report-error to put in the response header (only when attempted && !ok) */
  responseErrorHeader?: string;
}

/**
 * Billing report + failure header + failure raw fallback bookkeeping.
 *
 * The three steps in the original handler:
 *   1. skipCreditReport ? no-op : tryReportCreditFromPath
 *   2. attempted && !ok → pipe.error + set the x-credit-report-error response header
 *   3. attempted && !ok → writeFailedReportRaw (CH fallback)
 *
 * Kept fully equivalent; the only change is handing the response-header set to the caller (just return the header value).
 */
export async function stageCredit(input: CreditStageInput, pipe: Pipeline): Promise<CreditStageResult> {
  if (input.skipCreditReport) {
    return { attempted: false, ok: false };
  }
  const outcome = await tryReportCreditFromPath(
    input.config.creditReport,
    input.path,
    input.usage,
    input.config.creditPricing,
    input.effectiveModel,
    input.upstreamUrl,
    input.event,
    input.startTime,
    { ...input.reqIds, upstreamRequestId: input.upstreamRequestId, sessionKey: input.sessionKey },
  );
  if (!outcome.attempted) {
    return { attempted: false, ok: false };
  }
  if (outcome.ok) {
    return { attempted: true, ok: true };
  }

  pipe.error("CREDIT_REPORT", outcome.errorMessage ?? "unknown");
  writeFailedReportRaw(
    {
      timestamp: new Date().toISOString(),
      event: input.event,
      modelId: input.effectiveModel,
      keyId: input.keyId,
      sessionKey: input.sessionKey,
      upstreamUrl: input.upstreamUrl,
      stream: input.stream,
      usage: input.usage === null ? undefined : input.usage,
      routedFrom: input.routedFrom,
      upstreamRequestId: input.upstreamRequestId,
      pricingConfig: input.config.creditPricing,
    },
    outcome.errorMessage ?? "unknown",
  );
  return {
    attempted: true,
    ok: false,
    responseErrorHeader: outcome.errorHeader,
  };
}
