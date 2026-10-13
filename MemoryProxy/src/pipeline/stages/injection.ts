/**
 * stages/injection.ts — asset injection stage (Phase 4).
 *
 * Extracted from 4 injection pipeline.process calls:
 *   - handler.ts:1356-1388
 *   - anthropicHandler.ts:1260-1291
 *   - codexHandler.ts:888-980 (synthetic body composition)
 *   - workbuddyHandler.ts:1681-1718 (synthetic body composition)
 *
 * This stage is a thin wrapper that delegates to the existing InjectionPipeline in injection/pipeline.ts.
 * Differences (blueprint §2.3):
 *   - openai protocol (handler/CB/dsh/opencode): inject directly into messages[0]
 *   - anthropic (CC): inject into body.system
 *   - responses (codex/wb): compose a synthetic body to form input[0]
 *
 * Differences in injection position are handled by injection/adapters/*.ts (already existing); this stage does not duplicate them.
 */

import type { InjectionPipeline } from "../../injection/pipeline.js";
import type { AgentContextMetadata } from "../../injection/types.js";

export interface InjectionStageInput {
  pipeline: InjectionPipeline;
  body: Record<string, unknown>;
  metadata: AgentContextMetadata;
  /** all cases where injection was skipped (session bypassed / fork/sidequery / dsh headless / injectionSkipped=true) */
  skip: boolean;
}

export interface InjectionStageResult {
  /** whether injection actually happened (skip=true -> false, success -> true) */
  applied: boolean;
  /** body after injection; on skip or exception -> original body */
  body: Record<string, unknown>;
}

/**
 * Run the injection stage — degrades inside try/catch; errors do not block the main pipeline.
 * blueprint §5.2: silent fallback to the original body.
 */
export async function stageInjection(input: InjectionStageInput): Promise<InjectionStageResult> {
  if (input.skip) {
    return { applied: false, body: input.body };
  }
  try {
    const injected = await input.pipeline.process(input.body, input.metadata);
    return { applied: true, body: injected };
  } catch (err) {
    console.warn(`[stage-injection] pipeline.process failed: ${(err as Error).message}`);
    return { applied: false, body: input.body };
  }
}
