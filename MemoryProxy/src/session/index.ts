/**
 * Session Initialization Module — Public API.
 *
 * Architecture after the split:
 *   - codebuddy/    → CodeBuddy-specific session-init (ask_followup_question form, XML extractor)
 *   - claude-code/  → Claude Code-specific session-init (AskUserQuestion form, JSON extractor, pagination)
 *   - shared modules: store.ts, types.ts, context-injector.ts, registrar.ts
 *
 * Kernel API calls all go through src/meta/client.ts (MetadataClient).
 */

// ── Shared modules ────────────────────────────────────────────────────────────

export { SessionStore, getSessionStore } from "./store.js";
export type {
  SessionInitStatus,
  SessionInitState,
  SessionInitData,
  SessionRegistrationData,
  SessionInfo,
  AgentDetail,
  TaskDetail,
  TeamOption,
  AgentInTeam,
  TaskInTeam,
  TaskOption as TaskOpt,
  AgentOption as AgentOpt,
} from "./types.js";

export { buildSessionInfo } from "./registrar.js";
export { injectSessionContext, SESSION_CONTEXT_OPEN, SESSION_CONTEXT_CLOSE } from "./context-injector.js";
export { parsePresetIdentity, resolvePresetIdentity } from "./preset.js";
export type { PresetIdentity, PresetResolution } from "./preset.js";

// ── CodeBuddy-specific modules ────────────────────────────────────────────────

export {
  handleSessionInit as handleCodeBuddySessionInit,
  buildFormResponse as buildCodeBuddyFormResponse,
  containsFormTitle as containsCodeBuddyFormTitle,
  extractFromOptionText as extractCodeBuddyFromOptionText,
  extractStructured as extractCodeBuddyStructured,
  resolveAgent as resolveCodeBuddyAgent,
  resolveTask as resolveCodeBuddyTask,
  BYPASS_MARKER as CB_BYPASS_MARKER,
  getLastUserMessageText as getCodeBuddyLastUserMessage,
} from "./codebuddy/index.js";

// ── Claude Code-specific modules ──────────────────────────────────────────────

export {
  handleSessionInit as handleClaudeCodeSessionInit,
  buildFormResponse as buildClaudeCodeFormResponse,
  containsFormTitle as containsClaudeCodeFormTitle,
  extractFromOptionText as extractClaudeCodeFromOptionText,
  extractStructured as extractClaudeCodeStructured,
  resolveAgent as resolveClaudeCodeAgent,
  resolveTask as resolveClaudeCodeTask,
  BYPASS_MARKER as CC_BYPASS_MARKER,
  MORE_MARKER,
  getLastUserMessageText as getClaudeCodeLastUserMessage,
} from "./claude-code/index.js";

// ── Legacy compat API (backward compatible with old handler.ts call style) ────

import type { SessionInitConfig } from "../types.js";
import { SessionStore } from "./store.js";
import {
  handleSessionInit as cbHandle,
  SessionRequestContext as CBSessionRequestContext,
  SessionInitResult as CBSessionInitResult,
} from "./codebuddy/init.js";
import {
  handleSessionInit as ccHandle,
  SessionRequestContext as CCSessionRequestContext,
  SessionInitResult as CCSessionInitResult,
} from "./claude-code/init.js";
import {
  buildFormResponse as buildWorkBuddyFormResponse,
  FormData as WBFormData,
  FormStage as WBFormStage,
} from "./workbuddy/form.js";
import { buildWorkBuddyTextFormResponse } from "./workbuddy/text-form.js";
import {
  buildFormResponse as buildDshFormResponse,
  FormData as DshFormData,
  FormStage as DshFormStage,
} from "./dsh/form.js";
import {
  buildFormResponse as buildOpencodeFormResponse,
  FormData as OCFormData,
  FormStage as OCFormStage,
} from "./opencode/form.js";

// Re-export the types under their old names for backward compat
export type SessionRequestContext = CBSessionRequestContext & Partial<CCSessionRequestContext>;
export type SessionInitResult = CBSessionInitResult;

/**
 * @deprecated Use handleCodeBuddySessionInit() or handleClaudeCodeSessionInit() instead.
 * This function routes to the matching implementation based on the agentSource parameter.
 */
import type { MetadataClient } from "../meta/client.js";
import type { PresetIdentity } from "./preset.js";

export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: Record<string, unknown>[],
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  agentSource: string = "codebuddy",
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
): Promise<SessionInitResult> {
  if (agentSource === "claude-code") {
    return ccHandle(
      sessionKey, userId, messages, config, store,
      // Forward the whole reqCtx so that newly added fields (such as codex's
      // codexAnswerInput) are not dropped by hand-picking fields. protocol MUST be forwarded — without it,
      // applyArtifactsAndContext takes the openai path (injects
      // <session_context> into messages as a role=system message) instead of
      // the anthropic path (returns systemAppend that anthropicHandler merges
      // into body.system). The openai path currently only works because
      // AnthropicAdapter.serialize() hoists role=system back onto body.system
      // as a safety net; forwarding the correct protocol keeps intent and
      // implementation aligned and survives `injection.enabled=false`.
      reqCtx,
      metadataClient,
      userKey,
      spaceId,
      presetIdentity,
    );
  }
  // Same as above: forward the whole reqCtx to the CB state machine. codexHandler puts body.input[] in
  // reqCtx.codexAnswerInput, for the codex-only pre-checks segment inside the CB state machine
  // (detectCodexDefaultGate + detectCodexMore in session/codebuddy/init.ts)
  // to recognize the Default gate and MORE pagination. Hand-picking fields would drop it → codex pagination breaks.
  const result = await cbHandle(
    sessionKey, userId, messages, config, store,
    reqCtx,
    metadataClient,
    userKey,
    spaceId,
    presetIdentity,
    agentSource,
  );

  // The WorkBuddy client reuses the CB state machine (the full uninitialized → pending_team → pending_agent_task
  // → initialized flow), but form rendering needs the CC `AskUserQuestion` shape +
  // OpenAI chat/completions SSE tool_calls transport (the WB client is a hybrid of CC tool semantics +
  // the OpenAI protocol, confirmed by packet capture [wb-ask-user-schema]).
  //
  // Following the codex pattern (`session/codex/form.ts::buildFormResponse`), here after the CB
  // state machine produces formData we **re-render in the outer layer**: drop result.response (the CB
  // ask_followup_question SSE) and use workbuddy/form.ts to generate the AskUserQuestion SSE.
  // Benefit: zero changes to CB state machine code, and the 10 intercepted sites need no individual dispatch.
  if (agentSource === "workbuddy" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const wbFd: WBFormData = {
      teams: cbFd.teams,
      // The stage values of the CB state machine (asset_confirm | team | agent_select | task_select |
      // agent_task) match the WB form's FormStage exactly; forward them directly.
      stage: cbFd.stage as WBFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      // The paging fields CB carries are teamPage / agentPage / taskPage (for codex passthrough),
      // while the WB form uses a single pageIndex — pick the matching page number based on the current stage.
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    // Capability detection: the new WorkBuddy official tools set dropped AskUserQuestion,
    // and continuing to send tool_calls SSE means the client accepts but does not render → hangs in pending.
    // In that case degrade to **text mode** (content chunk + markdown numbered list),
    // completing the same 4-stage interaction via next / prev / skip keywords + number/name/id.
    //
    // The decision logic is centralized in detectClientCapabilities (already computed and forwarded at the handler.ts layer):
    //   - capabilities === undefined  → treat as true, take the original card path (forward compatible)
    //   - capabilities.askUserQuestion === true  → take the original card path
    //   - capabilities.askUserQuestion === false → use text mode
    const askCapability = reqCtx.capabilities?.askUserQuestion;
    if (askCapability === false) {
      result.response = buildWorkBuddyTextFormResponse(wbFd);
    } else {
      result.response = buildWorkBuddyFormResponse(wbFd);
    }
  }

  // The dsh (deepseek-harness) client reuses the CB state machine + its own ask_user_question carrier.
  // Fully symmetric with workbuddy: after the CB state machine produces formData, re-render the response in the outer layer, without sharing
  // CB's ask_followup_question (the dsh preset mounts dsh's native ask_user_question,
  // confirmed by packet capture fixtures/dsh-tool-catalog-schema.json). Stage values are identical and forwarded directly;
  // the dsh form uses a CC-shape single pageIndex, picking the paging field the same way as workbuddy.
  if (agentSource === "dsh" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const dshFd: DshFormData = {
      teams: cbFd.teams,
      stage: cbFd.stage as DshFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
      // dsh v0.2+ uses anthropic /v1/messages (at the handler layer reqCtx.protocol="anthropic")
      // dsh v0.1.x uses openai /v1/chat/completions (at the handler layer reqCtx.protocol="openai"
      // or undefined). The form builder picks the SSE skeleton by this branch, see dsh/form.ts buildFormResponse.
      protocol: reqCtx.protocol,
    };
    result.response = buildDshFormResponse(dshFd);
  }

  // The opencode client (sst/opencode CLI, a Bun-packaged binary) maintains in its agent loop a
  // hard whitelist of tools: `bash, edit, glob, grep, invalid, question, read,
  // skill, task, todowrite, webfetch, write`. Any tool_call whose name is not in the whitelist
  // is rejected by the client and rendered as `invalid [tool=xxx, error=Model tried to call
  // unavailable tool]` (confirmed by packet capture 2026-08-19: CB's `ask_followup_question`
  // was rejected 3 times, after which the CB state machine abandoned → took the bypass).
  //
  // Fix: fully symmetric with workbuddy / dsh — after the CB state machine produces formData, **re-render in the outer layer**,
  // swapping in the tool_call SSE of opencode's native `question` tool. Stage values are forwarded directly,
  // and paging fields pick the matching page number by current stage.
  //
  // See: header comment of session/opencode/form.ts (schema basis / three shape differences).
  if (agentSource === "opencode" && result.intercepted && result.formData) {
    const cbFd = result.formData;
    const ocFd: OCFormData = {
      teams: cbFd.teams,
      stage: cbFd.stage as OCFormStage,
      selectedTeamId: cbFd.selectedTeamId,
      selectedAgentId: cbFd.selectedAgentId,
      pageIndex:
        cbFd.stage === "team" ? cbFd.teamPage
        : cbFd.stage === "agent_select" ? cbFd.agentPage
        : cbFd.stage === "task_select" ? cbFd.taskPage
        : 0,
      retry: cbFd.retry,
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
    };
    result.response = buildOpencodeFormResponse(ocFd);
  }

  return result;
}
