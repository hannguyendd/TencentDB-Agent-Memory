/**
 * stages/archive.ts — TDAI L0 write + skill extract trigger (Phase 1).
 *
 * Extracted from:
 *   - handler.ts:1884-1888 (TDAI L0) + 1953-1966 (skill trigger)
 *   - anthropicHandler.ts:1803-1809 + 1873-1890
 *   - archiveCtx + triggerCodex/WbArchiveHooks inside codexHandler.ts / workbuddyHandler.ts
 *
 * The only difference is the `protocol` parameter ("openai" / "anthropic" / "responses"), passed in by each runner
 * as a literal (CC/CB -> "anthropic"/"openai", codex/wb -> "responses"); the codex/wb
 * hasAssistantContent gate fix (handler-audit bug B3) is also unified here.
 *
 * 100% equivalent to the old handler, the differences being:
 *   1. Unified use of the hasAssistantContent criterion (wb's original gate was too strict)
 *   2. Unified use of the isExtractionAllowed gate (codex/wb had it before too, preserved)
 */

import type { ProxyConfig } from "../../types.js";
import type { TdaiClient } from "../../tdai/client.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { recordTdaiTurn } from "../../tdai/recorder.js";
import { trackWrite, withL0Retry } from "../../tdai/pending-writes.js";
import { isExtractionAllowed, logExtractionSkipped } from "../../extraction-gate.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";
import type { ArchiveProtocol } from "../strategies/agent/types.js";

/** User-visible assistant content — used for the skill trigger criterion + TDAI L0 write */
export interface ArchiveAssistantContent {
  /** Final assistant text accumulated from the stream or parsed from non-stream */
  text: string;
  /** protocol-specific full assistant message object (openai: {role, content, tool_calls},
   *  anthropic: {content: [...]}, responses: {type: "message", content: [...]}) —
   *  for triggerSkillExtractIfReady to do protocol-specific normalization. May be null to indicate no assistant message. */
  raw: Record<string, unknown> | null;
}

export interface ArchiveStageInput {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo?: Record<string, unknown> | null;
  /** Full request-side messages/input, used for the skill trigger */
  inputMessages: unknown[];
  assistant: ArchiveAssistantContent;
  /** OpenAI / Anthropic / Responses -> affects the protocol field the skill trigger passes downstream */
  protocol: ArchiveProtocol;
  /** asset capability flags obtained from session-init */
  assetCapabilities?: AssetCapabilityFlags;

  /** TDAI L0 related (may be empty: injectionSkipped / auxiliary / dsh headless scenarios) */
  tdaiClient?: TdaiClient | null;
  tdaiIdentity?: TdaiIdentity;
  tdaiUserMessage?: TdaiMessage;

  /** archive-hook short-circuit flags:
   *   - isAuxiliary = codex/dsh sideRequest -> skipped entirely (no L0 write, no skill trigger)
   *   - dshHeadless = dsh without ask_user_question -> same as above
   *   - injectionSkipped = session-init error/bypass -> keep L0 but may skip skill
   */
  isAuxiliary: boolean;
  dshHeadless: boolean;

  /**
   * TDAI L0 write semantics:
   *   - "sync-await" (default): directly await recordTdaiTurn, used for the non-stream branch
   *   - "fire-and-forget-tracked": trackWrite + withL0Retry with 3 backoff retries, attached to a global in-flight set,
   *     index.ts flushPendingWrites is the safety net on SIGTERM; used when called after stream completion (does not block pipe close)
   */
  tdaiWriteMode?: "sync-await" | "fire-and-forget-tracked";

  /**
   * Override for the tool_call count passed to triggerSkillExtractIfReady.
   * For the codex/wb stream scenario only: the stream tap accumulates a count, used to trigger the turn-boundary criterion;
   * openai/anthropic non-stream scenarios pass undefined (the skill trigger counts by itself).
   */
  toolCallCountOverride?: number;

  /**
   * warn log prefix (pure observability, does not affect business logic); "[codex-tdai-l0]"/"[workbuddy-tdai-l0]" etc.
   * Only used when tdaiWriteMode="fire-and-forget-tracked".
   */
  logPrefix?: string;
}

/**
 * Check whether there is actual assistant content (unified criterion, fixes handler-audit bug B3).
 * The old wb used a `text non-empty` criterion that was too strict; in the stream scenario where raw has a tool_use but text is empty
 * it would miss archiving; now changed so that "text or any assistant structure in raw" counts as having content.
 */
export function hasAssistantContent(assistant: ArchiveAssistantContent): boolean {
  if (assistant.text && assistant.text.length > 0) return true;
  if (assistant.raw) {
    const raw = assistant.raw;
    // openai: role/content/tool_calls; anthropic: content[]; responses: type/content
    if (raw.role || raw.content || raw.tool_calls || raw.type) return true;
  }
  return false;
}

/**
 * archive stage — two things: TDAI L0 write + skill extract trigger.
 * Are all of them fire-and-forget? No, the original handler used `await`; kept consistent to ensure
 * pending-writes can wait for them to finish on SIGTERM (blueprint §5.2).
 */
export async function stageArchive(input: ArchiveStageInput): Promise<void> {
  // side-request / dsh headless: skip entirely, keeping the archive buffer semantics clean
  if (input.isAuxiliary || input.dshHeadless) return;

  const {
    config,
    sessionKey,
    agentSource,
    sessionInfo,
    inputMessages,
    assistant,
    protocol,
    assetCapabilities,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
  } = input;

  // 1. TDAI L0 write (only written when client + identity + userMessage are all present)
  // The old codex/wb archive-hook only required tdaiClient + tdaiIdentity, tdaiUserMessage could be empty (would write a null message);
  // the old openai-chat/anthropic handlers required all three; here we keep the most conservative criterion of "all three present".
  // TODO: if codex/wb is found to depend on "still writing L0 when tdaiUserMessage is null", this criterion needs to be relaxed.
  const writeMode = input.tdaiWriteMode ?? "sync-await";
  if (tdaiClient && tdaiIdentity && tdaiUserMessage) {
    if (isExtractionAllowed(config, "tdai-memory")) {
      if (writeMode === "fire-and-forget-tracked") {
        // stream scenario: attached to a global in-flight set, retry 3 times, warn after catch without throwing
        trackWrite(
          withL0Retry(() =>
            recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistant.text || null),
          ).catch((err: unknown) => {
            console.warn(
              `${input.logPrefix ?? "[archive-tdai-l0]"} failed:`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        );
      } else {
        // non-stream scenario: directly await, so the top of the handler can perceive the failure
        await recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistant.text);
      }
    } else {
      logExtractionSkipped(config, "tdai-memory", sessionKey);
    }
  }

  // 2. skill extract trigger — awaited for both sync/stream, ensuring the next turn across nodes reads the latest buffer
  if (isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages,
      assistantMessage: assistant.raw,
      protocol,
      assetCapabilities,
      toolCallCountOverride: input.toolCallCountOverride,
    });
  } else {
    logExtractionSkipped(config, "skill", sessionKey);
  }
}
