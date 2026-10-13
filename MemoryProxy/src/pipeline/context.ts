/**
 * PipelineContext — explicit state shared between stages during a request lifecycle.
 *
 * Design principles (adopting the blueprint-review §1 improved scheme):
 *   - readonly partition: identity/request fields that must be frozen after the
 *     first 3 stages (auth / parse-body / classify), enforced by the TS compiler.
 *   - mutable partition: fields filled in progressively by session-init / forward / stream finalization, etc.
 *   - Goal: prevent later stages from accidentally overwriting values already determined earlier (blueprint §3.1 red-line 8).
 *
 * Each stage narrows its parameter type to the necessary subset (Pick<PipelineContext, ...> or
 * a stage-output bundle), so the compiler helps validate the access scope.
 *
 * Implicit flags made explicit follow blueprint §5.1 (9 items) + addendum §5 (10th item memoryTurn).
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import type { LangfuseTurnContext } from "../langfuse.js";
import type { Pipeline } from "../logger.js";
import type { ForwardTarget } from "../guard-adapter.js";
import type { TdaiClient } from "../tdai/client.js";
import type { TdaiIdentity, TdaiMessage } from "../tdai/types.js";
import type { RequestKind } from "../agent-adapters/types.js";
import type { AssetCapabilityFlags } from "../injection/types.js";
import type { SessionInfo } from "../session/types.js";
export type { AssetCapabilityFlags };
export type { SessionInfo };

/**
 * PipelineContext — state shared across the whole request lifecycle.
 *
 * Usage (when Phase 4 assembles runPipeline):
 *   - Upper-half readonly fields are initialized in the corresponding stage via createContext / augmentXxx()
 *     and not modified afterwards.
 *   - Lower-half mutable fields are filled in progressively by later stages.
 *   - Each stage depends only on the subset it needs, narrowing its parameter with `Pick<PipelineContext, "keyA" | "keyB">`;
 *     or directly takes an immutable bundle of stage outputs (auth / body / classify).
 */
export interface PipelineContext {
  // ── readonly request identity (frozen after the first 3 stages) ────────
  readonly c: Context;
  readonly config: ProxyConfig;
  readonly traceId: string;
  readonly startTime: string;
  readonly path: string;

  // ── Auth stage output ────────────────────────────────────────────────
  readonly apiKey: string;
  readonly keyId: string;
  readonly userId: string;
  readonly spaceId: string;

  // ── Body stage output ────────────────────────────────────────────────
  /** Full request body (may be modified later by injection/instance override) */
  body: Record<string, unknown>;
  /** OpenAI: body.messages / Anthropic: body.messages / Responses: body.input */
  messages: unknown[];
  requestedModel: string;
  /** Actual model_id after alias resolution (may be changed by instance override after Phase 1) */
  modelId: string;
  isStream: boolean;
  hasTools: boolean;

  // ── Classify stage output ────────────────────────────────────────────
  readonly agentSource: string;
  requestKind: RequestKind;

  // ── Session-init stage output (blueprint §5.1 explicit implicit flags) ─
  sessionKey: string;
  sessionInfo?: SessionInfo | null;
  sessionJustRegistered: boolean;
  injectionSkipped: boolean;
  assetCapabilities?: AssetCapabilityFlags;
  agentDetail?: unknown;
  taskDetail?: unknown;
  /** header-only agent (pi/hermes/openclaw) semantic flag, addendum §5 item 10 */
  memoryTurn: boolean;
  /** mem command peeked this turn; prewarm must short-circuit */
  memCommandPending: boolean;
  /** reset flow (mem:session-reset) completion info; after the session-init block, return a confirmation response */
  resetFlowResult?: unknown;

  // ── Special markers (blueprint §5.1) ─────────────────────────────────
  isCustomUpstream: boolean;
  skipCreditReport: boolean;
  isLegacyProxy: boolean;
  /** dsh headless (no ask_user_question tool) detection -> skip session-init/injection */
  dshHeadless: boolean;

  // ── Forward stage output ─────────────────────────────────────────────
  target?: ForwardTarget;
  effectiveApiKey: string;
  upstreamUrl: string;
  upstreamHeaders: Record<string, string>;

  // ── Response stage output ────────────────────────────────────────────
  usage?: Record<string, unknown>;
  assistantText?: string;
  upstreamRequestId?: string;
  retried: boolean;

  // ── Observability ───────────────────────────────────────────────────
  pipe: Pipeline;
  lf: LangfuseTurnContext;
  turnSeq: number;
  debugMetadata?: unknown;

  // ── TDAI ────────────────────────────────────────────────────────────
  tdaiClient?: TdaiClient | null;
  tdaiIdentity?: TdaiIdentity;
  tdaiUserMessage?: TdaiMessage;
}

/**
 * Request identity bundle (immutable after auth + body + classify, referenced by later stages).
 * "partial context" pattern used to narrow stage function parameters:
 *   stageSessionInitOrchestrate(req: RequestBundle, ...)
 *
 * blueprint-review §1 compromise scheme -- readonly partition + mutable partition, two bundles.
 */
export interface RequestBundle {
  readonly c: Context;
  readonly config: ProxyConfig;
  readonly traceId: string;
  readonly startTime: string;
  readonly path: string;
  readonly apiKey: string;
  readonly keyId: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly agentSource: string;
  readonly requestKind: RequestKind;
  readonly requestedModel: string;
  readonly isStream: boolean;
  readonly hasTools: boolean;
}
