/**
 * InstanceConfigProvider — instance-level configuration management
 *
 * Design notes:
 *   - VDB config: per-instance (separate VDB connection info per instanceId), with TTL cache
 *   - COS config: one global shared copy (all instances share one bucket, isolated by pathPrefix)
 *   - Config sources are provided through an injected IConfigSource:
 *     - standalone: LocalConfigSource (built into this file, reads from env vars)
 *     - service:    remote config source injected by the deployment environment
 *
 * Data model:
 *   Core process
 *     ├── COS: one global copy { cosUrl, tmpSecretId, tmpSecretKey, tmpToken, expirationTime, pathPrefix }
 *     └── VDB pool (Map<instanceId, VdbConfig>):
 *         ├── inst-001 → { url: vdb-1, apiKey: xxx, database: db1 }
 *         ├── inst-002 → { url: vdb-2, apiKey: yyy, database: db2 }
 *         └── inst-003 → { url: vdb-1, apiKey: xxx, database: db3 }
 */

import type { IConfigSource } from "./abstractions/index.js";
import { readVdbEnvConfig, readCosEnvConfig, readMongoEnvConfig } from "../utils/env-config.js";

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

export interface VdbConfig {
  url: string;
  user: string;
  apiKey: string;
  database: string;
}

/**
 * Per-instance MongoDB connection info (phase-1 data-plane backend).
 *
 * Delivered per-instance mirroring {@link VdbConfig}, but with an independent
 * namespace. `database` is delivered verbatim (never derived from instanceId):
 * one per-instance database, collections are bare-named inside it.
 */
export interface MongoConfig {
  endpoint: string;
  user: string;
  password: string;
  database: string;
}

export interface CosConfig {
  cosUrl: string;
  tmpSecretId: string;
  tmpSecretKey: string;
  tmpToken: string;
  /** ISO 8601 expiration time (only valid in temporary-credential mode) */
  expirationTime: string;
  pathPrefix: string;
}

export interface InstanceConfig {
  instanceId: string;
  vdb: VdbConfig;
  cos: CosConfig | null;
}

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// Re-export interface for backward compatibility (consumers may still
// import IConfigSource from this module — the canonical location is now
// src/core/abstractions/).
export type { IConfigSource };

// ════════════════════════════════════════════════════════
// LocalConfigSource — default implementation (open-source / standalone)
// ════════════════════════════════════════════════════════
//
// Reads VDB + COS config from process environment variables. Suitable for single-tenant self-hosted deployments without a control plane.
// Co-located with the interface, following existing project convention (cf. MockCredentialProvider and
// ICredentialProvider, both written in src/core/storage/credential-provider.ts).
//
// Environment variables:
//   VDB_ENDPOINT, VDB_USER, VDB_API_KEY, VDB_DATABASE
//   COS_SECRET_ID, COS_SECRET_KEY, COS_TOKEN, COS_URL, COS_PATH_PREFIX

export class LocalConfigSource implements IConfigSource {
  // Logger kept for future diagnostic logging; constructor signature mirrors
  // remote sources so callers can swap implementations interchangeably.
  constructor(private readonly _logger: Logger) {
    void this._logger;
  }

  async fetchVdb(_instanceId: string): Promise<VdbConfig> {
    return readVdbEnvConfig();
  }

  async fetchMongo(_instanceId: string): Promise<MongoConfig> {
    return readMongoEnvConfig();
  }

  async fetchCos(): Promise<CosConfig | null> {
    const cfg = readCosEnvConfig();
    if (!cfg) return null;
    return {
      cosUrl: cfg.cosUrl,
      tmpSecretId: cfg.tmpSecretId,
      tmpSecretKey: cfg.tmpSecretKey,
      tmpToken: cfg.tmpToken,
      expirationTime: "",
      pathPrefix: cfg.pathPrefix,
    };
  }
}

// ════════════════════════════════════════════════════════
// VDB cache entry
// ════════════════════════════════════════════════════════

interface VdbCacheEntry {
  config: VdbConfig;
  expiresAt: number;
  lastAccessedAt: number;
}

interface MongoCacheEntry {
  config: MongoConfig;
  expiresAt: number;
  lastAccessedAt: number;
}

// ════════════════════════════════════════════════════════
// InstanceConfigProvider
// ════════════════════════════════════════════════════════

export interface InstanceConfigProviderOptions {
  /**
   * Pre-constructed config source for the current deployment.
   */
  source: IConfigSource;
  /** VDB cache TTL (ms), default 5 minutes */
  vdbTtlMs?: number;
  /** COS credential early-refresh time (ms), default 2 minutes */
  cosBufferMs?: number;
  /** Max cached instances; evicted by LRU beyond this, default 1000 */
  maxInstances?: number;
  logger: Logger;
}

export class InstanceConfigProvider {
  private source: IConfigSource;
  private logger: Logger;

  // ── VDB: per-instance cache ──
  private vdbPool = new Map<string, VdbCacheEntry>();
  private vdbTtlMs: number;
  private maxInstances: number;
  /**
   * Per-instance in-flight fetch dedupe (H-2 fix):
   * On concurrent first access to the same instanceId, reuse the same fetch Promise,
   * to avoid firing N simultaneous requests at the source and triggering rate limiting.
   */
  private vdbFetchPromises = new Map<string, Promise<VdbConfig>>();

  // ── Mongo: per-instance cache (symmetric with VDB, separate namespace) ──
  private mongoPool = new Map<string, MongoCacheEntry>();
  private mongoFetchPromises = new Map<string, Promise<MongoConfig>>();

  // ── COS: global singleton cache (one credential, isolated by PathPrefix) ──
  private cosCache: CosConfig | null = null;
  private cosExpiresAt = 0;
  private cosBufferMs: number;
  private cosFetchPromise: Promise<CosConfig | null> | null = null;

  constructor(opts: InstanceConfigProviderOptions) {
    this.logger = opts.logger;
    this.vdbTtlMs = opts.vdbTtlMs ?? 5 * 60 * 1000;
    this.cosBufferMs = opts.cosBufferMs ?? 2 * 60 * 1000;
    this.maxInstances = opts.maxInstances ?? 1000;
    this.source = opts.source;
    this.logger.info(`[instance-config] InstanceConfigProvider initialized (source=${opts.source.constructor.name})`);
  }

  // ════════════════════════════════════════════════════════
  // Public API
  // ════════════════════════════════════════════════════════

  /**
   * Get the full config for the given instance (VDB per-instance + COS global)
   */
  async resolve(instanceId: string): Promise<InstanceConfig> {
    const [vdb, cos] = await Promise.all([
      this.resolveVdb(instanceId),
      this.resolveCos(),
    ]);
    return { instanceId, vdb, cos };
  }
  /**
   * Get the VDB config for the given instance (cached)
   *
   * Strategy:
   * 1. Cache hit and not expired → return directly (and refresh the LRU position)
   * 2. Cache empty or expired → fetch from source (in-flight dedup for concurrent requests on the same instanceId)
   * 3. Source returns empty/error → throw and log directly (empty values are not cached)
   */
  async resolveVdb(instanceId: string): Promise<VdbConfig> {
    const now = Date.now();
    const cached = this.vdbPool.get(instanceId);

    if (cached && now < cached.expiresAt) {
      cached.lastAccessedAt = now;
      // LRU reorder (H-3): move the entry to the end of the Map so that evicting the first element yields the LRU.
      // delete+set is an O(1) Map operation on V8.
      this.vdbPool.delete(instanceId);
      this.vdbPool.set(instanceId, cached);
      return cached.config;
    }

    // Cache miss or expired → enter the fetch path; dedup first, then request (H-2)
    const inflight = this.vdbFetchPromises.get(instanceId);
    if (inflight) {
      this.logger.debug?.(`[instance-config] VDB fetch in-flight for ${instanceId}, awaiting...`);
      return inflight;
    }

    this.logger.debug?.(`[instance-config] VDB cache ${cached ? "expired" : "miss"} for ${instanceId}, fetching...`);
    const fetchPromise = this.fetchAndStoreVdb(instanceId);
    this.vdbFetchPromises.set(instanceId, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      // Clear the in-flight marker. Must be cleared after the await (even if fetch throws),
      // otherwise a single failure would leave that instanceId stuck forever.
      this.vdbFetchPromises.delete(instanceId);
    }
  }

  /**
   * Actually performs the source fetch + writes into vdbPool.
   * Called only from inside resolveVdb (concurrent dedup guarantees it runs once).
   */
  private async fetchAndStoreVdb(instanceId: string): Promise<VdbConfig> {
    const config = await this.source.fetchVdb(instanceId);

    // Source returned empty → throw and log directly
    if (!config || !config.url) {
      const msg = `[instance-config] Config source returned empty VDB config for instanceId="${instanceId}" (url=${config?.url})`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    // LRU eviction
    if (this.vdbPool.size >= this.maxInstances && !this.vdbPool.has(instanceId)) {
      this.evictLru();
    }

    const now = Date.now();
    this.vdbPool.set(instanceId, {
      config,
      expiresAt: now + this.vdbTtlMs,
      lastAccessedAt: now,
    });

    return config;
  }

  /**
   * Get the Mongo config for the given instance (cached). Symmetric with {@link resolveVdb}:
   * reuses the same TTL / LRU / in-flight dedup semantics, just with a separate pool.
   *
   * If the current config source does not implement fetchMongo (e.g. a service source not yet wired to Shark),
   * throws directly — the mongodb backend requires the config source to deliver Mongo connection info (fail-loud, D13).
   */
  async resolveMongo(instanceId: string): Promise<MongoConfig> {
    const now = Date.now();
    const cached = this.mongoPool.get(instanceId);

    if (cached && now < cached.expiresAt) {
      cached.lastAccessedAt = now;
      this.mongoPool.delete(instanceId);
      this.mongoPool.set(instanceId, cached);
      return cached.config;
    }

    const inflight = this.mongoFetchPromises.get(instanceId);
    if (inflight) {
      this.logger.debug?.(`[instance-config] Mongo fetch in-flight for ${instanceId}, awaiting...`);
      return inflight;
    }

    this.logger.debug?.(`[instance-config] Mongo cache ${cached ? "expired" : "miss"} for ${instanceId}, fetching...`);
    const fetchPromise = this.fetchAndStoreMongo(instanceId);
    this.mongoFetchPromises.set(instanceId, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.mongoFetchPromises.delete(instanceId);
    }
  }

  private async fetchAndStoreMongo(instanceId: string): Promise<MongoConfig> {
    if (typeof this.source.fetchMongo !== "function") {
      const msg = `[instance-config] Config source (${this.source.constructor.name}) does not implement fetchMongo — mongodb backend unavailable`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    const config = await this.source.fetchMongo(instanceId);

    if (!config || !config.endpoint || !config.database) {
      const msg = `[instance-config] Config source returned incomplete Mongo config for instanceId="${instanceId}" (endpoint=${config?.endpoint}, database=${config?.database})`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    if (this.mongoPool.size >= this.maxInstances && !this.mongoPool.has(instanceId)) {
      this.evictMongoLru();
    }

    const now = Date.now();
    this.mongoPool.set(instanceId, {
      config,
      expiresAt: now + this.vdbTtlMs,
      lastAccessedAt: now,
    });

    return config;
  }

  /** Clear the Mongo cache for the given instance (called when the instance goes offline). */
  evictMongo(instanceId: string): void {
    this.mongoPool.delete(instanceId);
    this.logger.debug?.(`[instance-config] Evicted Mongo cache for ${instanceId}`);
  }

  private evictMongoLru(): void {
    const firstKey = this.mongoPool.keys().next().value;
    if (firstKey !== undefined) {
      this.mongoPool.delete(firstKey);
      this.logger.debug?.(`[instance-config] LRU evicted Mongo cache for ${firstKey}`);
    }
  }

  /**
   * Get the global COS config (cached, auto-renews temporary credentials)
   */
  async resolveCos(): Promise<CosConfig | null> {
    const now = Date.now();

    // Cache valid → return directly
    if (this.cosCache && now < this.cosExpiresAt) {
      return this.cosCache;
    }

    // Prevent concurrent requests from refreshing simultaneously
    if (this.cosFetchPromise) {
      return this.cosFetchPromise;
    }

    this.cosFetchPromise = this.refreshCos(now).finally(() => {
      this.cosFetchPromise = null;
    });

    return this.cosFetchPromise;
  }

  /**
   * Clear the VDB cache for the given instance (called when the instance goes offline)
   */
  evictVdb(instanceId: string): void {
    this.vdbPool.delete(instanceId);
    this.logger.debug?.(`[instance-config] Evicted VDB cache for ${instanceId}`);
  }

  /**
   * Force-refresh COS credentials
   */
  async refreshCosNow(): Promise<CosConfig | null> {
    return this.refreshCos(Date.now());
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.vdbPool.clear();
    this.mongoPool.clear();
    this.cosCache = null;
    this.cosExpiresAt = 0;
    this.logger.info(`[instance-config] All caches cleared`);
  }

  /**
   * Number of currently cached instances
   */
  get poolSize(): number {
    return this.vdbPool.size;
  }

  /**
   * Whether the current COS credential is valid
   */
  get isCosValid(): boolean {
    return this.cosCache !== null && Date.now() < this.cosExpiresAt;
  }

  // ════════════════════════════════════════════════════════
  // Internal
  // ════════════════════════════════════════════════════════

  private async refreshCos(now: number): Promise<CosConfig | null> {
    this.logger.debug?.(`[instance-config] Refreshing COS config...`);
    try {
      const cos = await this.source.fetchCos();
      this.cosCache = cos;
      this.cosExpiresAt = this.calcCosExpiry(cos, now);
      return cos;
    } catch (e) {
      this.logger.warn(`[instance-config] Failed to refresh COS config: ${e}`);
      // If the old cache is still present, extend it briefly and keep using it (degraded mode)
      if (this.cosCache) {
        this.cosExpiresAt = now + 30_000; // retry after 30s
        this.logger.warn(`[instance-config] Using stale COS config for 30s`);
        return this.cosCache;
      }
      return null;
    }
  }

  /**
   * Compute the COS cache expiration time:
   *   - With expirationTime: min(server expiration time - buffer, vdbTtl)
   *   - Without expirationTime: use vdbTtl (local long-lived credential scenario)
   */
  private calcCosExpiry(cos: CosConfig | null, now: number): number {
    if (!cos?.expirationTime) {
      return now + this.vdbTtlMs;
    }
    const serverExpiry = new Date(cos.expirationTime).getTime();
    if (isNaN(serverExpiry)) {
      return now + this.vdbTtlMs;
    }
    return Math.min(serverExpiry - this.cosBufferMs, now + this.vdbTtlMs);
  }

  /**
   * LRU eviction: remove the least recently accessed instance.
   *
   * Implementation note (H-3): relies on the Map's insertion order being the access order — resolveVdb, on a cache hit,
   * already does delete+set to move the hot key to the end of the Map, so the Map's first element is the LRU,
   * and taking the first key is enough, O(1).
   */
  private evictLru(): void {
    const firstKey = this.vdbPool.keys().next().value;
    if (firstKey !== undefined) {
      this.vdbPool.delete(firstKey);
      this.logger.debug?.(`[instance-config] LRU evicted VDB cache for ${firstKey}`);
    }
  }
}
