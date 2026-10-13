/**
 * Context Injection Module — Public API.
 *
 * This module provides:
 * - Type definitions (AgentContext, InjectionHook, InjectionPoint, etc.)
 * - HookRegistry for registering injection hooks
 * - InjectionPipeline for executing the full injection flow
 * - Protocol adapters (OpenAI, Anthropic)
 * - Context utility functions
 */

// Types
export type {
  AgentContext,
  AgentContextMetadata,
  AgentTool,
  AnchorRelation,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  ContextBlockType,
  ContextMessage,
  HookPriority,
  HookRegistry,
  InjectionHook,
  InjectionPoint,
  MessageRole,
  PrewarmInput,
  Protocol,
  SemanticSlot,
} from "./types.js";
export { HOOK_PRIORITY, INJECTION_POINTS } from "./types.js";

// Agent adaptation layer
export type { AgentProfile, PromptSegment, ResolvedAnchor, SegmentKind } from "./agents/interface.js";

// Content provider + generic hook factory
export type { ContextContentProvider, InjectionHookSpec } from "./provider.js";
export { createInjectionHook } from "./provider.js";

// Context utilities
export {
  appendTextToMessage,
  createAgentContext,
  getLastUserMessage,
  getMessageText,
  getSystemMessage,
  isFirstTurn,
  prependTextToMessage,
  textBlock,
  textMessage,
} from "./context.js";

// Registry
export { HookRegistryImpl } from "./registry.js";

// Pipeline
export { InjectionPipeline } from "./pipeline.js";

// Observer (injection pipeline observability)
export type { InjectionObserver, HookResult } from "./observer.js";
export { NoopInjectionObserver, LoggingInjectionObserver } from "./observer.js";

// Prewarm runner
export { prewarmAll } from "./prewarm.js";
export type { PrewarmOptions, PrewarmResult } from "./prewarm.js";

// Adapters
export type { ProtocolAdapter } from "./adapters/interface.js";
export { OpenAIAdapter } from "./adapters/openai.js";
export { AnthropicAdapter } from "./adapters/anthropic.js";

// Injectors
export { SkillInjector } from "./injectors/skill-injector.js";
export { SkillToolsInjector } from "./injectors/skill-tools-injector.js";
export { TdaiL1RecallInjector } from "./injectors/tdai-l1-recall-injector.js";
export { TdaiProfileMemoryInjector } from "./injectors/tdai-profile-memory-injector.js";
export { TdaiToolsInjector } from "./injectors/tdai-tools-injector.js";
export { KnowledgeToolsInjector } from "./injectors/knowledge-tools-injector.js";
export { AssetReflectionInjector, renderAssetReflectionBlock } from "./injectors/asset-reflection-injector.js";

// CodeBuddy
export { isCodeBuddyPrompt, parseCodeBuddySystemPrompt } from "./agents/codebuddy/parser.js";
export { rebuildSystemPrompt, insertBeforeTag, insertAfterTag, appendInsideTag, prependInsideTag } from "./agents/codebuddy/serializer.js";
export { detectUnknownTags, classifyTags } from "./agents/codebuddy/constants.js";
export { CodeBuddyProfile } from "./agents/codebuddy/profile.js";

// Claude Code
export { ClaudeCodeProfile } from "./agents/claude-code/index.js";

// WorkBuddy — independent client (structurally XML-tag, wire protocol OpenAI/Responses).
// Deliberately kept as a distinct namespace with duplicated logic; no cross-imports
// from codebuddy/codex/claude-code.
export {
  WorkbuddyProfile,
  parseWorkbuddySystemPrompt,
  isWorkbuddyPrompt,
  WORKBUDDY_KNOWN_TAGS,
} from "./agents/workbuddy/index.js";

// ── Pipeline Factory ──────────────────────────────────────────────────────────

import os from "os";
import type { ProxyConfig } from "../types.js";
import { InjectionPipeline } from "./pipeline.js";
import { HookRegistryImpl } from "./registry.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { SkillInjector } from "./injectors/skill-injector.js";
import { SkillToolsInjector } from "./injectors/skill-tools-injector.js";
import { TdaiProfileMemoryInjector } from "./injectors/tdai-profile-memory-injector.js";
import { TdaiToolsInjector } from "./injectors/tdai-tools-injector.js";
import { KnowledgeToolsInjector } from "./injectors/knowledge-tools-injector.js";
import { AssetReflectionInjector } from "./injectors/asset-reflection-injector.js";
import type { ProtocolAdapter } from "./adapters/interface.js";
import type { AgentProfile } from "./agents/interface.js";
import { CodeBuddyProfile } from "./agents/codebuddy/profile.js";
import { ClaudeCodeProfile } from "./agents/claude-code/index.js";
import { WorkbuddyProfile } from "./agents/workbuddy/profile.js";
import { PiProfile } from "./agents/pi/index.js";
import { getHookCacheRepo, setHookCacheRepo, type HookCacheRepo } from "../db/hookCacheRepo.js";
import { getSessionRepo, setSessionRepo, type SessionRepo } from "../db/sessionRepo.js";
import { getRedisClient } from "../db/redis-client.js";
import { RedisSessionRepo } from "../db/redis-session-repo.js";
import { RedisHookCacheRepo } from "../db/redis-hook-cache-repo.js";
import { RedisBindingRepo } from "../db/binding-repo.js";
import { KvSessionRepo } from "../db/kv-session-repo.js";
import { KvHookCacheRepo } from "../db/kv-hook-cache-repo.js";
import { KvBindingRepo } from "../db/kv-binding-repo.js";
import { getProxyStorage, getEffectiveBackend } from "../storage/factory.js";
import { FsStorage } from "../storage/fs-storage.js";
import { getSessionStore } from "../session/store.js";
import type { HookRegistry, PrewarmInput } from "./types.js";
import { prewarmAll, type PrewarmOptions, type PrewarmResult } from "./prewarm.js";
import { LoggingInjectionObserver, NoopInjectionObserver, LangfuseInjectionObserver } from "./observer.js";

// ... (rest)

interface PipelineBundle {
  pipeline: InjectionPipeline;
  registry: HookRegistry;
  hookCacheRepo?: HookCacheRepo;
}

let cachedBundle: PipelineBundle | null = null;
let cachedConfigHash = "";

/**
 * Try to activate ProxyStorage (Kv*Repo) if `storage.enabled`.
 *
 * When active, replaces the RedisSessionRepo / RedisHookCacheRepo /
 * RedisBindingRepo entirely with their Kv* equivalents.
 *
 * Returns true iff ProxyStorage repos were installed (Redis path bypassed).
 */
export function tryActivateStorage(config: ProxyConfig): boolean {
  if (!config.storage?.enabled) return false;
  try {
    const storage = getProxyStorage(config.storage);
    setSessionRepo(new KvSessionRepo(storage));
    setHookCacheRepo(new KvHookCacheRepo(storage));
    const store = getSessionStore();
    store.setBindingRepo(new KvBindingRepo(storage));
    const eff = getEffectiveBackend();
    console.log(
      `[injection] activated ProxyStorage (requested=${eff.requested}, effective=${eff.effective})`,
    );
    return true;
  } catch (err) {
    console.warn(
      "[injection] ProxyStorage init failed, falling back to Redis/SQLite:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Try to activate Redis repos. Called once at pipeline build time, also exported for early activation. */
export function tryActivateRedis(config: ProxyConfig): boolean {
  if (!config.redis?.enabled) return false;
  try {
    const redis = getRedisClient(config.redis);
    if (!redis) return false;

    const ttl = config.redis.injectionTtlSeconds;
    setSessionRepo(new RedisSessionRepo(redis, ttl));
    setHookCacheRepo(new RedisHookCacheRepo(redis, ttl));
    const store = getSessionStore();
    store.setBindingRepo(new RedisBindingRepo(redis));
    console.log("[injection] activated Redis storage");
    return true;
  } catch (err) {
    console.warn("[injection] Redis unavailable, falling back to SQLite:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * The session binding must always be persisted; there is no pure in-memory run mode.
 *
 * If neither storage nor redis is activated (bindingRepo is still undefined),
 * automatically create a KvBindingRepo on fs as a fallback.
 *
 * Default path: ~/.memory-tencentdb/proxy-state/ (sibling of MemoryCore's
 * ~/.memory-tencentdb/memory-tdai/, keeping project data together).
 * Can be overridden via config.storage.fs.fsRoot or the environment variable PROXY_DATA_DIR.
 *
 * Degradation: if fs creation fails (insufficient permissions, disk full, etc.) -> log a warn and fall back to in-memory logic,
 * without blocking proxy startup. Users can use it online, but must session-init again after a proxy restart.
 */
export function ensureBindingRepoPersistent(config: ProxyConfig): void {
  const store = getSessionStore();
  if (store.getBindingRepo()) return; // already present (storage/redis was activated)

  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const defaultFsRoot = `${home}/.memory-tencentdb/proxy-state`;
  const fsRoot = process.env.PROXY_DATA_DIR || config.storage?.fs?.fsRoot || defaultFsRoot;

  try {
    const fsStorage = new FsStorage(fsRoot);
    store.setBindingRepo(new KvBindingRepo(fsStorage));
    console.log(`[injection] bindingRepo fallback → fs (${fsRoot})`);
  } catch (err) {
    // Degradation: when fs is unavailable fall back to in-memory logic, without blocking startup.
    // The proxy runs normally, but bindings are lost after a restart -> users must session-init again.
    console.warn(
      `[injection] fs bindingRepo at ${fsRoot} failed: ${(err as Error).message}. ` +
      `Falling back to in-memory — session bindings will NOT persist across restarts.`,
    );
  }
}

/** Resolve `HookCacheRepo`. `getHookCacheRepo()` self-degrades to a NullRepo
 *  when better-sqlite3 is absent, so callers always receive a usable instance. */
function tryLoadHookCacheRepo(): HookCacheRepo | undefined {
  try {
    return getHookCacheRepo();
  } catch (err) {
    console.warn(
      "[injection] hook-cache repo unavailable, hooks will run without caching:",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

function buildPipelineBundle(config: ProxyConfig): PipelineBundle {
  const registry = new HookRegistryImpl();
  const adapters = new Map<string, ProtocolAdapter>();
  adapters.set("openai", new OpenAIAdapter());
  adapters.set("anthropic", new AnthropicAdapter());

  // Register configured injectors. Each injector reads its own kernel config
  // (`coreSkill`, `tdai`, ...); there is no shared external endpoint anymore.
  const injectors = config.injection?.injectors ?? [];

  // proxyBaseUrl is shared between skill-tools-injector and tdai-tools-injector.
  //
  // ⚠️ Multi-node deployments must explicitly configure `injection.externalGatewayUrl` (the gateway's external domain,
  // e.g. https://gateway.example.com) -- otherwise each pod would embed
  // its own host:port into the `<skill_tools>` / `<tdai_memory_tools>` text,
  // pods overwrite each other's hook cache, and the upstream KV cache misses every time.
  //
  // When unset, falls back to the local host:port (only usable in single-node / local development), warning once at startup.
  let proxyBaseUrl: string | undefined;
  if (injectors.includes("skill") || (injectors.includes("tdai-memory") && config.tdai.enabled)) {
    const externalBase = config.injection?.externalGatewayUrl;
    if (externalBase && externalBase.length > 0) {
      proxyBaseUrl = externalBase.replace(/\/$/, "");
      console.log(`[injection] proxyBaseUrl (from injection.externalGatewayUrl) = ${proxyBaseUrl}`);
    } else {
      let hostIp = config.server.host;
      if (hostIp === "0.0.0.0" || hostIp === "127.0.0.1") {
        const interfaces = os.networkInterfaces();
        let foundIp = "";
        for (const name of Object.keys(interfaces)) {
          const iface = interfaces[name];
          if (!iface) continue;
          for (const entry of iface) {
            if (entry.family === "IPv4" && !entry.internal) {
              foundIp = entry.address;
              break;
            }
          }
          if (foundIp) break;
        }
        hostIp = foundIp || "127.0.0.1";
      }
      proxyBaseUrl = `http://${hostIp}:${config.server.port}`;
      console.warn(
        `[injection] injection.externalGatewayUrl not set — falling back to ` +
        `${proxyBaseUrl}. This causes hook cache thrashing + upstream KV-cache misses ` +
        `in multi-node deployments; set injection.externalGatewayUrl to the shared ` +
        `gateway domain (e.g. https://gateway.example.com).`,
      );
    }
  }

  if (injectors.includes("skill")) {
    // RAG-driven `<cloud_skills>` block. Calls /v3/skill/search at prewarm time.
    // When coreSkill is unconfigured (no serviceToken), the searchSkills call
    // will fail and the injector silently degrades to no <cloud_skills> block.
    //
    // `defaultTaskId` (from sessionInit config, defaults to "default") is passed
    // through so the injector can detect the virtual default-task fallback and
    // switch to activity-based recall. When absent (deployment turned off the default task),
    // the activity-mode gate is always false and listing uses the original BM25 logic -- fully backward compatible.
    // Design: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md
    registry.register(
      new SkillInjector({
        coreSkill: config.coreSkill,
        defaultTaskId: config.sessionInit?.defaultTaskId,
      }),
    );

    // Always inject the curl-recipe `<skill_tools>` block alongside the
    // dynamic `<cloud_skills>` block. Even when there are no skills to
    // recommend, the LLM still needs to know how to create / search them.
    const allowLlmWrite = config.skillRuntime?.allowLlmWrite ?? false;
    registry.register(new SkillToolsInjector({ proxyBaseUrl: proxyBaseUrl!, allowLlmWrite }));
  }

  if (injectors.includes("knowledge")) {
    // Knowledge tools injector — fetches team knowledge from kernel and
    // renders <knowledge_tools> prompt block with two-step self-discovery flow.
    // Independent `knowledge:` config (endpoint can diverge from skill).
    if (shouldRegisterKnowledgeInjector(config)) {
      registry.register(new KnowledgeToolsInjector({
        coreSkill: config.knowledge,
      }));
    }
  }

  if (injectors.includes("tdai-memory") && config.tdai.enabled && config.tdai.memory.enabled && config.tdai.memory.inject) {
    // Base TdaiClient config. `TdaiProfileMemoryInjector` rebuilds a per-request
    // TdaiClient with `serviceId := session.space_id || baseConfig.serviceId`
    // so writes/recalls hit the correct kernel tenant (was hard-coded to
    // `config.tdai.serviceId` before; broke multi-tenant tests).
    const tdaiBaseConfig = {
      enabled: config.tdai.enabled && config.tdai.memory.enabled,
      endpoint: config.tdai.endpoint,
      apiKey: config.tdai.apiKey,
      serviceId: config.tdai.serviceId,
      writeL0: config.tdai.memory.writeL0,
      recallL1: config.tdai.memory.recallL1,
      injectL2L3: config.tdai.memory.injectL2L3,
      l1Limit: config.tdai.memory.l1Limit,
      l2Limit: config.tdai.memory.l2Limit,
      timeoutMs: config.tdai.memory.timeoutMs,
    };
    // fixed-asset-agents (self + borrowed <=2) are fetched through the kernel MetadataClient;
    // when the kernel is unreachable the injector automatically degrades to "only query the current agent's memory".
    if (config.tdai.memory.injectL2L3) {
      registry.register(new TdaiProfileMemoryInjector(tdaiBaseConfig, config.coreSkill));
    }
    // Note: L0/L1 are no longer auto-recalled and injected into the user prompt every round (it would break the KV/prompt cache).
    // Instead, read-only tools are exposed only in the system prompt (see TdaiToolsInjector), reusing the system
    // prompt cache. The L1 recall injector is offline; the recallL1 config is kept but no longer registered.
    // Companion profile-memory-injector: L2 injects only the path index; the LLM calls read-only tools via Bash curl
    // <proxy>/memory-bridge/v3/*. The proxy injects identity automatically.
    // proxyBaseUrl reuses the one computed by skill-tools-injector (same host:port).
    if (typeof proxyBaseUrl !== "undefined") {
      registry.register(new TdaiToolsInjector({ proxyBaseUrl }));
    }
  }

  // -- Asset Reflection (internal effect evaluation) ---------------------------------
  // Enabled by default (markerOptIn=true) -- pods without assetReflection configured also register
  // this injector. Registering merely adds it to the registry; when the marker is not hit, execute() directly
  // returns [], and the prompt of normal requests is completely unchanged; only requests whose URL carries the `/analyse` marker
  // actually emit the block. The Tag list is derived from "the asset injectors actually registered on this node",
  // to avoid making the LLM reflect on an asset that this node never integrated.
  //
  // When markerOptIn=false is explicitly configured the injector does not register, and the gate at the top of server.ts
  // rejects any request carrying an `/analyse/` segment with 404.
  if (config.injection?.assetReflection?.markerOptIn) {
    const registeredIds = new Set(registry.getAll().map((h) => h.id));
    const activeAssetTags: string[] = [];
    // Skill family: SkillInjector emits <available_skills>, SkillToolsInjector emits <skill_tools>;
    // the two injectors are enabled together (see `if (injectors.includes("skill"))` above); either being present counts as a skill asset hit.
    if (registeredIds.has("skill-injector") || registeredIds.has("skill-tools-injector")) {
      activeAssetTags.push("skill_tools");
      activeAssetTags.push("available_skills");
    }
    if (registeredIds.has("tdai-memory-tools-injector")) {
      activeAssetTags.push("tdai_memory_tools");
    }
    if (registeredIds.has("knowledge-tools-injector")) {
      activeAssetTags.push("knowledge_tools");
    }
    if (activeAssetTags.length > 0) {
      registry.register(new AssetReflectionInjector({ activeAssetTags }));
      console.log(`[injection] asset-reflection registered, tags=[${activeAssetTags.join(",")}]`);
    } else {
      console.log(`[injection] asset-reflection markerOptIn=true but this node has no asset injector, skipping register`);
    }
  }

  // Activate storage backend if configured (before loading repos).
  // ProxyStorage (COS/SQLite/FS/Memory) takes precedence when storage.enabled;
  // otherwise fall back to the original Redis path.
  if (!tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  // The session binding must always be persisted -- there is no pure in-memory mode.
  // If neither storage nor redis is activated, use fs as the bindingRepo fallback.
  ensureBindingRepoPersistent(config);

  const hookCacheRepo = tryLoadHookCacheRepo();

  // Observer: prefer Langfuse (injection spans under LLM trace) when enabled;
  // fall back to structured logging when log level ≤ info; else noop.
  const observer = config.langfuse?.enabled
    ? new LangfuseInjectionObserver()
    : (config.log?.level === "debug" || config.log?.level === "info")
      ? new LoggingInjectionObserver()
      : new NoopInjectionObserver();

  const pipeline = new InjectionPipeline(registry, adapters, {
    hookCacheRepo,
    // Agent profile registry — lookup by URL path prefix (agentSource).
    // Adding a new agent only adds a line here. The legacy detectAgent
    // (content-scanning) is kept as fallback for un-prefixed paths.
    agentProfiles: new Map<string, AgentProfile>([
      ["codebuddy", new CodeBuddyProfile()],
      ["claude-code", new ClaudeCodeProfile()],
      ["workbuddy", new WorkbuddyProfile()],
      ["pi", new PiProfile()],
      // ["cursor", new CursorProfile()],
    ]),
    // Legacy fallback: scan system prompt content (for backward compat).
    detectAgent: (() => {
      const agentProfiles: AgentProfile[] = [
        new CodeBuddyProfile(),
        new ClaudeCodeProfile(),
        new WorkbuddyProfile(),
      ];
      return (systemText: string) =>
        agentProfiles.find((p) => p.detect(systemText)) ?? null;
    })(),
  }, observer);

  return { pipeline, registry, hookCacheRepo };
}

function getOrBuildBundle(config: ProxyConfig): PipelineBundle {
  const configHash = JSON.stringify({
    injection: config.injection,
    tdai: config.tdai,
    coreSkill: config.coreSkill,
    knowledge: config.knowledge,
    server: config.server,
  });
  if (cachedBundle && cachedConfigHash === configHash) {
    return cachedBundle;
  }
  cachedBundle = buildPipelineBundle(config);
  cachedConfigHash = configHash;
  return cachedBundle;
}

/**
 * Get or create an InjectionPipeline configured from ProxyConfig.
 * The pipeline is cached and reused for the lifetime of the config.
 */
export function getInjectionPipeline(config: ProxyConfig): InjectionPipeline {
  return getOrBuildBundle(config).pipeline;
}

/**
 * Drive `prewarmAll` against the same HookRegistry / HookCacheRepo used by
 * the live pipeline. Intended for the session_init hot path: call this once
 * per session immediately after the control plane returns `sessionInfo`.
 *
 * Errors are NEVER thrown — caller can safely `await` without try/catch.
 */
export async function prewarmFromConfig(
  config: ProxyConfig,
  input: PrewarmInput,
  opts?: PrewarmOptions,
): Promise<PrewarmResult> {
  const bundle = getOrBuildBundle(config);
  // No persistence layer or no hooks declaring strategy → noop with empty result.
  if (!bundle.hookCacheRepo) {
    return { cachedHookIds: [], skipped: [], durationMs: 0 };
  }
  try {
    return await prewarmAll(bundle.registry, bundle.hookCacheRepo, input, opts);
  } catch (err) {
    console.warn(
      "[hook-cache] prewarmFromConfig swallowed error:",
      err instanceof Error ? err.message : String(err),
    );
    return { cachedHookIds: [], skipped: [], durationMs: 0 };
  }
}

/**
 * Pure predicate: should the knowledge-tools injector be registered?
 * Exposed for unit tests (registry itself is not publicly introspectable).
 *
 * Conditions (all must hold):
 *   1. `injection.injectors` includes "knowledge"
 *   2. `knowledge.enabled` is true
 *   3. `knowledge.serviceToken` is non-empty
 */
export function shouldRegisterKnowledgeInjector(config: ProxyConfig): boolean {
  return config.injection.injectors.includes("knowledge")
    && config.knowledge.enabled
    && !!config.knowledge.serviceToken;
}

/** Test-only: drop the cached pipeline so the next call rebuilds from config. */
export function __resetInjectionPipelineForTests(): void {
  cachedBundle = null;
  cachedConfigHash = "";
}
