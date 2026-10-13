/**
 * Knowledge Module Factory — assembles store / services / engines / workers / restart recovery.
 *
 * Outputs `KnowledgeModule` with all dependencies wired up for the Hono server.
 * Real code-graph worker: git clone/fetch + codegraph indexing.
 * Real wiki worker: LLM ingest via wiki engine.
 */

import { join } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import pLimit from "p-limit";
import simpleGit from "simple-git";

import type { Db } from "./db/client.js";
import { SqliteKnowledgeStore, type IKnowledgeStore } from "./store/index.js";
import { WikiService, type WikiWorker } from "./store/index.js";
import { CodeGraphService, type CodeGraphWorker } from "./store/index.js";
import { BuildQueue } from "./store/index.js";
import {
  createLlmBindingStore,
  resolveLlmConfig,
  type ILlmBindingStore,
} from "./store/llm-binding-store.js";
import { createWikiSourceManager, type WikiSourceManager } from "./engines/wiki/index.js";
import { indexProject, openIndex, syncIndex, getStats, closeIndex, type CodeGraphInstance } from "./engines/code/index.js";
import { SourceFetcherRegistry } from "./source-fetcher/index.js";
import { createLogger } from "./logger.js";
import type { LlmConfig } from "./config.js";
import { getGlobalLlmConcurrency } from "./config.js";
import { buildProgressFn } from "./callback.js";
import {
  AutoSyncScheduler,
  resolveAutoSyncConfig,
  type AutoSyncConfig,
  type WikiImporter,
} from "./store/auto-sync-scheduler.js";
import { createCredentialStore } from "./source-auth/credential-store.js";
import type { ICredentialStore } from "./source-auth/types.js";
import { buildCloneUrl, stripCredentials } from "./code-source/clone-url.js";
import { CodeSourceRegistry } from "./code-source/registry.js";
import { WikiSourceRegistry } from "./wiki-source/registry.js";
import { createWikiImporter } from "./wiki-source/wiki-importer.js";
import { isGitAuthError, explainGitAuthError } from "./source-fetcher/git-fetcher.js";

const log = createLogger("knowledge-module");

/** Process-wide global LLM concurrency semaphore (across extract + merge for all wikis). */
export const globalLlmLimit = pLimit(getGlobalLlmConcurrency());

// ───────────────────────── Module Config ─────────────────────────

export interface KnowledgeModuleConfig {
  dataDir: string;
  db: Db;
  /** LLM configuration for wiki ingest. */
  llmConfig: LlmConfig;
  /** TMC callback URL for status notifications (empty = no callback). */
  tmcCallbackUrl?: string;
  /** Optional: externally injected wiki worker (for testing). */
  wikiWorker?: WikiWorker;
  /** Optional: externally injected code worker (for testing). */
  codeWorker?: CodeGraphWorker;
  /** Optional: externally injected credential store (for testing). */
  credentialStore?: ICredentialStore;
  /** Optional: wiki fetch service (used for scheduled sync of external wikis); not injected → wiki sync targets are skipped. */
  wikiImporter?: WikiImporter;
}

export interface CodeGraphInstancePool {
  get(codeGraphId: string): CodeGraphInstance | undefined;
  set(codeGraphId: string, instance: CodeGraphInstance): void;
  delete(codeGraphId: string): void;
  loadIfMissing?(codeGraphId: string, dir: string): Promise<CodeGraphInstance | undefined>;
}

export interface KnowledgeModule {
  wikiService: WikiService;
  cgService: CodeGraphService;
  wikiMgr: WikiSourceManager;
  /** Registry of wiki external sources (iWiki, etc.). */
  wikiSourceRegistry: WikiSourceRegistry;
  store: IKnowledgeStore;
  instancePool: CodeGraphInstancePool;
  /** Per-instance LLM routing binding (proxy/byo), keyed by service_id. */
  llmBindingStore: ILlmBindingStore;
  /** Scheduled auto-sync scheduler (requires explicit start/stop). */
  autoSyncScheduler: AutoSyncScheduler;
  /** Resolved config for scheduled auto-sync (exposed when mounting admin routes). */
  autoSyncConfig: AutoSyncConfig;
  /** External knowledge source user tokens (encrypted storage; plaintext never leaves the process). */
  credentialStore: ICredentialStore;
  /** Code source provider registry (frontend dropdown + provider lookup). */
  codeSourceRegistry: CodeSourceRegistry;
}

/**
 * Create Knowledge Module (assembly entry point).
 * - Initialize Store / Service / engines
 * - Mark interrupted tasks as failed
 * - Async restore synced instances
 */
export function createKnowledgeModule(config: KnowledgeModuleConfig): KnowledgeModule {
  const { dataDir, db, llmConfig } = config;

  // Store
  const store = new SqliteKnowledgeStore(db);

  // Per-instance LLM routing binding + resolver (proxy/byo → effective LlmConfig).
  // No binding → global LLM_MODE decides: 'custom' uses global LLM_* direct,
  // 'proxy' (default) blanks creds so ingest fails loudly (no silent fallback).
  const llmBindingStore = createLlmBindingStore(db);
  const resolveLlm = (serviceId: string): LlmConfig =>
    resolveLlmConfig(serviceId, llmBindingStore.get(serviceId), llmConfig);

  // Instance pool (code-graph) — lazy loading
  const _poolMap = new Map<string, CodeGraphInstance>();
  const instancePool: CodeGraphInstancePool = {
    get(id: string) { return _poolMap.get(id); },
    set(id: string, inst: CodeGraphInstance) { _poolMap.set(id, inst); },
    delete(id: string) { _poolMap.delete(id); },
    async loadIfMissing(id: string, dir: string) {
      if (_poolMap.has(id)) return _poolMap.get(id);
      try {
        const instance = await openIndex(dir);
        _poolMap.set(id, instance);
        log.info(`[code-graph] lazy-loaded instance ${id}`);
        return instance;
      } catch (err) {
        log.warn(`[code-graph] lazy-load failed ${id}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
  };

  // Wiki engine manager
  const wikiMgr = createWikiSourceManager(join(dataDir, "_wiki_engines"));

  // Source fetcher registry (git/local/ftp routing + security validation)
  const fetcherRegistry = new SourceFetcherRegistry();

  // ── External source credential store (base64; no key; see §4.1.3) ──
  const credentialStore = config.credentialStore ?? createCredentialStore({ db });

  // ── Code source provider registry (built-in + deployment-enabled list) ──
  const codeSourceRegistry = new CodeSourceRegistry();

  // ── Wiki source provider registry (built-in + deployment-enabled list) ──
  const wikiSourceRegistry = new WikiSourceRegistry();

  /**
   * Repos that need credentials: temporarily inject the token into the URL before clone/sync.
   *
   * Whether a credential row exists **is** what decides whether the repo is an external source (§4.2):
   *   yes → go through provider.applyToCloneUrl or the default basic-auth injection
   *   no  → public repo, return a clean URL (behavior identical to before the change)
   *
   * What gets persisted is the clean URL; the credentialed URL assembled here only lives in this call stack
   * (not written to disk, not logged, not in response bodies).
   */
  const cloneUrlFor = (
    serviceId: string,
    codeGraphId: string,
    repoUrl: string,
  ): string => {
    const ref = { type: "code-graph" as const, serviceId, resourceId: codeGraphId };
    const cred = credentialStore.get(ref);
    if (!cred) return repoUrl; // no credential = public repo
    const status = credentialStore.status(ref);
    if (!status) throw new Error(`no credential row for code-graph ${codeGraphId}`);
    const provider = codeSourceRegistry.get(status.provider_id);
    if (!provider) {
      throw new Error(
        `code source provider '${status.provider_id}' is not registered (check CODE_SOURCE_ENABLED)`,
      );
    }
    return buildCloneUrl(provider, repoUrl, { secret: cred.secret, username: cred.username });
  };

  /**
   * Change the credentialed origin URL in .git/config after clone back to a clean URL.
   *
   * Failure does not block graph building, but should warn — leaving a plaintext token on disk is a security issue,
   * while the graph result itself is still valid.
   */
  const sanitizeCloneRemote = async (
    dir: string,
    cleanUrl: string,
    serviceId: string,
    codeGraphId: string,
  ): Promise<void> => {
    try {
      await simpleGit(dir).remote(["set-url", "origin", cleanUrl]);
      log.info("[code-graph] sanitized clone remote (credentials stripped)", { codeGraphId });
    } catch (err) {
      log.warn("[code-graph] failed to sanitize clone remote", {
        codeGraphId,
        serviceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ── Real code-graph worker: fetch/sync via SourceFetcher + index ──
  const realCodeWorker: CodeGraphWorker = async (ctx) => {
    const { dir, repoUrl, branch, codeGraphId, serviceId, setInternalStatus } = ctx;

    // External source (Gongfeng, etc.) → inject token; no credential row → public repo.
    const cleanUrl = stripCredentials(repoUrl);
    const effectiveUrl = cloneUrlFor(serviceId, codeGraphId, cleanUrl);
    // Decide "is it a private repo" by whether the URL was rewritten (equivalent to whether a credential row exists, with no extra DB query).
    const needsCredential = effectiveUrl !== cleanUrl;

    // Resolve protocol-specific fetcher (validates url: https-only + SSRF blocklist).
    const fetcher = fetcherRegistry.resolve(effectiveUrl);

    const isExistingRepo = existsSync(join(dir, ".git"));
    // ★ Private repos do no incremental sync: GitSourceFetcher.sync() internally runs `git fetch origin`,
    //   using the URL in .git/config — which has already been sanitized to a clean URL, so it would inevitably 401.
    //   Therefore external sources always do a full clone (with the token each time); the cost is slowness, but behavior is correct.
    const canIncremental = isExistingRepo && !needsCredential;
    let didIncrementalSync = false;
    let version: string | null = null;

    if (canIncremental) {
      try {
        setInternalStatus("fetching");
        const res = await fetcher.sync(effectiveUrl, branch, dir);
        version = res.version;

        setInternalStatus("indexing");
        let instance = instancePool.get(codeGraphId);
        if (!instance) {
          instance = await openIndex(dir);
        }
        await syncIndex(instance);
        instancePool.set(codeGraphId, instance);
        didIncrementalSync = true;
      } catch (err) {
        log.warn(
          `[code-graph] incremental sync failed for ${codeGraphId}, falling back to fresh clone: ${err instanceof Error ? err.message : String(err)}`,
        );
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    if (!didIncrementalSync) {
      // Private repo re-run: the old directory is still there (incremental skipped) → clear it first, otherwise cloning into a non-empty directory fails.
      if (isExistingRepo) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      mkdirSync(dir, { recursive: true });
      setInternalStatus("cloning");
      let res;
      try {
        res = await fetcher.fetch(effectiveUrl, branch, dir);
      } catch (err) {
        // git auth/permission error wording is misleading (`could not read Username` = the repo requires auth),
        // convert it into a user-facing hint before rethrowing, written to sync_error for the frontend to display.
        const raw = err instanceof Error ? err.message : String(err);
        if (isGitAuthError(raw)) {
          throw new Error(explainGitAuthError(raw, needsCredential));
        }
        throw err;
      }
      version = res.version;
      // ★ Credential cleanup: clone writes the tokenized URL into the origin in .git/config.
      //   Not cleaning it up means leaving the user's PAT in plaintext on disk (later git fetch also keeps using it).
      await sanitizeCloneRemote(dir, stripCredentials(repoUrl), serviceId, codeGraphId);

      setInternalStatus("indexing");
      const instance = await indexProject(dir);
      instancePool.set(codeGraphId, instance);
    }

    // commit hash comes from the fetcher's FetchResult (unified after clone / sync)
    const commitHash = version ?? undefined;

    const instance = instancePool.get(codeGraphId);
    const rawStats = instance ? getStats(instance) : undefined;
    const stats = rawStats
      ? { files: rawStats.fileCount ?? rawStats.files ?? 0, nodes: rawStats.nodeCount ?? rawStats.nodes ?? 0, edges: rawStats.edgeCount ?? rawStats.edges ?? 0 }
      : undefined;
    return { commitHash, stats };
  };

  // ── Real wiki worker: ingest via wiki engine ──
  const realWikiWorker: WikiWorker = async (ctx) => {
    const { wikiId, serviceId, teamId, dir, setInternalStatus, ingestRunId } = ctx;
    setInternalStatus("ingesting");

    // Per-instance LLM routing (proxy/byo/global fallback), keyed by service_id.
    const effectiveLlm = resolveLlm(serviceId);
    // Progress is pushed only to Panel (Panel in-memory store + wiki/get aggregation); KS does not persist progress state
    const onProgress = config.tmcCallbackUrl
      ? buildProgressFn(config.tmcCallbackUrl, wikiId, serviceId, teamId, ingestRunId)
      : undefined;
    wikiMgr.init({ name: wikiId, path: dir });
    await wikiMgr.ingest(
      wikiId,
      {
        protocol: effectiveLlm.protocol,
        provider: effectiveLlm.provider,
        apiKey: effectiveLlm.apiKey,
        model: effectiveLlm.model,
        customEndpoint: effectiveLlm.baseUrl,
        maxContextSize: effectiveLlm.maxTokens,
        timeoutMs: effectiveLlm.timeoutMs,
        stream: effectiveLlm.stream ?? false,
      },
      { onProgress, globalLlmLimit },
    );
    setInternalStatus("rebuilding-index");

    const pages = wikiMgr.getPages(wikiId);
    return { pageCount: pages.length };
  };

  // Services (shared BuildQueue for serial wiki + code tasks)
  const callbackConfig = config.tmcCallbackUrl
    ? { tmcCallbackUrl: config.tmcCallbackUrl, resolveLlm }
    : undefined;

  const sharedQueue = new BuildQueue();
  const wikiService = new WikiService({
    store,
    dataRoot: dataDir,
    worker: config.wikiWorker ?? realWikiWorker,
    queue: sharedQueue,
    logger: { info: log.info.bind(log), warn: log.warn.bind(log), error: log.error.bind(log) },
    callbackConfig,
  });
  const cgService = new CodeGraphService({
    store,
    dataRoot: dataDir,
    worker: config.codeWorker ?? realCodeWorker,
    queue: sharedQueue,
    logger: { info: log.info.bind(log), warn: log.warn.bind(log), error: log.error.bind(log) },
    callbackConfig,
    // Release code-graph in-memory resources (008 delete cleanup): remove from the pool and close the index handle. Idempotent.
    releaseInstance: (codeGraphId: string) => {
      const inst = instancePool.get(codeGraphId);
      if (inst) closeIndex(inst);
      instancePool.delete(codeGraphId);
    },
    credentialStore,
    codeSourceRegistry,
  });

  // Restart recovery: mark interrupted tasks as failed
  const interrupted = store.markInterruptedAsFailed();
  if (interrupted > 0) {
    log.info(`marked ${interrupted} interrupted tasks as failed`);
  }

  // Background restore of synced instances (non-blocking)
  void (async () => {
    // Code-graph: lazy loading, just fix stats on startup
    try {
      const allSynced = store.listSyncedCodeGraphs();
      for (const row of allSynced) {
        const dir = join(dataDir, row.service_id, row.team_id, row.code_graph_id);
        try {
          const instance = await openIndex(dir);
          instancePool.set(row.code_graph_id, instance);
          const rawStats = getStats(instance);
          if (rawStats) {
            const statsJson = JSON.stringify({
              files: rawStats.fileCount ?? rawStats.files ?? 0,
              nodes: rawStats.nodeCount ?? rawStats.nodes ?? 0,
              edges: rawStats.edgeCount ?? rawStats.edges ?? 0,
            });
            store.updateCodeGraphStatus(row.service_id, row.code_graph_id, { stats_json: statsJson });
          }
          log.info(`[code-graph] restored ${row.code_graph_id}`);
        } catch (err) {
          log.warn(`[code-graph] failed to restore ${row.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      log.info(`[code-graph] ${allSynced.length} synced instances restored`);
    } catch (err) {
      log.warn(`[code-graph] restore scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Wiki: register to engine manager
    try {
      const allSyncedWikis = store.listSyncedWikis();
      for (const row of allSyncedWikis) {
        const dir = join(dataDir, row.service_id, row.team_id, row.wiki_id);
        try {
          wikiMgr.init({ name: row.wiki_id, path: dir });
          const pages = wikiMgr.getPages(row.wiki_id);
          if (pages.length > 0) {
            store.updateWikiStatus(row.service_id, row.wiki_id, { page_count: pages.length });
          }
          log.info(`[wiki] restored index ${row.wiki_id} (${pages.length} pages)`);
        } catch (err) {
          log.warn(`[wiki] failed to restore ${row.wiki_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log.warn(`[wiki] restore scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  // ── AutoSync Scheduler: periodically pull git repos and update codegraph / external wikis ──
  const autoSyncConfig = resolveAutoSyncConfig();
  const autoSyncScheduler = new AutoSyncScheduler({
    store,
    cgService,
    config: autoSyncConfig,
    // wiki sync **follows the global switch**, with no per-wiki switch:
    // as long as KNOWLEDGE_AUTO_SYNC_ENABLED is on, all "wikis that have stored credentials"
    // (= external sources, §4.2 decided by credential row existence) participate in scheduled sync.
    // When not injected (e.g. tests), wiki targets are skipped; code-graph behavior is unchanged.
    wikiImporter:
      config.wikiImporter ??
      createWikiImporter({
        registry: wikiSourceRegistry,
        wikiService,
        store,
      }),
    credentialStore,
  });
  autoSyncScheduler.start();

  return {
    wikiService, cgService, wikiMgr, store, instancePool,
    llmBindingStore, autoSyncScheduler, autoSyncConfig, credentialStore,
    codeSourceRegistry, wikiSourceRegistry,
  };
}
