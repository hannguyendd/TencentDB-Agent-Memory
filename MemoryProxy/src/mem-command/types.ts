/**
 * Type definitions for the mem-command module
 */

import type { ProxyConfig, MemCommandConfig } from "../types.js";

/**
 * Recent conversation message snippet, consumed by task-draft-generator.
 * Only role + content are needed for now (no tool_calls / attachment) to keep it minimal.
 */
export interface MemCommandMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface MemCommandContext {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  apiKey: string;
  sessionInfo: Record<string, unknown>;
  protocol: "anthropic" | "openai" | "responses";
  stream: boolean;
  /**
   * Model name of the client's current request (the real model_id after body.model is normalized by resolveModelId).
   * Option D: the taskDraft LLM follows the main model and no longer depends on config.memCommand.taskDraft.
   */
  model?: string;
  /**
   * Per-agent resolved upstream base url (without the specific endpoint).
   * Option D: taskDraft reuses the same upstream as the main path, with the same rule as main-path forwarding:
   *   config.upstream.agents?.[agent]?.url ?? config.upstream.url
   */
  upstreamUrl?: string;
  /**
   * **API protocol family** of the taskDraft LLM upstream (determines the request shape; differs in meaning from ctx.protocol).
   *
   * ⚠️ Not to be confused with the `protocol` field:
   *   - `protocol` (below, the existing legacy field on this ctx): **response rendering protocol** --
   *     decides which SSE skeleton `buildMemResponse` uses to emit the mem command result to the client
   *     (maps one-to-one to the client-side protocol, e.g. anthropic/openai/responses).
   *   - `upstreamProtocol` (this field): **which protocol the taskDraft LLM request uses upstream** --
   *     decides whether attemptDraftOnce hits /v1/messages, /chat/completions or /responses.
   *     It depends on the upstream endpoint the client's main path actually uses, **and does not necessarily equal the response protocol**.
   *
   * Typical case: the WorkBuddy client renders the response with the Responses SSE skeleton (protocol="responses"),
   * but the main-path upstream is actually OpenAI chat/completions (upstreamProtocol="openai").
   *
   * When omitted, task-draft-generator treats it as "openai".
   */
  upstreamProtocol?: "openai" | "anthropic" | "responses";
  /** Command arguments (e.g. the prompt for create-skill / create-task) */
  args: string;
  /** Whether extended thinking is enabled on the request (Anthropic only) */
  thinking?: boolean;
  /**
   * Recent conversation messages of the current request (used by task-draft-generator to generate drafts).
   *
   * - CC/CB use chat/completions: this is body.messages[] directly
   * - Codex/WorkBuddy use the Responses API: an empty array is passed for now (body.input parsing to be added during stage-5 integration)
   *
   * When omitted it is treated as an empty array, and the task command family returns a "no recent messages" error.
   */
  bodyMessages?: MemCommandMessage[];
}

/**
 * Supported mem: command names -- a strongly typed union used by index.ts for dispatch and by commands/* for narrowing.
 * Strings not listed fall through to executeMemCommand's "unknown command" fallback.
 */
export type MemCommandName =
  | "help"
  | "sync"
  | "create-skill"
  | "create-task"
  | "update-task";

export interface MemCommandResult {
  success: boolean;
  /** User-readable result text (written to L0 / shown to the user) */
  messageText: string;
  /** Structured data (optional) */
  data?: Record<string, unknown>;
  /** The built HTTP Response (synthesized in the protocol's format) */
  response: Response;
}

export type { MemCommandConfig };
