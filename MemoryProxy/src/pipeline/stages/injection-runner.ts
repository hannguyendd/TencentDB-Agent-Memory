/**
 * stages/injection-runner.ts — main-conversation asset injection stage.
 *
 * Extracted from the pipeline.process call blocks in the openai-chat + anthropic runners (~30 lines x 2).
 * Injection in codex/wb goes through a separate synthetic body composition path, not covered by this stage.
 *
 * Semantics: silently degrades inside try/catch (blueprint §5.2 red-line 2); errors do not block
 * the main pipeline, falling back to the original body.
 */

import type { ProxyConfig } from "../../types.js";
import { countHumanTurns } from "../../turnSeq.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";

export interface InjectionRunnerInput {
  /** all gates that caused injection to be skipped, aggregated (injectedSkipped, requestKind, etc.) */
  skip: boolean;
  config: ProxyConfig;
  body: Record<string, unknown>;
  protocol: "openai" | "anthropic";
  /** main pipeline turnSeq (not made monotonic; injection uses only a stateless number) */
  messages: unknown[];
  traceId: string;
  keyId: string;
  modelId: string;
  isStream: boolean;
  agentSource: string;
  userId: string;
  spaceId: string;
  sessionKey: string;
  requestPath: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  assetCapabilities?: AssetCapabilityFlags;
  callerUserKey?: string;
  /** anthropic only: fork requests use readOnly=true and do not trigger self-heal */
  readOnly?: boolean;
}

export interface InjectionRunnerResult {
  /** replaced if injection succeeded; if not injected or failed -> original body */
  body: Record<string, unknown>;
  /** body.messages after (may equal input messages) */
  messages: unknown[];
}

/**
 * Run the injection pipeline; on failure silently fall back.
 */
export async function stageInjectionRunner(
  input: InjectionRunnerInput,
): Promise<InjectionRunnerResult> {
  const { skip, config, body, protocol, messages } = input;
  if (skip || !config.injection?.enabled || (config.injection?.injectors?.length ?? 0) === 0) {
    return { body, messages };
  }

  try {
    const injectionTurnSeq = countHumanTurns(messages, protocol);
    const { getInjectionPipeline } = await import("../../injection/index.js");
    const pipeline = getInjectionPipeline(config);
    const injectedBody = await pipeline.process(body, {
      protocol,
      traceId: input.traceId,
      keyId: input.keyId,
      modelId: input.modelId,
      stream: input.isStream,
      agentSource: input.agentSource,
      userId: input.userId || "anonymous",
      spaceId: input.spaceId,
      sessionKey: input.sessionKey,
      turnSeq: injectionTurnSeq,
      requestPath: input.requestPath,
      custom: input.sessionInfo
        ? {
            session: input.sessionInfo,
            assetCapabilities: input.assetCapabilities,
            userKey: input.callerUserKey || undefined,
          }
        : undefined,
      readOnly: input.readOnly,
    });
    const newMessages = Array.isArray(injectedBody.messages)
      ? injectedBody.messages as unknown[]
      : messages;
    return { body: injectedBody, messages: newMessages };
  } catch (err: unknown) {
    console.error(`[injection] ${protocol} pipeline error:`, err instanceof Error ? err.message : String(err));
    return { body, messages };
  }
}
