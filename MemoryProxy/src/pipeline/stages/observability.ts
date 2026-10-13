/**
 * stages/observability.ts — LangfuseTurnContext construction + turnSeq monotonization (Phase 1).
 *
 * Extracted from 4 nearly identical lf assembly pieces of code:
 *   - handler.ts:1482-1499         (openai protocol, target.tags are route tags)
 *   - anthropicHandler.ts:1408-1425 (anthropic protocol, same as above)
 *   - parts of the lf assembly in codexHandler.ts / workbuddyHandler.ts (missing turn ctx, opt-in later)
 *
 * turnSeq monotonization (addendum §4.2, cd898d2e) depends on Redis; when Redis is not enabled
 * localTurnSeq is returned directly — keeping equivalence.
 *
 * This stage only does 3 things:
 *   1. resolveMonotonicTurnSeq -> get the session-level monotonic turnSeq
 *   2. langfuseTurnTraceId(sessionKey, turnSeq) -> deterministic traceId
 *   3. assemble the LangfuseTurnContext bundle
 *
 * Does not include the independent calls such as opikCreateTrace / analyzerTrace / debugMetadata —
 * the caller makes those itself after getting lf; Phase 2 protocol strategy layer unifies them further.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { countHumanTurns, resolveMonotonicTurnSeq } from "../../turnSeq.js";
import {
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import { resolveLatestUserQuery, reportAnalyzerTrace, type ForwardTarget } from "../../guard-adapter.js";

export interface LangfuseTurnContextBuildInput {
  config: ProxyConfig;
  sessionKey: string;
  keyId: string;
  target: ForwardTarget;
  messages: unknown[];
  /**
   * Protocol — affects the countHumanTurns branch.
   * "responses" uses the separate countHumanTurnsCodex/Workbuddy (inside the codex/wb handlers),
   * the caller must pass it through `localTurnSeqOverride`; it cannot be derived automatically inside this stage.
   */
  protocol: "openai" | "anthropic" | "responses";
  /** trace-level tags (stable dimensions: protocol/stream/session, excluding the route tag) */
  traceTags: string[];
  /** for resolveLatestUserQuery to get the latest user input (path + headers + body) */
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** codex/wb get this from their own countHumanTurnsXxx; if not provided the stage uses countHumanTurns(messages, protocol) */
  localTurnSeqOverride?: number;
  /**
   * turnSeq lane (Redis monotonic counter split into lanes).
   * - handler.ts:1483 does not pass it -> defaults to "main"
   * - anthropicHandler.ts:1409 passes requestKind -> main/fork/sidequery have independent lanes
   *   ensuring CC fork/sidequery categories do not contend with the main conversation for turnSeq.
   */
  lane?: string;
  /**
   * userQuery override (58e4c55b opencode fix).
   * The last user content of an opencode main request is this turn's user input, and when a tool-loop
   * continuation ends with a tool message it should not be counted as new human input; the caller computes it and passes it in,
   * when not passed the stage uses the default resolveLatestUserQuery approach.
   */
  userQueryOverride?: string | null;
}

export interface LangfuseTurnBundle {
  turnSeq: number;
  lf: LangfuseTurnContext;
}

/**
 * Construct the turn-level Langfuse context + session-level monotonic turnSeq.
 *
 * Order-sensitive (blueprint §5.3):
 *   - resolveMonotonicTurnSeq depends on target.turnSeq or the stateless count
 *   - langfuseTurnTraceId is a pure function that depends on the previous step's turnSeq
 */
export async function stageBuildLangfuseTurnContext(
  input: LangfuseTurnContextBuildInput,
): Promise<LangfuseTurnBundle> {
  let localTurnSeq: number;
  if (input.localTurnSeqOverride !== undefined) {
    localTurnSeq = input.localTurnSeqOverride;
  } else if (input.target.turnSeq > 0) {
    localTurnSeq = input.target.turnSeq;
  } else if (input.protocol === "responses") {
    // codex/wb must explicitly pass localTurnSeqOverride (using their own countHumanTurnsCodex/Workbuddy);
    // if not passed it is treated as 0, and the later resolveMonotonicTurnSeq also short-circuits (localTurnSeq<=0 returns directly).
    localTurnSeq = 0;
  } else {
    localTurnSeq = countHumanTurns(input.messages, input.protocol);
  }

  const turnSeq = await resolveMonotonicTurnSeq(
    input.config,
    input.sessionKey,
    localTurnSeq,
    input.lane,
  );

  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(input.sessionKey, turnSeq),
    turnSeq,
    traceName: `${input.target.model} / ${input.keyId}`,
    userId: input.keyId,
    sessionId: input.sessionKey,
    tags: input.traceTags,
    routeTags: input.target.tags,
    userQuery: input.userQueryOverride ?? resolveLatestUserQuery(
      input.config,
      input.headers,
      input.path,
      input.body,
      input.messages,
    ),
  };

  return { turnSeq, lf };
}

/**
 * analyzerTrace report — calls reportAnalyzerTrace when target.analyzerTrace is non-null.
 * Merges the inline blocks of the openai-chat + anthropic runners.
 */
export function stageReportAnalyzerTrace(input: {
  config: ProxyConfig;
  target: ForwardTarget;
  traceId: string;
  lf: LangfuseTurnContext;
  keyId: string;
  sessionKey: string;
  turnSeq: number;
  startTime: string;
  spaceId: string;
}): void {
  if (!input.target.analyzerTrace) return;
  reportAnalyzerTrace(input.config, input.target.analyzerTrace, {
    traceId: input.traceId,
    langfuseTraceId: input.lf.traceId,
    traceName: input.lf.traceName,
    traceTags: input.lf.tags,
    keyId: `${input.keyId}:${input.sessionKey}`,
    sessionKey: input.sessionKey,
    turnSeq: input.turnSeq,
    startTime: input.startTime,
    spaceId: input.spaceId,
  });
}

/**
 * Pack lowercase request headers into a plain object — needed in many places in the handler,
 * "for (const [k,v] of c.req.raw.headers.entries()) hdrs[k.toLowerCase()] = v"。
 * extracted into one shared copy.
 */
export function collectLowerCaseHeaders(c: Context): Record<string, string> {
  const hdrs: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    hdrs[k.toLowerCase()] = v;
  }
  return hdrs;
}
