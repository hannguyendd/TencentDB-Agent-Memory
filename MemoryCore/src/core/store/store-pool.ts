/**
 * StorePool — per-instanceId Store instance pool
 *
 * Dual-mode support:
 *   - standalone: uses SQLite local storage (one SQLite file per instanceId)
 *   - service: uses the TCVDB vector database (one remote VDB connection per instanceId)
 *
 * Works together with InstanceConfigProvider:
 *   1. when a request arrives, obtain that instanceId's VDB config from InstanceConfigProvider
 *   2. create/reuse a Store instance with the VDB config
 *   3. pooled management, avoiding repeated connection creation
 *
 * In standalone mode:
 *   - VdbConfig empty or from environment variables → create a SQLite Store
 *   - a fixed "default" instanceId, behaving the same as the original createStoreBundle
 */

import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, StoreLogger } from "./types.js";
import type { EmbeddingService } from "./embedding.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import { VectorStore } from "./sqlite/memory-store.js";
import { TcvdbMemoryStore } from "./tcvdb/memory-store.js";
import { TcvdbSkillStore } from "./tcvdb/skill-store.js";
import { MongoMemoryStore } from "./mongodb/memory-store.js";
import { MongoSkillStore } from "./mongodb/skill-store.js";
import { getSharedMongoClientPool } from "./mongodb/client-pool.js";
import type { MongoClientPool } from "./mongodb/client-pool.js";
import { createBM25Encoder } from "./bm25-local.js";
import type { BM25LocalEncoder } from "./bm25-local.js";
import type { VdbConfig, MongoConfig } from "../instance-config-provider.js";
import type { ISkillStore } from "../skill/skill-store.interface.js";
import { metricProducer } from "../report/kafka-metric-producer.js";

const TAG = "[store-pool]";

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

export interface PooledStore {
  store: IMemoryStore;
  embedding: EmbeddingService;
  bm25Encoder?: BM25LocalEncoder;
}

interface PoolEntry {
  pooledStore: PooledStore;
  /** VDB config fingerprint, used to detect config changes */
  configFingerprint: string;
  lastAccessedAt: number;
}

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type StoreMode = "sqlite" | "tcvdb" | "mongodb";

export interface KafkaMetricOptions {
  /** Kafka Broker list (comma-separated or array) */
  brokers?: string[] | string;
  /** Topic name (default: "memory_monitor") */
  topic?: string;
  /** Whether enabled (default: determined automatically by whether brokers is non-empty) */
  enabled?: boolean;
}

export interface StorePoolOptions {
  /** Storage mode: "sqlite" (standalone local) or "tcvdb" (service remote) */
  mode: StoreMode;
  /** Memory plugin config (used for BM25/embedding settings) */
  memoryCfg: MemoryTdaiConfig;
  /** Data directory (used in SQLite mode) */
  dataDir?: string;
  /** Max pooled instances (Memory store), default 100 */
  maxStores?: number;
  /** Max Skill store cache entries, default 100 */
  maxSkillStores?: number;
  /** Kafka metric reporting config (optional; not reported if not configured) */
  kafka?: KafkaMetricOptions;
  logger: Logger;
}

// ════════════════════════════════════════════════════════
// StorePool
// ════════════════════════════════════════════════════════

export class StorePool {
  private pool = new Map<string, PoolEntry>();
  private maxStores: number;
  readonly mode: StoreMode;
  private memoryCfg: MemoryTdaiConfig;
  private dataDir: string;
  private logger: Logger;
  /** Globally shared BM25 encoder (avoids repeatedly loading the jieba dictionary and causing OOM) */
  private sharedBm25Encoder: BM25LocalEncoder | undefined;
  /** Shared MongoClient connection pool (mongodb backend; one client reused per endpoint). */
  private mongoPool: MongoClientPool | undefined;

  /** Skill store cache cap */
  private maxSkillStores: number;
  /** Skill store last access time (for LRU eviction) */
  private skillStoreAccessTimes = new Map<string, number>();



  /**
   * Grace-close tracking: entries removed from the pool whose underlying close is deferred.
   * CR-5 mitigation (2026-05-19): evict / config-change does not close the underlying store immediately,
   * but delays graceCloseDelayMs before closing, giving in-flight requests (sync-path recall/capture
   * <100ms; async worker-path L1/L2/L3 backstopped by maxRetries=3 + exponential backoff) time to complete.
   */
  private pendingCloses = new Set<Promise<void>>();
  /** Default grace period 30s, far larger than the sync-path wall clock (recall ~49ms / capture ~54ms),
   *  and even if the worker path runs into it there is a reEnqueue retry mechanism (5s/15s/45s). */
  private graceCloseDelayMs = 30_000;

  constructor(opts: StorePoolOptions) {
    this.maxStores = opts.maxStores ?? 100;
    this.maxSkillStores = opts.maxSkillStores ?? 100;
    this.mode = opts.mode;
    this.memoryCfg = opts.memoryCfg;
    this.dataDir = opts.dataDir ?? ".";
    this.logger = opts.logger;

    // create the BM25 encoder once at initialization; all Stores share it
    this.sharedBm25Encoder = createBM25Encoder(this.memoryCfg.bm25, this.logger as StoreLogger);

    // initialize the Kafka Metric Producer (async, does not block construction)
    this.initKafkaMetricProducer(opts.kafka);

    this.logger.info(`${TAG} Initialized: mode=${this.mode}, maxStores=${this.maxStores}, maxSkillStores=${this.maxSkillStores}, bm25=${this.sharedBm25Encoder ? "shared" : "disabled"}`);
  }

  /**
   * Initialize the Kafka Metric Producer.
   * Runs asynchronously and does not block StorePool construction. Initialization failures are silently ignored.
   * Config priority: StorePoolOptions.kafka > environment variables (fallback)
   */
  private initKafkaMetricProducer(kafka?: KafkaMetricOptions): void {
    // config takes priority; environment variables only as a fallback
    const rawBrokers = kafka?.brokers ?? "";
    const brokers = Array.isArray(rawBrokers)
      ? rawBrokers
      : rawBrokers.split(",").map(s => s.trim()).filter(Boolean);

    const enabled = kafka?.enabled ?? brokers.length > 0;
    if (!enabled || brokers.length === 0) {
      this.logger.info(`${TAG} Kafka metric producer disabled (no brokers configured)`);
      return;
    }

    // async initialization, does not block the business
    metricProducer.initialize({
      brokers,
      topic: kafka?.topic ?? "memory_monitor",
      enabled: true,
    }).catch((err) => {
      // initialization failures are handled silently and do not affect the business
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${TAG} Kafka metric producer init failed: ${msg}. Metrics disabled.`);
    });
  }

  /**
   * Get the Store instance for the given instanceId
   *
   * - standalone (sqlite): vdbConfig may be null; creates a SQLite Store
   * - service (tcvdb): creates a TCVDB Store based on vdbConfig
   */
  async getStore(
    instanceId: string,
    vdbConfig: VdbConfig | null,
    mongoConfig?: MongoConfig | null,
  ): Promise<PooledStore> {
    const now = Date.now();
    // D11: backend selected per-instance from the config actually delivered —
    // mongoConfig present → mongodb; else tcvdb when in tcvdb mode with a vdb;
    // else sqlite. `mode` is the process default that drives which config the
    // caller resolves, but the presence check is authoritative here.
    const backend: StoreMode = mongoConfig
      ? "mongodb"
      : (this.mode === "tcvdb" && vdbConfig ? "tcvdb" : "sqlite");
    const fingerprint =
      backend === "mongodb" && mongoConfig ? this.computeMongoFingerprint(mongoConfig)
      : backend === "tcvdb" && vdbConfig ? this.computeFingerprint(vdbConfig)
      : `sqlite:${instanceId}`;
    const cached = this.pool.get(instanceId);

    // hit and config unchanged
    if (cached && cached.configFingerprint === fingerprint) {
      cached.lastAccessedAt = now;
      return cached.pooledStore;
    }

    // config changed → close the old one
    if (cached) {
      this.logger.info(`${TAG} Config changed for ${instanceId}, recreating store`);
      await this.closeEntry(instanceId, cached);
    }

    // LRU eviction
    if (this.pool.size >= this.maxStores) {
      await this.evictLru();
    }

    // create a new Store
    const pooledStore =
      backend === "mongodb" && mongoConfig ? this.createMongoStore(mongoConfig)
      : backend === "tcvdb" && vdbConfig ? this.createTcvdbStore(vdbConfig)
      : this.createSqliteStore(instanceId);

    this.pool.set(instanceId, {
      pooledStore,
      configFingerprint: fingerprint,
      lastAccessedAt: now,
    });

    const storeDesc =
      backend === "mongodb" && mongoConfig ? `mongodb ${mongoConfig.endpoint} / ${mongoConfig.database}`
      : backend === "tcvdb" && vdbConfig ? `${vdbConfig.url} / ${vdbConfig.database}`
      : `sqlite @ ${this.getSqlitePath(instanceId)}`;
    this.logger.info(
      `${TAG} Created ${backend} store for ${instanceId}: ${storeDesc} (pool size: ${this.pool.size})`,
    );

    // initialize the Store (create tables / check the connection)
    try {
      await pooledStore.store.init();
    } catch (e) {
      this.logger.warn(`${TAG} Store init failed for ${instanceId}: ${e}`);
    }

    return pooledStore;
  }

  /**
   * Remove the Store of the given instance (called when the instance goes offline)
   */
  async evict(instanceId: string): Promise<void> {
    const entry = this.pool.get(instanceId);
    if (entry) {
      await this.closeEntry(instanceId, entry);
    }
  }

  /**
   * Close all Stores
   *
   * CR-5: the original closeAll synchronously closed all stores in the pool, which would crash in-flight requests.
   * Now in two steps:
   *   1. trigger closeEntry for all entries (deferred close, added to pendingCloses)
   *   2. wait for all pendingCloses to complete (including newly added ones + those left by earlier evictions)
   * In process-shutdown scenarios, the caller may choose to shorten the grace time to avoid blocking: setGraceCloseDelay(0)
   */
  async closeAll(): Promise<void> {
    // close the Memory store pool
    const entries = [...this.pool.entries()];
    this.pool.clear();
    // trigger deferred close (these promises are automatically added to pendingCloses)
    for (const [id, entry] of entries) {
      await this.closeEntry(id, entry);  // closeEntry does not block internally and returns immediately
    }

    // close the Skill store cache
    for (const [key, store] of this.skillStoreCache) {
      try {
        store.close();
        this.logger.debug?.(`${TAG} Closed skill store: ${key}`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing skill store ${key}: ${e}`);
      }
    }
    this.skillStoreCache.clear();
    this.skillStoreAccessTimes.clear();

    // wait for all pending closes to complete (including this round + those left by earlier evictions)
    await Promise.allSettled([...this.pendingCloses]);

    // close the shared MongoClient connection pool (disconnect only after all stores have released their references)
    if (this.mongoPool) {
      try {
        await this.mongoPool.closeAll();
        this.logger.debug?.(`${TAG} Closed shared MongoClient pool`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing shared MongoClient pool: ${e}`);
      }
      this.mongoPool = undefined;
    }

    this.logger.info(`${TAG} All stores closed (${entries.length} memory + skill caches cleared)`);
  }

  /**
   * Remove the Skill store of the given instance (called when the instance is destroyed).
   * Calls store.close() to set degraded=true, then removes it from the cache.
   */
  evictSkillStore(instanceId: string): void {
    const key = `skill:${instanceId}`;
    const store = this.skillStoreCache.get(key);
    if (store) {
      try {
        store.close();
      } catch (e) {
        this.logger.warn(`${TAG} Error closing skill store ${key}: ${e}`);
      }
      this.skillStoreCache.delete(key);
      this.skillStoreAccessTimes.delete(key);
      this.logger.info(`${TAG} Evicted skill store for ${instanceId} (cached: ${this.skillStoreCache.size})`);
    }
  }

  /**
   * Set the grace-close delay (ms). Setting it to 0 closes immediately, losing in-flight protection.
   * Mainly for tests or emergency process-exit scenarios.
   */
  setGraceCloseDelay(ms: number): void {
    this.graceCloseDelayMs = Math.max(0, ms);
  }

  get size(): number { return this.pool.size; }
  has(instanceId: string): boolean { return this.pool.has(instanceId); }

  /**
   * Get the Skill Store (TCVDB) for the given instanceId.
   *
   * Uses the same VDB instance as getStore(), only a different Collection ({db}_skills).
   * The Skill store has its own cache (skillStoreCache), unaffected by the Memory store's pooling management.
   */
  async getSkillStore(
    instanceId: string,
    vdbConfig?: VdbConfig | null,
    mongoConfig?: MongoConfig | null,
  ): Promise<ISkillStore> {
    const key = `skill:${instanceId}`;
    const cached = this.skillStoreCache.get(key);
    if (cached) {
      this.skillStoreAccessTimes.set(key, Date.now());
      return cached;
    }

    // LRU eviction
    if (this.skillStoreCache.size >= this.maxSkillStores) {
      this.evictSkillStoreLru();
    }

    if (mongoConfig) {
      const mongoStore = new MongoSkillStore({
        pool: this.getMongoPool(),
        mongoConfig,
        logger: this.logger as StoreLogger,
      });
      mongoStore.init();
      this.skillStoreCache.set(key, mongoStore);
      this.skillStoreAccessTimes.set(key, Date.now());
      this.logger.info(`${TAG} Created mongo skill store for ${instanceId}: ${mongoConfig.endpoint}/${mongoConfig.database} (cached: ${this.skillStoreCache.size})`);
      return mongoStore;
    }

    if (!vdbConfig) {
      throw new Error(`${TAG} getSkillStore(${instanceId}) requires a vdbConfig (tcvdb) or mongoConfig (mongodb)`);
    }

    const store = new TcvdbSkillStore({
      url: vdbConfig.url,
      username: vdbConfig.user,
      apiKey: vdbConfig.apiKey,
      database: vdbConfig.database,
      embeddingModel: this.memoryCfg.tcvdb?.embeddingModel ?? "bge-large-zh",
      timeout: this.memoryCfg.tcvdb?.timeout ?? 10000,
      logger: this.logger as StoreLogger,
      bm25Encoder: this.sharedBm25Encoder,
    });
    store.init();
    this.skillStoreCache.set(key, store);
    this.skillStoreAccessTimes.set(key, Date.now());
    this.logger.info(`${TAG} Created skill store for ${instanceId}: ${vdbConfig.url}/${vdbConfig.database} (cached: ${this.skillStoreCache.size})`);
    return store;
  }

  private skillStoreCache = new Map<string, ISkillStore>();

  // ════════════════════════════════════════════════════════
  // Internal — TCVDB Store
  // ════════════════════════════════════════════════════════

  private createTcvdbStore(vdbConfig: VdbConfig): PooledStore {
    // [DEBUG] For local debugging: connecting to a VDB over public HTTPS requires a CA certificate.
    // Intranet deployments use HTTP port 80 and do not need this logic.
    // The PEM file path is specified via the environment variable VDB_CA_PEM_PATH.
    const caPemPath = vdbConfig.url.startsWith("https://")
      ? (process.env.VDB_CA_PEM_PATH || undefined)
      : undefined;

    const store = new TcvdbMemoryStore({
      url: vdbConfig.url,
      username: vdbConfig.user,
      apiKey: vdbConfig.apiKey,
      database: vdbConfig.database,
      embeddingEnabled: this.memoryCfg.tcvdb?.embeddingEnabled,
      embeddingModel: this.memoryCfg.tcvdb?.embeddingModel ?? "bge-large-zh",
      timeout: this.memoryCfg.tcvdb?.timeout ?? 10000,
      caPemPath,
      logger: this.logger as StoreLogger,
      bm25Encoder: this.sharedBm25Encoder ?? undefined,
    });

    return {
      store,
      embedding: new NoopEmbeddingService() as unknown as EmbeddingService,
      bm25Encoder: this.sharedBm25Encoder,
    };
  }

  // ════════════════════════════════════════════════════════
  // Internal — MongoDB Store
  // ════════════════════════════════════════════════════════

  /** Lazily create the shared MongoClient pool (one client per endpoint). */
  private getMongoPool(): MongoClientPool {
    if (!this.mongoPool) {
      this.mongoPool = getSharedMongoClientPool(this.logger as StoreLogger);
    }
    return this.mongoPool;
  }

  private createMongoStore(mongoConfig: MongoConfig): PooledStore {
    const store = new MongoMemoryStore({
      pool: this.getMongoPool(),
      mongoConfig,
      logger: this.logger as StoreLogger,
    });
    // Mongo uses native mongot/BM25 — no application-layer embedding or bm25 encoder.
    return {
      store,
      embedding: new NoopEmbeddingService() as unknown as EmbeddingService,
      bm25Encoder: undefined,
    };
  }

  private computeMongoFingerprint(mongoConfig: MongoConfig): string {
    return `mongodb:${mongoConfig.endpoint}|${mongoConfig.database}|${mongoConfig.user}`;
  }

  // ════════════════════════════════════════════════════════
  // Internal — SQLite Store
  // ════════════════════════════════════════════════════════

  private createSqliteStore(instanceId: string): PooledStore {
    // Embedding service (remote API, such as OpenAI text-embedding)
    let embeddingService: EmbeddingService | undefined;
    const embCfg = this.memoryCfg.embedding;
    if (embCfg.enabled && embCfg.provider !== "local" && embCfg.provider !== "none" && embCfg.apiKey) {
      embeddingService = createEmbeddingService({
        provider: embCfg.provider,
        baseUrl: embCfg.baseUrl,
        apiKey: embCfg.apiKey,
        model: embCfg.model,
        dimensions: embCfg.dimensions,
        maxInputChars: embCfg.maxInputChars,
      }, this.logger as StoreLogger);
    }

    const dims = embCfg.dimensions ?? 0;
    const dbPath = this.getSqlitePath(instanceId);
    // ensure the database directory exists (for non-default instances)
    const dbDir = path.dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const store = new VectorStore(dbPath, dims, this.logger as StoreLogger);

    return {
      store,
      embedding: (embeddingService ?? new NoopEmbeddingService()) as unknown as EmbeddingService,
      bm25Encoder: this.sharedBm25Encoder,
    };
  }

  /**
   * SQLite file path:
   *   - "default" → dataDir/vectors.db (compatible with the original logic)
   *   - other instanceId → dataDir/instances/{instanceId}/vectors.db
   */
  private getSqlitePath(instanceId: string): string {
    if (instanceId === "default") {
      return path.join(this.dataDir, "vectors.db");
    }
    return path.join(this.dataDir, "instances", instanceId, "vectors.db");
  }

  // ════════════════════════════════════════════════════════
  // Internal — Common
  // ════════════════════════════════════════════════════════

  private computeFingerprint(cfg: VdbConfig): string {
    return `tcvdb:${cfg.url}|${cfg.database}|${cfg.apiKey}`;
  }

  private async closeEntry(instanceId: string, entry: PoolEntry): Promise<void> {
    // CR-5 mitigation: remove from the pool immediately (new requests cannot get this entry and will create a new store),
    // but the underlying store.close() is deferred by graceCloseDelayMs, giving any in-flight request holding a reference
    // to this entry time to complete. No reference counting is added, to avoid modifying all callers;
    // the worker path has maxRetries=3 retry as a backstop, and the sync-path wall clock is far below the grace period, a double safeguard.
    this.pool.delete(instanceId);

    const closePromise = (async () => {
      // wait for the grace period
      if (this.graceCloseDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.graceCloseDelayMs);
          // unref to avoid blocking process exit (closeAll explicitly awaits these promises)
          if (typeof (t as { unref?: () => void }).unref === "function") {
            (t as { unref: () => void }).unref();
          }
        });
      }
      try {
        await entry.pooledStore.store.close();
        this.logger.debug?.(`${TAG} Closed store for ${instanceId} (after ${this.graceCloseDelayMs}ms grace)`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing store for ${instanceId}: ${e}`);
      }
    })();

    this.pendingCloses.add(closePromise);
    closePromise.finally(() => this.pendingCloses.delete(closePromise));
    // not awaited — the caller returns immediately and the real close proceeds in the background
  }

  private async evictLru(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.pool) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.pool.get(oldestKey)!;
      await this.closeEntry(oldestKey, entry);
      this.logger.debug?.(`${TAG} LRU evicted store for ${oldestKey}`);
    }
  }

  /** Skill store LRU eviction: kick out the entry that has gone longest without access. */
  private evictSkillStoreLru(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, time] of this.skillStoreAccessTimes) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const store = this.skillStoreCache.get(oldestKey);
      if (store) {
        try {
          store.close();
        } catch (e) {
          this.logger.warn(`${TAG} Error closing skill store ${oldestKey} during LRU evict: ${e}`);
        }
      }
      this.skillStoreCache.delete(oldestKey);
      this.skillStoreAccessTimes.delete(oldestKey);
      this.logger.debug?.(`${TAG} LRU evicted skill store: ${oldestKey}`);
    }
  }
}
