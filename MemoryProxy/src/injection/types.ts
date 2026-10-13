/**
 * Core type definitions for the Context Injection module.
 *
 * Defines protocol-agnostic abstractions:
 * - ContextBlock: a single content unit (text, tool_use, tool_result, etc.)
 * - ContextMessage: a role-tagged array of blocks
 * - AgentContext: the full request context (messages + tools + params + metadata)
 * - InjectionPoint: where to inject content
 * - InjectionHook: a pluggable injector
 * - HookRegistry: manages registered hooks
 */

// ── Content Blocks ────────────────────────────────────────────────────────────

/**
 * Type of a content block.
 */
export type ContextBlockType =
  | "text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "image"
  | "custom";

/**
 * A single content unit. Unifies OpenAI string content and Anthropic ContentBlock[].
 */
export interface ContextBlock {
  type: ContextBlockType;
  content: string;
  metadata?: Record<string, unknown>;
}

// ── Messages ──────────────────────────────────────────────────────────────────

/**
 * Message role. Covers both OpenAI and Anthropic roles.
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * A standardized message: role + blocks + optional metadata.
 */
export interface ContextMessage {
  role: MessageRole;
  blocks: ContextBlock[];
  metadata?: Record<string, unknown>;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * Protocol-agnostic tool definition.
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /**
   * Prompt-cache breakpoint marker (Anthropic `cache_control`), carried through
   * the parse→serialize round-trip so upstream prompt caching keeps working.
   * Sits at the same level as `input_schema` in the wire format.
   */
  cacheControl?: unknown;
}

// ── Context Metadata ──────────────────────────────────────────────────────────

/**
 * Protocol identifier.
 */
export type Protocol = "openai" | "anthropic";

/**
 * Request-level metadata attached to every AgentContext.
 */
export interface AgentContextMetadata {
  protocol: Protocol;
  traceId: string;
  keyId: string;
  modelId: string;
  stream: boolean;
  /** Agent source name from URL path (e.g. "codebuddy", "claude-code"). */
  agentSource: string;
  /**
   * Authenticated user id (`earlyVerify.userId`). Required by hook-cache repo
   * writes so ttl/nottl keys land under the correct user namespace. Callers
   * without an authenticated user (systemUser passthrough, anonymous) either
   * skip the injection pipeline entirely or should pass `"anonymous"`.
   */
  userId?: string;
  /**
   * SpaceId (aka memory instance id). New in P4 (kernel-sts) -- STS permissions are isolated by space,
   * and the key path also carries a spaceId segment accordingly. The upstream handler parses it from the URL path
   * (`extractSpaceIdFromPath`) and passes it in. When absent the Repo layer uses `_default` as a fallback.
   */
  spaceId?: string;
  /**
   * Session key (conversation isolation). Used by LangfuseInjectionObserver
   * to derive the deterministic Langfuse turn-trace ID.
   */
  sessionKey?: string;
  /**
   * Turn sequence number within the session. Combined with sessionKey to
   * derive the deterministic Langfuse turn-trace ID.
   */
  turnSeq?: number;
  /**
   * Raw request URL path (e.g. `/codebuddy/default/analyse/v1/messages`).
   * Optional -- for injectors that need to decide behavior by URL marker (such as
   * `AssetReflectionInjector`, which uses it to call `hasAnalyseMarker`). When absent
   * the marker is always treated as not hit, and the injector degrades silently.
   */
  requestPath?: string;
  /** Allow injectors to attach custom key-value pairs. */
  custom?: Record<string, unknown>;
  /**
   * Read-only mode: on the cache-miss branch **do not self-heal put** (only use hook.execute() to get the
   * result, without writing back to hook-cache). For FORK-type requests -- their purpose is to reuse the main conversation's cache hit;
   * if they self-heal on miss, the written content is not necessarily byte-level identical to the main conversation's, which would instead break the cache.
   *
   * Main conversation requests (default) leave it unset or set false -- keep self-heal, ensuring later hits after the first miss.
   */
  readOnly?: boolean;
}

// ── Agent Context ─────────────────────────────────────────────────────────────

/**
 * The full, protocol-agnostic request context.
 * This is what flows through the injection pipeline.
 */
export interface AgentContext {
  /** Ordered message list. */
  messages: ContextMessage[];

  /** Available tool definitions (protocol-agnostic). */
  tools?: AgentTool[];

  /** Original request parameters (model, temperature, max_tokens, etc.). */
  requestParams: Record<string, unknown>;

  /** Request-level metadata. */
  metadata: AgentContextMetadata;
}

// ── Injection Points ──────────────────────────────────────────────────────────

/**
 * Where content can be injected within the context.
 * Each point maps to a specific logical position in the messages.
 */
export type InjectionPoint =
  | "system.prefix"       // Before system prompt content
  | "system.suffix"       // After system prompt content
  | "system.before_tools" // Before tool/skill descriptions in system prompt
  | "system.after_tools"  // After tool/skill descriptions in system prompt
  | "user.before"         // Before the latest user message
  | "user.after"          // After the latest user message
  | "user.first_turn"     // Before the first user message (first turn only)
  | "tools.append"        // Append to tools list
  | "tools.prepend";      // Prepend to tools list

/**
 * All valid injection points as an array (useful for validation).
 */
export const INJECTION_POINTS: InjectionPoint[] = [
  "system.prefix",
  "system.suffix",
  "system.before_tools",
  "system.after_tools",
  "user.before",
  "user.after",
  "user.first_turn",
  "tools.append",
  "tools.prepend",
];

// ── Dynamic Anchor (semantic slots) ─────────────────────────────────────────

/**
 * Semantic slot — an agent-agnostic logical region of the system prompt.
 *
 * A hook declares "which kind of region I want to land in" via a slot; each
 * AgentProfile.resolveSlot() translates the slot into that agent's concrete
 * structural key (CodeBuddy XML tag / Claude Code markdown heading / ...).
 *
 * This is an open enum (string fallback) so business code can define custom
 * slots without touching this type.
 */
export type SemanticSlot =
  | "persona"       // identity / preamble
  | "tools"         // tool / MCP protocol region
  | "skills"        // skill catalog region
  | "memory"        // long-term memory region
  | "knowledge"     // knowledge base / retrieval / wiki region
  | "rules"         // behavior rules region
  | "task_context"  // project / session context region
  | (string & {});  // allow custom slot names

/**
 * Anchor relation (agent-agnostic).
 * - before:         insert a standalone block *before* the target segment
 * - after:          insert a standalone block *after* the target segment
 * - inside_prepend: insert at the *beginning* of the target segment's body
 * - inside_append:  append at the *end* of the target segment's body
 */
export type AnchorRelation =
  | "before"
  | "after"
  | "inside_prepend"
  | "inside_append";

/**
 * Dynamic anchor target: declares "relative to which semantic slot, with what
 * relation" the content should land.
 *
 * `slot` and `rawKey` are mutually exclusive: prefer `slot` (portable across
 * agents); `rawKey` is an escape hatch that pins a concrete structural key of a
 * specific agent (trading portability for precise control).
 */
export interface AnchorTarget {
  /** Semantic slot (recommended, portable across agents). */
  slot?: SemanticSlot;
  /** Raw structural key (escape hatch: a specific agent's tag/heading/field). */
  rawKey?: string;
  /** Insertion relation relative to the resolved position. */
  relation: AnchorRelation;
}

// ── Hook Priority ─────────────────────────────────────────────────────────────

/**
 * Hook priority — lower number = higher priority (executed first).
 */
export type HookPriority = number;

/**
 * Predefined priority levels for common hook types.
 */
export const HOOK_PRIORITY = {
  /** System-level injection (highest priority, executes first). */
  SYSTEM: 0,
  /** Memory injection. */
  MEMORY: 100,
  /** Skill injection. */
  SKILL: 200,
  /** Wiki/knowledge base injection. */
  WIKI: 300,
  /** Custom injection (lowest priority). */
  CUSTOM: 1000,
} as const;

// ── Cache Strategy ────────────────────────────────────────────────────────────

/**
 * Hook cache strategy — controls when (and whether) the hook's payload is
 * fetched, and where it is read from at request time.
 *
 * - `none`         (default): every request → call `execute(ctx)` (current behavior).
 * - `session_init`:           on session_init only → call `prewarm(input)` once,
 *                             persist the result; every subsequent request reads
 *                             directly from the cache and SKIPS `execute()`.
 * - `hybrid`:                 on session_init → call `prewarm(input)` and persist;
 *                             every request also calls `execute(ctx)`; the final
 *                             injection is the union of cached + fresh blocks,
 *                             deduplicated by `metadata.cacheKey ?? content`.
 *
 * Existing hooks that do not declare `cacheStrategy` behave as `none`.
 */
export type CacheStrategy = "none" | "session_init" | "hybrid";

/**
 * Input passed to `InjectionHook.prewarm()` at session_init time.
 *
 * Note: there is NO "current user message" available during prewarm — by
 * design, prewarm produces session-stable content (skill list, fixed wiki
 * docs derived from task description, etc.). Hooks that need per-turn
 * recall MUST use `cacheStrategy: "hybrid"` and keep doing the recall in
 * `execute()`.
 */
export interface AssetCapabilityFlags {
  skill: boolean;
  llm_wiki: boolean;
  code_graph: boolean;
  chat_memory: boolean;
}

export interface PrewarmInput {
  keyId: string;
  /**
   * Authenticated user id — passed through to `hookCacheRepo.putMany` so
   * prewarmed blocks land under the correct `ttl/<userId>/...` path.
   * Handler layer provides this; defaults to `"anonymous"` when absent.
   */
  userId: string;
  /**
   * Client type from URL path (e.g. `claude-code`, `codebuddy`). Handler
   * layer provides this; defaults to `"claude-code"` when absent.
   */
  agentSource: string;
  /**
   * SpaceId (memory instance id). New in P4 kernel-sts; when absent the Repo uses the `_default` fallback segment.
   */
  spaceId?: string;
  sessionInfo: import("../session/types.js").SessionInfo;
  agentDetail: import("../session/types.js").AgentDetail | null;
  taskDetail: import("../session/types.js").TaskDetail | null;
  /** Per-user asset capability flags, resolved from tdai meta config/user/get. */
  assetCapabilities?: AssetCapabilityFlags;
  /**
   * API key of the session-init initiator (sk-... / ck-...).
   * Used in the prewarm stage to build AgentContext.metadata.custom.userKey, so downstream
   * TDAI ACL checks can get the caller identity (Layer 3 x-tdai-user-key).
   * Sensitive field: only flows in memory, not written to logs/persisted.
   */
  callerUserKey?: string;
}

// ── Injection Hook ────────────────────────────────────────────────────────────

/**
 * A single injection hook.
 * Hooks are registered with the pipeline and executed at their designated points.
 */
export interface InjectionHook {
  /** Unique hook identifier. */
  id: string;
  /** Injection point where this hook operates (always required, used as fallback). */
  point: InjectionPoint;
  /**
   * Optional dynamic anchor.
   * When a request matches an AgentProfile and the anchor's semantic slot can be
   * resolved (resolveSlot hits a concrete structural key), the content lands
   * precisely via the anchor; otherwise the anchor is ignored and the hook falls
   * back to `point`. This is a pure-additive field — existing hooks need no change.
   */
  anchor?: AnchorTarget;
  /** Execution priority (lower = higher priority). */
  priority: HookPriority;
  /** Human-readable description (for debugging/logging). */
  description: string;
  /**
   * Optional caching strategy (default: "none" → existing per-request behavior).
   * See {@link CacheStrategy} for semantics.
   */
  cacheStrategy?: CacheStrategy;
  /**
   * Optional prewarm hook. Called once at session_init when
   * `cacheStrategy ∈ {"session_init", "hybrid"}`. Returns the blocks to be
   * persisted into the per-session cache. If omitted or throwing, the hook
   * silently degrades to having no cached blocks (equivalent to `none`).
   */
  prewarm?(input: PrewarmInput): Promise<ContextBlock[]> | ContextBlock[];
  /**
   * Execute the hook.
   * @param ctx Current AgentContext (may have been modified by earlier hooks).
   * @returns ContextBlocks to inject. Return empty array to skip injection.
   */
  execute(ctx: AgentContext): Promise<ContextBlock[]> | ContextBlock[];
}

// ── Hook Registry ─────────────────────────────────────────────────────────────

/**
 * Registry for managing injection hooks.
 */
export interface HookRegistry {
  /** Register a hook. */
  register(hook: InjectionHook): void;
  /** Unregister a hook by ID. */
  unregister(hookId: string): void;
  /** Get all hooks for a specific injection point, sorted by priority. */
  getHooks(point: InjectionPoint): InjectionHook[];
  /** Get all registered hooks. */
  getAll(): InjectionHook[];
}
