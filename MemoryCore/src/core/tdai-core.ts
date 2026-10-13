/**
 * TdaiCore — Host-neutral facade for TDAI memory capabilities.
 *
 * This is the single entry point that both OpenClaw and Hermes/Gateway call
 * to perform recall, capture, search, and pipeline management. It depends
 * only on abstract interfaces (HostAdapter, LLMRunner), never on a specific host.
 *
 * Usage:
 *   // OpenClaw path (in-process)
 *   const adapter = new OpenClawHostAdapter({ api, pluginDataDir, config });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 *   await core.initialize();
 *   const recall = await core.handleBeforeRecall("user query", "session-1");
 *
 *   // Gateway path (HTTP)
 *   const adapter = new StandaloneHostAdapter({ ... });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 *   await core.initialize();
 *   // HTTP handler calls core.handleBeforeRecall / core.handleTurnCommitted / etc.
 */

import type {
  HostAdapter,
  Logger,
  LLMRunnerFactory,
  RecallResult,
  CaptureResult,
  CompletedTurn,
  MemorySearchParams,
  ConversationSearchParams,
} from "./types.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { IMemoryStore } from "./store/types.js";
import type { EmbeddingService } from "./store/embedding.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { performAutoRecall } from "./hooks/auto-recall.js";
import { reportRecallMetrics } from "./report/metric-tracking-recall.js";
import { performAutoCapture } from "./hooks/auto-capture.js";
import { executeMemorySearch, formatSearchResponse } from "./tools/memory-search.js";
import { executeConversationSearch, formatConversationSearchResponse } from "./tools/conversation-search.js";
import {
  initDataDirectories,
  initStores,
  resetStores,
  createPipelineManager,
  createL1Runner,
  createPersister,
  createL2Runner,
  createL3Runner,
} from "../utils/pipeline-factory.js";
import { MemoryPipelineManager } from "../utils/pipeline-manager.js";
import { CheckpointManager } from "../utils/checkpoint.js";
import { SessionFilter } from "../utils/session-filter.js";
import { StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "../adapters/standalone/llm-runner.js";
import { resolveStandaloneLlmForRuntime } from "../adapters/standalone/llm-provider-resolver.js";
import { MetricTrackingRunnerFactory } from "./report/metric-tracking-runner.js";

// ── Skill module (v2 redesign 2026-06-17) ──
import {
  SkillCore,
  SkillResourceStore,
  SkillVersioning,
  SqliteSkillStore,
  SkillExtractor,
  resolveSkillConfig,
  SKILL_REVIEW_PROMPT,
  SKILL_REVIEW_PROMPT_STRICT,
} from "./skill/index.js";
// Skill async-extract now goes entirely through the conversation-add side's agent queue + Worker
// (SkillTriggerService.archive → agent queue → SkillConversationExtractWorker),
// started by wireConversationAdd in the gateway/openclaw host wiring. tdai-core is only responsible for
// constructing the SkillExtractor singleton for the wire layer to use.
import type {
  ResolvedSkillConfig,
  SkillEnvProbe,
  ExtractorLLMRunner,
} from "./skill/index.js";
import type { Skill } from "./skill/types.js";

const TAG = "[memory-tdai] [core]";

/**
 * Injection point for Skill lifecycle hooks. Used to sync skill create/access/archive events to
 * the upper-layer asset registry (`meta_assets` + `meta_agent_fixed_assets`), implementing semantics such as "a skill is
 * immediately visible on the frontend management page after creation" and "agent bindings are cleared after a skill is archived".
 *
 * The contract is fully consistent with `SkillVersioningOptions.onSkillCreated` / `SkillCoreOptions.onSkillArchived`
 * / `SkillCoreOptions.onSkillAccessed` (see the docs in skill-versioning.ts and
 * skill-core.ts):
 *   - onSkillCreated: awaited before the first v1 creation; throwing = create fails
 *   - onSkillAccessed: fire-and-forget; exceptions are swallowed inside SkillCore
 *   - onSkillArchived: fire-and-forget; exceptions are swallowed inside SkillCore
 *
 * Why this is needed (standalone / OpenClaw mode):
 *   In service mode gateway/server.ts:resolveSkillCore already attaches hooks of the same name;
 *   in standalone / OpenClaw mode SkillCore is constructed globally by TdaiCore, and previously no hooks were attached,
 *   so any call path that bypasses the gateway handler (CLI / future embedding / the synchronous skill.extract branch)
 *   would not register assets, and handleGet / handleFilesRead had no fallback at all, so read-time self-healing did not work.
 *   This options object lets the upper layer (e.g. the gateway or the openclaw plugin) selectively inject hooks,
 *   bringing the asset linkage semantics into the standalone / OpenClaw path.
 */
export interface SkillAssetHooks {
  onSkillCreated?: (params: {
    skill_id: string;
    team_id?: string;
    agent_id?: string;
    user_id?: string;
    name: string;
    description: string;
  }) => Promise<void>;
  onSkillAccessed?: (skill: Skill) => void;
  onSkillArchived?: (params: { skill_id: string; team_id?: string }) => void;
}

// ============================
// Constructor options
// ============================

export interface TdaiCoreOptions {
  /** Host adapter providing runtime context, logger, and LLM runner factory. */
  hostAdapter: HostAdapter;
  /** Parsed TDAI memory configuration. */
  config: MemoryTdaiConfig;
  /** Session filter for excluding internal/benchmark sessions. */
  sessionFilter?: SessionFilter;
  /** Plugin instance ID for metric reporting. */
  instanceId?: string;
  /** StorageAdapter for file operations (COS/local). When absent, modules fall back to fs. */
  storage?: StorageAdapter;
  /**
   * Optional: hooks that sync skill lifecycle events to the upper-layer asset registry.
   *
   * Injected on demand by the host wiring layer (gateway/openclaw plugin) when constructing TdaiCore; once injected,
   * SkillCore in standalone / OpenClaw mode behaves the same as in service mode. See the doc of
   * `SkillAssetHooks`.
   *
   * Not injected (undefined) → SkillCore/SkillVersioning attach no hooks and keep existing behavior
   * (zero coupling: OpenClaw without MetadataService can still be constructed safely).
   */
  skillAssetHooks?: SkillAssetHooks;
}

// ============================
// TdaiCore
// ============================

export class TdaiCore {
  private hostAdapter: HostAdapter;
  private cfg: MemoryTdaiConfig;
  private logger: Logger;
  private dataDir: string;
  private runnerFactory: LLMRunnerFactory;
  private sessionFilter: SessionFilter;
  private instanceId?: string;
  private storage?: StorageAdapter;

  // Lazy-initialized resources
  private vectorStore?: IMemoryStore;
  private embeddingService?: EmbeddingService;
  private scheduler?: MemoryPipelineManager;
  /**
   * Promise gate for the one-shot scheduler-start sequence.
   *
   * ``ensureSchedulerStarted`` reads a checkpoint file (async) and then
   * calls ``scheduler.start(restoredStates)``.  Under the Gateway, several
   * HTTP requests can reach ``handleTurnCommitted`` concurrently and all
   * race into that function.  Using a plain boolean flag is unsafe: the
   * first caller flips the flag to ``true`` *before* the await completes,
   * so subsequent callers slip past the check and touch the scheduler
   * before ``start()`` has actually run — which makes ``start()``'s
   * ``sessionStates.set(key, restored)`` later clobber the state that
   * those concurrent captures already incremented.
   *
   * Storing the in-flight promise lets every concurrent caller ``await``
   * the same start sequence.  Once it resolves the promise is kept as a
   * sentinel so subsequent calls are a single already-resolved await
   * (effectively a no-op).
   */
  private schedulerStartPromise?: Promise<void>;
  private storeReady?: Promise<void>;

  // ── Skill module (v2 redesign 2026-06-17) ──
  // Constructed in ensureSkillModuleWired after vectorStore + storage are ready,
  // gated on cfg.skill?.enabled and resolveSkillConfig's degradation matrix.
  private skillCore?: SkillCore;
  private skillExtractor?: SkillExtractor;
  private resolvedSkillConfig?: ResolvedSkillConfig;
  /**
   * Optional: skill lifecycle hooks, used to sync create/access/archive to the upper-layer asset registry.
   * See the doc of `SkillAssetHooks`. undefined = no hooks attached (existing standalone legacy behavior).
   */
  private skillAssetHooks?: SkillAssetHooks;
  /**
   * B1 fix: in-flight guard for `ensureSkillModuleWired()`. The original guard
   * was a sync `if (this.skillCore) return`, but assignment to `skillCore`
   * happens AFTER `await storeReady` + SkillCore/queue construction. Two
   * concurrent callers (`initialize()` → storeReady.then chain, and
   * `setStorage()`'s re-trigger) would both slip past the guard and each
   * construct a full SkillCore + extract worker.
   *
   * Storing the in-flight promise lets every concurrent caller await the same
   * wiring sequence. On success the promise stays as a sentinel and
   * subsequent calls fall through to the fast-path `if (this.skillCore)
   * return`. On failure the promise is cleared so a later `setStorage()` +
   * explicit `ensureSkillModuleWired()` can retry.
   */
  private skillWiringPromise?: Promise<void>;

  /**
   * In-flight fire-and-forget background tasks started by
   * ``handleTurnCommitted`` (currently: deferred L0 embedding for
   * SQLite-style stores — see auto-capture.ts path A).
   *
   * ``destroy()`` awaits all pending entries (with a hard timeout)
   * before closing ``vectorStore`` / ``embeddingService`` so that a
   * late ``updateL0Embedding`` cannot land on an already-closed
   * database connection.
   *
   * Each task registers itself on creation and removes itself in its
   * own ``finally`` handler, so the set stays bounded by the number
   * of currently-running background tasks.
   */
  private readonly bgTasks = new Set<Promise<void>>();

  constructor(opts: TdaiCoreOptions) {
    this.hostAdapter = opts.hostAdapter;
    this.cfg = opts.config;
    this.logger = opts.hostAdapter.getLogger();
    this.dataDir = opts.hostAdapter.getRuntimeContext().dataDir;
    this.runnerFactory = opts.hostAdapter.getLLMRunnerFactory();
    this.sessionFilter = opts.sessionFilter ?? new SessionFilter([]);
    this.instanceId = opts.instanceId;
    this.storage = opts.storage;
    this.skillAssetHooks = opts.skillAssetHooks;
  }

  // ============================
  // Lifecycle
  // ============================

  /**
   * Initialize data directories, storage, and pipeline scheduler.
   * Must be called once before any other methods.
   */
  async initialize(): Promise<void> {
    this.logger.debug?.(`${TAG} Initializing TDAI Core: dataDir=${this.dataDir}`);
    initDataDirectories(this.dataDir);

    // Initialize stores (async)
    this.storeReady = this.initStores();

    // Create pipeline manager (sync — does not need store)
    if (this.cfg.extraction.enabled) {
      this.scheduler = createPipelineManager(this.cfg, this.logger, this.sessionFilter);
      // Wire runners after store is ready (or after store init fails — runners
      // still work in degraded mode with JSONL fallback and no embedding)
      this.storeReady
        .then(() => this.wirePipelineRunners())
        .catch((err) => {
          this.logger.error(`${TAG} Store init failed; wiring pipeline runners in degraded mode: ${err instanceof Error ? err.message : String(err)}`);
          this.wirePipelineRunners();
        });
    }

    // ── Skill module wiring ──
    // Independent of extraction.enabled: even when L1/L2/L3 extraction is off,
    // skill management (CRUD/listing/search) should still work as long as the
    // user opted in via cfg.skill.enabled. Construction requires BOTH
    // vectorStore (raw DatabaseSync handle) AND storage (StorageAdapter for
    // SKILL.md / resources). Storage may be set later via setStorage() (the
    // gateway sets it AFTER core.initialize() finishes), so the host wiring
    // layer is responsible for calling `ensureSkillModuleWired()` at the
    // right moment — typically right after setStorage(). This method is a
    // no-op if already wired or if the gates aren't satisfied yet.
    //
    // We DO start the wiring eagerly here too, so OpenClaw's in-process path
    // (which constructs storage before calling core methods) gets it for
    // free; but the gateway's HTTP path will rely on the post-setStorage
    // call to actually land it.
    if (this.cfg.skill?.enabled) {
      this.storeReady
        .then(() => this.ensureSkillModuleWired())
        .catch((err) => {
          this.logger.warn(
            `${TAG} Store init failed; skill module wiring skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    this.logger.debug?.(`${TAG} TDAI Core initialized`);
  }

  /**
   * Destroy all resources. Call on shutdown.
   */
  async destroy(): Promise<void> {
    this.logger.debug?.(`${TAG} Destroying TDAI Core...`);

    // Wait for store init to complete before tearing down
    await this.storeReady?.catch(() => {});

    if (this.scheduler && this.schedulerStartPromise) {
      await this.scheduler.destroy();
      this.schedulerStartPromise = undefined;
      this.logger.debug?.(`${TAG} Scheduler destroyed`);
    }

    // Skill async-extract worker + queue are started by the gateway/openclaw side's wireConversationAdd
    // and are also gracefully shut down in their own WiredConversationAdd.stop(). tdai-core
    // does not need to stop the skill-side worker/queue here (it no longer holds them).

    // Drain fire-and-forget background tasks started by auto-capture
    // (currently: deferred L0 embedding writes).  We must wait for
    // them here — BEFORE closing vectorStore / embeddingService —
    // otherwise a late updateL0Embedding lands on an already-closed
    // DB connection and either throws "database is not open" or
    // (worse) corrupts state.  A hard timeout keeps destroy bounded
    // when a background task is stuck on a hung embed HTTP call.
    if (this.bgTasks.size > 0) {
      const pending = [...this.bgTasks];
      this.logger.debug?.(
        `${TAG} Draining ${pending.length} background task(s) before closing stores...`,
      );
      const BG_DRAIN_TIMEOUT_MS = 5_000;
      let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending).then(() => undefined),
          new Promise<never>((_, reject) => {
            drainTimeoutId = setTimeout(
              () => reject(new Error("bgTasks drain timeout")),
              BG_DRAIN_TIMEOUT_MS,
            );
          }),
        ]);
        this.logger.debug?.(`${TAG} Background tasks drained`);
      } catch (err) {
        this.logger.warn(
          `${TAG} Background-task drain timed out (${BG_DRAIN_TIMEOUT_MS}ms): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Closing stores anyway — residual writes may surface as warnings.`,
        );
      } finally {
        if (drainTimeoutId !== undefined) clearTimeout(drainTimeoutId);
      }
    }

    if (this.vectorStore) {
      this.vectorStore.close();
      this.vectorStore = undefined;
      this.logger.debug?.(`${TAG} VectorStore closed`);
    }

    if (this.embeddingService?.close) {
      try {
        await this.embeddingService.close();
      } catch (err) {
        this.logger.warn(`${TAG} EmbeddingService close error: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.embeddingService = undefined;
    }

    resetStores(this.dataDir);
    this.logger.debug?.(`${TAG} TDAI Core destroyed`);
  }

  // ============================
  // Core capabilities
  // ============================

  /**
   * Handle recall (memory retrieval) before an LLM turn.
   * Maps to: OpenClaw `before_prompt_build` / Hermes `prefetch()`.
   */
  async handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult> {
    await this.storeReady?.catch(() => {});

    const tStart = performance.now();
    const result = await performAutoRecall({
      userText,
      actorId: "default_user",
      sessionKey,
      cfg: this.cfg,
      pluginDataDir: this.dataDir,
      logger: this.logger,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      storage: this.storage,
    });
    const recallLatencyMs = performance.now() - tStart;

    // Non-intrusive reporting of recall metrics (fail silently, never affect the business return)
    try {
      const recallResult = result ?? {};
      reportRecallMetrics({
        instanceId: this.instanceId ?? "",
        recalledL1Memories: recallResult.recalledL1Memories,
        recallStrategy: recallResult.recallStrategy ?? "skipped",
        recallLatencyMs,
        hasError: !!recallResult.error,
      });
    } catch {
      // fail silently
    }

    return result ?? {};
  }

  /**
   * Handle turn commitment (conversation capture + pipeline trigger).
   * Maps to: OpenClaw `agent_end` / Hermes `sync_turn()`.
   */
  async handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult> {
    await this.storeReady?.catch(() => {});
    await this.ensureSchedulerStarted();

    return performAutoCapture({
      messages: turn.messages,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      cfg: this.cfg,
      pluginDataDir: this.dataDir,
      logger: this.logger,
      scheduler: this.scheduler,
      originalUserText: turn.userText,
      originalUserMessageCount: turn.originalUserMessageCount,
      pluginStartTimestamp: turn.startedAt ?? Date.now(),
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      bgTaskRegistry: this.bgTasks,
      storage: this.storage,
    });
  }

  /**
   * Search L1 structured memories.
   * Maps to: `tdai_memory_search` tool.
   */
  async searchMemories(params: MemorySearchParams): Promise<{ text: string; total: number; strategy: string }> {
    const result = await executeMemorySearch({
      query: params.query,
      limit: params.limit ?? 5,
      type: params.type,
      scene: params.scene,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
    });

    return {
      text: formatSearchResponse(result),
      total: result.total,
      strategy: result.strategy,
    };
  }

  /**
   * Search L0 raw conversations.
   * Maps to: `tdai_conversation_search` tool.
   */
  async searchConversations(params: ConversationSearchParams): Promise<{ text: string; total: number }> {
    const result = await executeConversationSearch({
      query: params.query,
      limit: params.limit ?? 5,
      sessionKey: params.sessionKey,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
    });

    return {
      text: formatConversationSearchResponse(result),
      total: result.total,
    };
  }

  /**
   * Handle end-of-conversation for a single session.
   *
   * ⚠️ Read this if you are editing the method:
   *
   * There are two distinct shutdown-ish events, and they must **NOT**
   * share an implementation:
   *
   *   - **`gateway_stop` (OpenClaw / process exit)**
   *     The host is going away.  Tear everything down — scheduler,
   *     VectorStore, EmbeddingService, caches.  That is
   *     {@link destroy}, not this method.
   *
   *   - **`on_session_end` (Hermes) / `POST /session/end` (Gateway)**
   *     One conversation ended while the process keeps serving other
   *     concurrent sessions.  **Only** this session's buffered work
   *     should be flushed; every other session's timers, buffers,
   *     pipeline state, and the shared scheduler itself MUST remain
   *     untouched.  That is this method.
   *
   * Historically this method did ``scheduler.destroy() +
   * createPipelineManager()``, which conflated the two semantics and
   * wiped concurrent sessions' in-memory state on every ``/session/end``
   * call.  That bug is covered by the concurrency test
   * ``P0-1: handleSessionEnd must be scoped to its session``.
   *
   * @param sessionKey  Session whose buffered work should be flushed.
   *                    Unknown keys are tolerated as a no-op so callers
   *                    don't have to pre-check whether the session was
   *                    already evicted or never produced a capture.
   */
  async handleSessionEnd(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    await this.storeReady?.catch(() => {});
    if (!this.scheduler) return;
    await this.scheduler.flushSession(sessionKey);
  }

  // ============================
  // Accessors (for migration bridge)
  // ============================

  /** Get the LLM runner factory (for creating host-neutral LLM runners). */
  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }

  /** Get the shared VectorStore (may be undefined if init failed). */
  getVectorStore(): IMemoryStore | undefined {
    return this.vectorStore;
  }

  /** Get the shared EmbeddingService (may be undefined if not configured). */
  getEmbeddingService(): EmbeddingService | undefined {
    return this.embeddingService;
  }

  /** Get the pipeline scheduler (may be undefined if extraction disabled). */
  getScheduler(): MemoryPipelineManager | undefined {
    return this.scheduler;
  }

  /** Get the StorageAdapter (may be undefined in standalone/OpenClaw mode). */
  getStorage(): StorageAdapter | undefined {
    return this.storage;
  }

  /** Skill module facade (may be undefined when skill.enabled=false or wiring failed). */
  getSkillCore(): SkillCore | undefined {
    return this.skillCore;
  }

  /** Skill review-agent extractor (may be undefined when extraction.enabled=false or no LLM). */
  getSkillExtractor(): SkillExtractor | undefined {
    return this.skillExtractor;
  }

  /** The resolved skill config (with degradation matrix). undefined → skill not constructed. */
  getResolvedSkillConfig(): ResolvedSkillConfig | undefined {
    return this.resolvedSkillConfig;
  }

  /** Set the StorageAdapter (for service mode, injected by Gateway after config resolution). */
  setStorage(adapter: StorageAdapter): void {
    this.storage = adapter;
    this.logger.info(`${TAG} StorageAdapter set: type=${adapter.type}`);
    // Re-trigger skill wiring — the gateway path sets storage AFTER
    // initialize() finishes, so the eager promise chain in initialize()
    // would have observed `storage` as undefined and bailed.
    if (this.cfg.skill?.enabled && !this.skillCore) {
      this.ensureSkillModuleWired().catch((err) => {
        this.logger.warn(
          `${TAG} Skill module wiring failed after setStorage: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  /**
   * Replace the legacy MemoryPipelineManager with a StatefulPipelineManager.
   *
   * When STATE_BACKEND is configured, the Gateway injects a StatefulPipelineManager
   * that delegates all state to IStateBackend. This makes the Core process
   * stateless — capture calls go through captureAtomic and tasks are dispatched
   * to the Worker pool.
   *
   * The StatefulPipelineManager implements the same notifyConversation()/flushSession()
   * interface as MemoryPipelineManager, so performAutoCapture works unchanged.
   */
  setStatefulPipelineManager(manager: any): void {
    // Replace scheduler with the stateful version
    this.scheduler = manager;
    // Mark scheduler as "started" so ensureSchedulerStarted() becomes a no-op
    this.schedulerStartPromise = Promise.resolve();
    this.logger.info("[tdai-core] Switched to StatefulPipelineManager (distributed mode)");
  }

  /** Whether the scheduler has been started (or is currently starting). */
  isSchedulerStarted(): boolean {
    return this.schedulerStartPromise !== undefined;
  }

  /** Set the instance ID for metrics (may be resolved asynchronously). */
  setInstanceId(id: string): void {
    this.instanceId = id;
    if (this.scheduler) {
      this.scheduler.instanceId = id;
    }
  }

  // ============================
  // Internal helpers
  // ============================

  private async initStores(): Promise<void> {
    try {
      const stores = await initStores(this.cfg, this.dataDir, this.logger);
      this.vectorStore = stores.vectorStore;
      this.embeddingService = stores.embeddingService;
      this.logger.debug?.(`${TAG} Stores initialized: backend=${this.cfg.storeBackend}, embedding=${this.cfg.embedding.provider}`);
    } catch (err) {
      this.logger.warn(
        `${TAG} Store init failed; recall/dedup degraded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Resolves this.cfg.llm by provider into (baseUrl, apiKey, model) that can be used directly at runtime.
   * provider=openai passes through; provider=proxy replaces baseUrl with `${baseUrl}/proxy/<iid>/v1`,
   * and apiKey uses env.TDAI_MEMORY_SYSTEM_USER_KEY. Shared by the four runner factory construction sites.
   */
  private resolveRuntimeLlm(): {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
    stream: boolean;
  } {
    const resolved = resolveStandaloneLlmForRuntime(this.cfg.llm, this.instanceId);
    return {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      maxTokens: resolved.maxTokens ?? 4096,
      timeoutMs: resolved.timeoutMs ?? 120_000,
      stream: resolved.stream ?? false,
    };
  }

  /**
   * Whether this call site must override the host-provided runner factory
   * with a `StandaloneLLMRunnerFactory` built from `cfg.llm`.
   *
   * Historical rule was "only when hostType=openclaw + cfg.llm.enabled" —
   * that skipped the override in gateway/service mode, which meant
   * `provider=proxy` never got a chance to rewrite baseUrl to
   * `${base}/proxy/<iid>/v1` or swap in the sk-mem-xxx system key, so
   * memory L1/L2/L3 quietly hit the raw upstream (or 401'd on proxy
   * fallback routes). We now ALSO override whenever the user explicitly
   * asked for `provider=proxy`, regardless of host — that's the whole
   * point of that config value.
   *
   * `useStandaloneRunner=true` is a precondition (else the host runner
   * IS the runner, and there's nothing to override) and cfg.llm must
   * actually be enabled (otherwise `resolveRuntimeLlm` has nothing to
   * work with).
   */
  private shouldOverrideRunnerFactory(useStandaloneRunner: boolean): boolean {
    if (!useStandaloneRunner || !this.cfg.llm.enabled) return false;
    if (this.hostAdapter.hostType === "openclaw") return true;
    return this.cfg.llm.provider === "proxy";
  }

  private wirePipelineRunners(): void {
    if (!this.scheduler) return;

    // Determine whether to use standalone LLM runner for extraction.
    // Priority: cfg.llm.enabled (explicit override) > hostType detection.
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";

    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    // When standalone runner is active, create LLM runners from the factory.
    // Override the host-provided factory whenever `cfg.llm` is enabled and
    // either (a) we're in OpenClaw in-process mode, or (b) the user set
    // `provider=proxy` (which requires resolver-rewritten baseUrl + sk-mem
    // apiKey and MUST NOT go through the raw host runner). See
    // `shouldOverrideRunnerFactory` for the full rationale.
    //
    // Note: in service mode this factory is a fallback — every request
    // routes through `runL{1,2,3}WithStore` below, which reconstructs its
    // own factory with the per-request instanceId. `wirePipelineRunners`
    // runs at construction time (instanceId may still be `__unset__`), so
    // if resolver would throw we swallow it and keep the host runner as
    // fallback — the per-call site will succeed once instanceId is set.
    let runnerFactory = this.runnerFactory;
    if (this.shouldOverrideRunnerFactory(useStandaloneRunner)) {
      try {
        const runtimeLlm = this.resolveRuntimeLlm();
        runnerFactory = new StandaloneLLMRunnerFactory({
          config: runtimeLlm,
          logger: this.logger,
        });
        this.logger.debug?.(
          `${TAG} Using standalone LLM override: provider=${this.cfg.llm.provider ?? "openai"}, ` +
          `model=${runtimeLlm.model}, baseUrl=${runtimeLlm.baseUrl}`,
        );
      } catch (err) {
        // Most common at construction time: instanceId is still `__unset__`
        // (service mode) and provider=proxy resolver refuses to build a URL.
        // Not fatal — per-call sites (runL1WithStore etc.) will rebuild the
        // factory with the real instanceId when the request lands.
        this.logger.debug?.(
          `${TAG} wirePipelineRunners: standalone LLM override deferred: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Wrapped with the MetricTrackingRunnerFactory decorator (non-intrusive credit reporting)
    // When Kafka is not configured, metricProducer.send() is a no-op, zero overhead
    const trackingFactory = new MetricTrackingRunnerFactory(runnerFactory, () => this.instanceId);

    const l1LlmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: false })
      : undefined;
    const l2l3LlmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: true })
      : undefined;

    // L1 runner
    this.scheduler.setL1Runner(createL1Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
      getInstanceId: () => this.instanceId,
      llmRunner: l1LlmRunner,
      storage: this.storage,
    }));

    // Persister
    this.scheduler.setPersister(createPersister(this.dataDir, this.logger, this.storage));

    // L2 runner
    this.scheduler.setL2Runner(async (sessionKey: string, cursor?: string) => {
      const l2Runner = createL2Runner({
        pluginDataDir: this.dataDir,
        cfg: this.cfg,
        openclawConfig,
        vectorStore: this.vectorStore,
        logger: this.logger,
        instanceId: this.instanceId,
        llmRunner: l2l3LlmRunner,
        storage: this.storage,
      });
      return l2Runner(sessionKey, cursor);
    });

    // L3 runner
    this.scheduler.setL3Runner(async () => {
      const l3Runner = createL3Runner({
        pluginDataDir: this.dataDir,
        cfg: this.cfg,
        openclawConfig,
        vectorStore: this.vectorStore,
        logger: this.logger,
        instanceId: this.instanceId,
        llmRunner: l2l3LlmRunner,
        storage: this.storage,
      });
      await l3Runner();
    });

    this.logger.debug?.(`${TAG} Pipeline runners wired`);
  }

  // ============================
  // Skill module wiring (M0–M9)
  // ============================

  /**
   * Construct SkillCore + (optionally) SkillExtractor + TeamSkillService.
   *
   * Idempotent + lazy: callable multiple times. On each call we re-check the
   * three preconditions (cfg.skill.enabled, vectorStore ready, storage set);
   * once they all hold we construct exactly once and stash the result. After
   * that, subsequent calls are a fast no-op.
   *
   * The gateway calls this AFTER `setStorage()` because StorageAdapter is
   * injected post-`initialize()` in the HTTP path (server.ts wiring). The
   * OpenClaw in-process path also reaches this via the storeReady chain.
   *
   * Failure is non-fatal: a warn line + degraded state (no skill features,
   * /v3/skill/* returns 404). The host process never crashes here.
   */
  async ensureSkillModuleWired(): Promise<void> {
    if (this.skillCore) return; // already wired — fast path
    if (!this.cfg.skill?.enabled) return;

    // B1 fix: concurrent-callers coalesce onto the same in-flight promise so
    // SkillCore + extract worker are constructed AT MOST ONCE. Without this,
    // the storeReady.then chain in initialize() and setStorage()'s re-trigger
    // both race past the sync `if (this.skillCore) return` guard above and
    // each end up constructing a full SkillCore.
    if (this.skillWiringPromise) return this.skillWiringPromise;
    this.skillWiringPromise = this.doWireSkillModule().finally(() => {
      // Release the guard on failure so a later setStorage() + explicit
      // ensureSkillModuleWired can retry; on success the fast path
      // (`if (this.skillCore) return`) short-circuits anyway.
      if (!this.skillCore) {
        this.skillWiringPromise = undefined;
      }
    });
    return this.skillWiringPromise;
  }

  private async doWireSkillModule(): Promise<void> {
    // Wait for storeReady (no-op if already resolved)
    if (this.storeReady) {
      try { await this.storeReady; } catch { /* fall through to gate check */ }
    }

    if (!this.vectorStore) {
      this.logger.debug?.(`${TAG} Skill wiring deferred: vectorStore not ready`);
      return;
    }
    if (!this.storage) {
      this.logger.debug?.(`${TAG} Skill wiring deferred: storage not set`);
      return;
    }

    try {
      // Build the env probe — describes ambient capabilities to the resolver
      // so it can downgrade with proper warn lines (M0 §0.3).
      const tcvdbHasCreds = !!(
        this.cfg.tcvdb?.url && this.cfg.tcvdb?.apiKey && this.cfg.tcvdb?.database
      );
      const cosHasCreds = !!(
        this.cfg.cos?.secretId &&
        this.cfg.cos?.secretKey &&
        this.cfg.cos?.bucket
      );
      const probe: SkillEnvProbe = {
        outerStoreBackend: this.cfg.storeBackend,
        hasTcvdbCredentials: tcvdbHasCreds,
        hasCosCredentials: cosHasCreds,
        embeddingAvailable:
          this.cfg.embedding.enabled && (this.cfg.embedding.dimensions ?? 0) > 0,
        llmRunnerAvailable:
          (this.cfg.llm?.enabled ?? false) &&
          !!this.cfg.llm?.baseUrl &&
          !!this.cfg.llm?.apiKey,
      };
      const resolverLogger = {
        info: (m: string) => this.logger.info(m),
        warn: (m: string) => this.logger.warn(m),
      };
      const resolved = resolveSkillConfig(this.cfg.skill, probe, resolverLogger);
      this.resolvedSkillConfig = resolved;

      // Open the underlying DatabaseSync (raw handle escape hatch — see
      // VectorStore.getRawDb() docstring). Skill tables (skill_meta /
      // skill_fts / skill_vec / task_*) live in the SAME connection.
      const rawDbCarrier = this.vectorStore as unknown as {
        getRawDb?: () => unknown;
        getEmbeddingDimensions?: () => number;
      };
      if (typeof rawDbCarrier.getRawDb !== "function") {
        this.logger.warn(
          `${TAG} Skill wiring skipped: vectorStore does not expose getRawDb() (only SQLite-backed VectorStore is supported in MVP)`,
        );
        return;
      }
      const db = rawDbCarrier.getRawDb() as import("node:sqlite").DatabaseSync;
      const dimensions =
        typeof rawDbCarrier.getEmbeddingDimensions === "function"
          ? rawDbCarrier.getEmbeddingDimensions()
          : (this.cfg.embedding.dimensions ?? 0);

      const skillStore = new SqliteSkillStore({
        db,
        dimensions,
        logger: this.logger,
      });
      skillStore.init();

      const skillResources = new SkillResourceStore({
        storage: this.storage,
        maxResourceSizeBytes: resolved.resources.maxResourceSizeBytes,
      });

      // Asset linkage hooks (optionally injected) — fully aligned with the three hooks that service-mode gateway/server.ts:resolveSkillCore
      // attaches. When not injected, the zero-coupling legacy behavior is kept.
      const assetHooks = this.skillAssetHooks;

      const skillVersioning = new SkillVersioning({
        store: skillStore,
        resources: skillResources,
        storage: this.storage,
        onSkillCreated: assetHooks?.onSkillCreated,
      });

      this.skillCore = new SkillCore({
        store: skillStore,
        resources: skillResources,
        versioning: skillVersioning,
        // Legacy-version cleanup along two dimensions: time (versionTtlSeconds) + count (maxNonHeadVersions).
        // If neither is configured they are 0 (disabled), behavior is exactly the same as before they were added, backward compatible.
        versionTtlSeconds: resolved.versionTtlSeconds,
        maxNonHeadVersions: resolved.maxNonHeadVersions,
        onSkillAccessed: assetHooks?.onSkillAccessed,
        onSkillArchived: assetHooks?.onSkillArchived,
      });

      // ── Extraction wiring (queue + worker + optional single-tenant extractor) ──
      //
      // Queue construction is **decoupled** from the LLM runner: the queue is just a Redis / local data structure,
      // unrelated to whether the llm can be constructed. Previously it was placed inside `if (llmRunner)`, so that in
      // service mode, when the llm runner threw because of `provider=proxy + instanceId=__unset__`,
      // the whole skill wiring (including the queue) was swallowed by the catch, and the handler side, unable to get the
      // queue, would always return QUEUE_UNAVAILABLE.
      //
      // New order:
      //   1. Construct the queue first (precondition: extraction.enabled && queue.enabled)
      //   2. Then try to construct the singleton llm runner + extractor (required in standalone mode;
      //      failure is fine in service mode — the worker constructs it on the spot via extractorFactory)
      //   3. Start the worker: start it if constructSkillWorker=true and there is a queue
      //      - With a singleton extractor → use the singleton (standalone)
      //      - Without a singleton extractor → let the host wiring (server.ts) start a worker with a factory,
      //        and tdai-core skips it here
      if (resolved.extraction.enabled) {
        // Only construct the SkillExtractor singleton — the worker + queue are now started by the gateway/openclaw
        // side's wireConversationAdd (SkillConversationExtractWorker + agent queue),
        // see the 2026-07-17 skill_extract consolidation plan. In standalone mode the wire layer
        // obtains this singleton via core.getSkillExtractor(); service mode ignores it and goes through
        // per-instance factory (buildSkillExtractorForInstance).
        let llmRunner: ExtractorLLMRunner | undefined;
        try {
          llmRunner = this.buildSkillLlmRunner();
        } catch (err) {
          this.logger.warn(
            `${TAG} Skill singleton llm runner build failed (non-fatal in service mode): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          llmRunner = undefined;
        }
        if (llmRunner) {
          this.skillExtractor = new SkillExtractor({
            core: this.skillCore,
            runner: llmRunner,
            systemPrompt: SKILL_REVIEW_PROMPT,
            // Cold start / bulk import (asset-import) passes strict_mode:true in the request body,
            // which is carried through SkillTaskEntry.mode all the way to extract({mode:'strict'}) here.
            // By default (mode not passed) it always goes through SKILL_REVIEW_PROMPT above, zero impact on legacy traffic.
            strictSystemPrompt: SKILL_REVIEW_PROMPT_STRICT,
            maxIterations: resolved.extraction.maxIterations,
            headChars: resolved.extraction.headChars,
            tailChars: resolved.extraction.tailChars,
            maxTokens: resolved.extraction.maxTokens,
            prefixSkillsLimit: resolved.extraction.prefixSkillsLimit,
            logger: this.logger,
          });
        } else {
          this.logger.warn(
            `${TAG} Skill singleton extractor not constructed — service mode goes through the per-instance factory; ` +
              `in standalone/openclaw mode /skill/extract cannot extract without an extractor, please check cfg.llm.`,
          );
        }
      }

      this.logger.info(
        `${TAG} Skill module wired (v2): store=${resolved.storeBackend}, content=${resolved.contentBackend}, ` +
          `extraction=${resolved.extraction.enabled ? (this.skillExtractor ? "on" : "noop") : "off"}, ` +
          `degradations=${resolved.degradations.length}`,
      );
    } catch (err) {
      this.logger.warn(
        `${TAG} Skill module wiring failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      this.skillCore = undefined;
      this.skillExtractor = undefined;
    }
  }

  /**
   * Build an `ExtractorLLMRunner` for the Skill Review Agent.
   *
   * Uses `StandaloneLLMRunner` so the skill module gets the full AI SDK
   * tool-calling loop for free — when SkillExtractor passes
   * `tools: skill_list/skill_view/skill_manage` and `enableTools: true`,
   * the AI SDK drives the multi-turn tool loop and we get back the
   * final text. This is what the M-tool rewrite of SkillExtractor needs;
   * the previous fetch-only impl could not drive tool calls.
   *
   * Returns undefined when LLM credentials are missing — the caller
   * skips constructing SkillExtractor in that case (M0 records the
   * 'extraction.runtime: enabled→noop' degradation).
   */
  private buildSkillLlmRunner(): ExtractorLLMRunner | undefined {
    const cfg = this.cfg.llm;
    if (!cfg?.enabled) return undefined;
    // When provider=proxy, cfg.apiKey may be empty (the real apiKey is injected from env by the resolver),
    // so construction is allowed whenever provider=proxy; when provider=openai the original baseUrl+apiKey check is kept.
    if (!cfg.baseUrl) return undefined;
    if ((cfg.provider ?? "openai") === "openai" && !cfg.apiKey) return undefined;
    const logger = this.logger;
    // Construct the StandaloneLLMRunner with tools eligible by default.
    // Per-call SkillExtractor passes its own `tools` dict + enableTools=true,
    // which the runner honors over its own setting (see standalone/llm-runner.ts).
    const runtimeLlm = this.resolveRuntimeLlm();
    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: runtimeLlm.baseUrl,
        apiKey: runtimeLlm.apiKey,
        model: runtimeLlm.model,
        maxTokens: runtimeLlm.maxTokens,
        timeoutMs: runtimeLlm.timeoutMs,
        stream: runtimeLlm.stream,
      },
      // Default to enabled so the runner doesn't strip caller-provided tools.
      enableTools: true,
      logger,
    });
    return {
      async run(params) {
        // Pass through everything: prompt, systemPrompt, tools, enableTools,
        // maxIterations, taskId, timeoutMs. StandaloneLLMRunner.run() now
        // honors all of these (see types.ts / standalone/llm-runner.ts).
        return runner.run(params);
      },
    };
  }

  // ============================
  // Per-instance Store runners (multi-tenant)
  // ============================

  /**
   * Run L1 extraction using an externally provided Store (for multi-instance VDB).
   * Called by PipelineWorker when task.data.instanceId is present.
   *
   * Returns backlog flags (`hasMore`, `hasFullBacklog`) so the caller (the
   * service-mode worker executor) can mirror standalone-mode pipeline-manager
   * behavior: full backlog → enqueue next L1 immediately; small tail → defer
   * via L1_idle timer. See pipeline-factory.ts createL1Runner for semantics.
   */
  async runL1WithStore(
    sessionKey: string,
    store: IMemoryStore,
    embedding: EmbeddingService,
    storage?: StorageAdapter,
    /**
     * Required in service mode: a distributed lock that protects checkpoint read-modify-write across nodes.
     *
     * The checkpoint of the same instance is the **same** COS object, while the L1 task lock is
     * session-level — different sessions / different agents may legitimately run concurrently on multiple nodes,
     * and without extra mutual exclusion, a later writer would overwrite an earlier writer's runner_states with a stale snapshot (L1 cursor lost).
     * Standalone single-process does not need to pass it (the in-process withFileLock is sufficient).
     */
    checkpointLock?: import("../utils/checkpoint.js").CheckpointLockOptions,
  ): Promise<{ storedCount: number; creditUsed: number; hasMore: boolean; hasFullBacklog: boolean; profileScopes: string[] }> {
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";
    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    let runnerFactory = this.runnerFactory;
    if (this.shouldOverrideRunnerFactory(useStandaloneRunner)) {
      const runtimeLlm = this.resolveRuntimeLlm();
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: runtimeLlm,
        logger: this.logger,
      });
      this.logger.debug?.(
        `${TAG} [L1] Using standalone LLM override: provider=${this.cfg.llm.provider ?? "openai"}, ` +
        `model=${runtimeLlm.model}, baseUrl=${runtimeLlm.baseUrl}`,
      );
    }
    // Wrapped with the MetricTrackingRunnerFactory decorator (non-intrusive credit reporting)
    const trackingFactory = new MetricTrackingRunnerFactory(runnerFactory, () => this.instanceId);
    const llmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: false })
      : undefined;

    const runner = createL1Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: store,
      embeddingService: embedding,
      logger: this.logger,
      getInstanceId: () => this.instanceId,
      llmRunner,
      storage: storage ?? this.getStorage(),
      checkpointLock,
    });
    const result = await runner({ sessionKey, msg: [], bg_msg: [] });

    // Read accumulated credit from the tracking runner (raw float, strictly consistent with the monitoring side)
    const creditUsed: number = (llmRunner as any)?.accumulatedCredit ?? 0;
    const storedCount = result?.storedCount ?? 0;
    const hasMore = result?.hasMore ?? false;
    const hasFullBacklog = result?.hasFullBacklog ?? false;
    const profileScopes = result?.profileScopes ?? [];
    return { storedCount, creditUsed, hasMore, hasFullBacklog, profileScopes };
  }

  /**
   * Run L2 scene extraction using an externally provided Store.
   */
  async runL2WithStore(sessionKey: string, store: IMemoryStore, storage?: StorageAdapter, cursor?: string): Promise<{ creditUsed: number; skipped: boolean }> {
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";
    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    let runnerFactory = this.runnerFactory;
    if (this.shouldOverrideRunnerFactory(useStandaloneRunner)) {
      const runtimeLlm = this.resolveRuntimeLlm();
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: runtimeLlm,
        logger: this.logger,
      });
      this.logger.debug?.(
        `${TAG} [L2] Using standalone LLM override: provider=${this.cfg.llm.provider ?? "openai"}, ` +
        `model=${runtimeLlm.model}, baseUrl=${runtimeLlm.baseUrl}`,
      );
    }
    // Wrapped with the MetricTrackingRunnerFactory decorator (non-intrusive credit reporting)
    const trackingFactory = new MetricTrackingRunnerFactory(runnerFactory, () => this.instanceId);
    const llmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: true })
      : undefined;

    const runner = createL2Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: store,
      logger: this.logger,
      instanceId: this.instanceId,
      llmRunner,
      storage: storage ?? this.getStorage(),
    });
    const runnerResult = await runner(sessionKey, cursor);
    const creditUsed: number = (llmRunner as any)?.accumulatedCredit ?? 0;
    // L2 runner returns undefined when no new L1 records, or { skipped: true } on empty extraction
    const skipped = (runnerResult === undefined && creditUsed === 0) || (runnerResult?.skipped === true);
    return { creditUsed, skipped };
  }

  /**
   * Run L3 persona generation using an externally provided Store.
   */
  async runL3WithStore(store: IMemoryStore, storage?: StorageAdapter): Promise<{ creditUsed: number }> {
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";
    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    let runnerFactory = this.runnerFactory;
    if (this.shouldOverrideRunnerFactory(useStandaloneRunner)) {
      const runtimeLlm = this.resolveRuntimeLlm();
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: runtimeLlm,
        logger: this.logger,
      });
      this.logger.debug?.(
        `${TAG} [L3] Using standalone LLM override: provider=${this.cfg.llm.provider ?? "openai"}, ` +
        `model=${runtimeLlm.model}, baseUrl=${runtimeLlm.baseUrl}`,
      );
    }
    // Wrapped with the MetricTrackingRunnerFactory decorator (non-intrusive credit reporting)
    const trackingFactory = new MetricTrackingRunnerFactory(runnerFactory, () => this.instanceId);
    const llmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: true })
      : undefined;

    const runner = createL3Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: store,
      logger: this.logger,
      instanceId: this.instanceId,
      llmRunner,
      storage: storage ?? this.getStorage(),
    });
    await runner();
    const creditUsed: number = (llmRunner as any)?.accumulatedCredit ?? 0;
    return { creditUsed };
  }

  private ensureSchedulerStarted(): Promise<void> {
    // Fast path: already started (or starting) — every concurrent caller
    // awaits the same in-flight promise.  The promise is kept around as a
    // permanently-resolved sentinel after success so subsequent calls
    // collapse into a cheap already-resolved await.
    if (this.schedulerStartPromise) return this.schedulerStartPromise;
    if (!this.scheduler) return Promise.resolve();

    // Capture scheduler locally so TypeScript narrows inside the closure
    // even after ``this.scheduler`` is re-assigned by handleSessionEnd.
    const scheduler = this.scheduler;
    this.schedulerStartPromise = (async () => {
      try {
        const checkpoint = new CheckpointManager(this.dataDir, this.logger, this.storage);
        const cp = await checkpoint.read();
        scheduler.start(checkpoint.getAllPipelineStates(cp));
        this.logger.debug?.(`${TAG} Scheduler started`);
      } catch (err) {
        this.logger.error(`${TAG} Failed to restore checkpoint: ${err instanceof Error ? err.message : String(err)}`);
        scheduler.start({});
      }
    })();

    // If the start sequence itself rejects we clear the gate so the next
    // caller can retry; on success we keep the resolved promise so it
    // short-circuits permanently.
    this.schedulerStartPromise.catch(() => {
      this.schedulerStartPromise = undefined;
    });

    return this.schedulerStartPromise;
  }
}
