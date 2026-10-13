/**
 * ProxyStorage factory -- singleton + degradation chain.
 *
 * See docs/design/2026-07-09-redis-to-cos-migration-plan.md section 3.2.
 *
 * WARNING: cos is the only correct shared backend for multi-node deployments: **once cos is configured it never degrades**; if assembly fails
 *   it throws directly so the process cannot start. Otherwise quietly falling back to process-local (sqlite/fs/memory) would cause
 *   each node to write its own local storage, with cross-node state reads coming back empty (lost session-init forms, etc.).
 *   See docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2.
 *
 * Non-cos backends (local / offline development) keep the degradation chain sqlite -> fs -> memory:
 *   - each degradation emits a `!!! DEGRADED !!!` console.error
 *   - `/health` exposes requested vs effective via `getEffectiveBackend()`
 *   - memory never fails but is explicitly non-persistent, serving only as a fallback to keep the process from crashing.
 */
import { createRequire } from "node:module";
import type { ProxyStorage, ProxyStorageType } from "./proxy-storage.js";
import { MemoryStorage } from "./memory-storage.js";
import { FsStorage } from "./fs-storage.js";
import { SqliteStorage } from "./sqlite-storage.js";
import { CosStorage } from "./cos-storage.js";
import type { CosLikeBackend, KernelStsCosOptions } from "./cos-types.js";

const TAG = "[storage]";
const _require = createRequire(import.meta.url);

/**
 * User config structure -- for the kernel-sts section see
 * docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.1。
 *
 * The COS backend only supports kernel-sts -- static AK/SK has been removed (forbidden in production).
 * For local/offline development use `backend: sqlite` (or fs / memory).
 */
export interface StorageConfig {
  backend: ProxyStorageType;
  /** Lifetime (in days) of objects under the `ttl/` prefix. Only applies to the ttl prefix. */
  ttlDays: number;

  cos: {
    /**
     * Business namespace prefix (isolated from core's memory_v2/cos_data).
     * Note: the CosUrl returned by Shark already carries bucket/region/endpointDomain,
     * so there is no need to configure bucket/region here.
     */
    rootPrefix: string;
    /**
     * Optional: force the VPC internal network / a custom domain (e.g. `cos.example.com`).
     * If empty, uses the host in the CosUrl returned by Shark.
     */
    endpointDomain?: string;
    /** Config for fetching temporary credentials via Shark. */
    shark: {
      baseUrl: string;
      timeoutMs?: number;
      retryCount?: number;
      refreshBufferMs?: number;
      maxSpaces?: number;
      graceCloseDelayMs?: number;
    };
  };

  sqlite: {
    /** empty = use getDb() default (~/.tdai-memory-proxy/proxy.db) */
    dbPath: string;
  };

  fs: {
    fsRoot: string;
  };
}

let _instance: ProxyStorage | null = null;
let _requested: ProxyStorageType = "memory";
let _effective: ProxyStorageType = "memory";
let _lastError: string | undefined;
let _sweepTimer: NodeJS.Timeout | null = null;
/**
 * Reference to the currently effective CosLikeBackend (non-null only when cos assembly succeeded).
 * Kept so that `evictCosSpace()` can, via the optional `evictSpace(spaceId)` hook,
 * evict the per-space backend in the kernel-sts pool; null for other backends / unassembled cases.
 */
let _cosBackend: CosLikeBackend | null = null;
/**
 * kernel-sts COS assembly entry -- dynamic import from the cost-guard submodule.
 * Filled once at `initProxyStorage()`, then used by tryCreate.case("cos") for assembly.
 * null means the submodule is not loaded or unavailable -- the cos branch will take the degradation chain.
 */
let _kernelStsFactory: ((opts: KernelStsCosOptions) => CosLikeBackend) | null = null;

/**
 * Called once at process startup -- does the cost-guard dynamic import, then goes through the synchronous getProxyStorage.
 *
 * When cost-guard is unavailable (open-source users without the submodule / an internal image build that missed the submodule update)
 * it is silently skipped -- the cos branch in getProxyStorage will throw, taking the degradation chain (sqlite -> fs -> memory).
 *
 * See docs/design/2026-07-11-cos-submodule-extraction-plan.md section 4.2 decision 3.
 */
export async function initProxyStorage(config: StorageConfig): Promise<ProxyStorage> {
  if (_instance) return _instance;
  if (config.backend === "cos") {
    try {
      const mod = await import("@context-proxy/cost-guard");
      if (typeof mod.openKernelStsCosBackend === "function") {
        _kernelStsFactory = mod.openKernelStsCosBackend as (opts: KernelStsCosOptions) => CosLikeBackend;
      } else {
        console.warn(`${TAG} cost-guard loaded but openKernelStsCosBackend missing (version mismatch?)`);
      }
    } catch (err) {
      console.warn(
        `${TAG} cost-guard submodule unavailable — cos backend will fall back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return getProxyStorage(config);
}

export function getProxyStorage(config: StorageConfig): ProxyStorage {
  if (_instance) return _instance;
  _requested = config.backend;

  // ── cos: the only correct multi-node shared backend; assembly failure is a hard failure, never degrades ──────────────
  //
  // Once cos is configured, the degradation chain gets no chance. If cos assembly fails (cost-guard submodule
  // missing/version mismatch, shark unreachable, STS fetch failure, etc.) it must throw directly so the process cannot start,
  // and the k8s liveness probe failing naturally removes the bad pod. It must never quietly fall back to process-local
  // (sqlite/fs/memory) -- that would make each node write its own local storage and cross-node session
  // state reads come back empty, with the symptom "written to COS but another node can't see it / the session-init form is skipped".
  // See docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2.
  if (config.backend === "cos") {
    try {
      const created = tryCreate("cos", config);
      if (!created) throw new Error("cos backend factory returned null");
      console.log(`${TAG} activated cos backend`);
      _effective = "cos";
      _instance = created;
      startSweeperIfNeeded(created, config);
      return created;
    } catch (err) {
      _lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `${TAG} !!! FATAL !!! backend cos init failed and fallback is DISABLED — ` +
          `cos is the only valid multi-node backend; refusing to degrade to ` +
          `process-local storage. Fix the deployment (cost-guard submodule / shark / STS) ` +
          `and restart. Cause: ${_lastError}`,
      );
      throw new Error(`${TAG} cos backend init failed (no fallback) — ${_lastError}`);
    }
  }

  // ── non-cos: local/offline development, keep the degradation chain sqlite -> fs -> memory ────────────────
  const chain: ProxyStorageType[] = orderFrom(config.backend);
  for (const backend of chain) {
    try {
      const created = tryCreate(backend, config);
      if (!created) continue;
      if (backend !== _requested) {
        // Degradation = high-risk event, use error level (the old code used warn, which got drowned out)
        console.error(
          `${TAG} !!! DEGRADED !!! backend ${_requested} unavailable — using ${backend} instead${_lastError ? ` (${_lastError})` : ""}`,
        );
        if (backend === "memory" || backend === "fs" || backend === "sqlite") {
          console.error(
            `${TAG} !!! MULTI-NODE HAZARD !!! effective backend=${backend} is process-local;`
            + ` other proxy nodes have their own copy — cross-node reads WILL miss.`,
          );
        }
      } else {
        console.log(`${TAG} activated ${backend} backend`);
      }
      _effective = backend;
      _instance = created;
      startSweeperIfNeeded(created, config);
      return created;
    } catch (err) {
      _lastError = err instanceof Error ? err.message : String(err);
      // Assembly failure is also escalated to error (previously warn)
      console.error(`${TAG} backend ${backend} init failed: ${_lastError}`);
    }
  }

  // Theoretically unreachable -- MemoryStorage does not throw
  console.error(
    `${TAG} !!! LAST-RESORT !!! all backends failed; falling back to in-process memory.`
    + ` Data will NOT persist across restarts and will NOT be visible to other nodes.`,
  );
  _instance = new MemoryStorage();
  _effective = "memory";
  return _instance;
}

export function getEffectiveBackend(): { requested: string; effective: string; error?: string } {
  return { requested: _requested, effective: _effective, error: _lastError };
}

/** Test only -- reset the singleton + stop the sweeper. */
export function __resetProxyStorageForTests(): void {
  _instance = null;
  _requested = "memory";
  _effective = "memory";
  _lastError = undefined;
  _cosBackend = null;
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

/**
 * Evict the per-space backend + STS credential cache of a spaceId in the kernel-sts pool.
 *
 * Trigger scenario: after `/v3/instance/proxy-destroy` clears the COS data, proactively reclaim that space's
 * provider + cos client, to avoid leaving "already unauthorized" credentials in the pool waiting for LRU eviction.
 *
 * Semantics (never throws; distinguish via the return value):
 *   - `"evicted"`      -- successfully removed from the pool and a delayed close scheduled
 *   - `"not-cached"`   -- cos is effective but the pool currently has no such space (never accessed / already evicted)
 *   - `"unsupported"`  -- the current effective backend is not cos, or the cos backend does not expose
 *                         the `evictSpace` hook (e.g. the main repo swaps in a mock backend in future)
 */
export async function evictCosSpace(spaceId: string): Promise<"evicted" | "not-cached" | "unsupported"> {
  if (_effective !== "cos" || !_cosBackend || typeof _cosBackend.evictSpace !== "function") {
    return "unsupported";
  }
  const hit = await _cosBackend.evictSpace(spaceId);
  return hit ? "evicted" : "not-cached";
}

// ── internals ──────────────────────────────────────────────────────────────

function orderFrom(preferred: ProxyStorageType): ProxyStorageType[] {
  const all: ProxyStorageType[] = ["cos", "sqlite", "fs", "memory"];
  const start = all.indexOf(preferred);
  if (start < 0) return all;
  return all.slice(start);
}

function tryCreate(backend: ProxyStorageType, config: StorageConfig): ProxyStorage | null {
  switch (backend) {
    case "memory":
      return new MemoryStorage();
    case "fs": {
      if (!config.fs?.fsRoot) throw new Error("fs.fsRoot not configured");
      return new FsStorage(config.fs.fsRoot);
    }
    case "sqlite": {
      const db = openSqliteDb(config.sqlite?.dbPath);
      return new SqliteStorage(db);
    }
    case "cos": {
      if (!_kernelStsFactory) {
        throw new Error(
          "cost-guard submodule not loaded (call initProxyStorage() at startup, or submodule missing)",
        );
      }
      if (!config.cos.shark?.baseUrl) {
        throw new Error("shark.baseUrl required in kernel-sts mode");
      }
      const backendImpl = _kernelStsFactory(config.cos);
      // Keep the backend reference for evictCosSpace() to use the optional evictSpace(spaceId) hook
      // (the CosStorageBackendMultiSpace assembled by kernel-sts implements it).
      _cosBackend = backendImpl;
      return new CosStorage(backendImpl);
    }
  }
}

function openSqliteDb(dbPath: string): any {
  // Lazy require -- better-sqlite3 is an optional dependency; loading may fail in some images.
  let Database: any;
  try {
    Database = _require("better-sqlite3");
  } catch (err) {
    throw new Error(`better-sqlite3 unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (dbPath && dbPath.trim().length > 0) return new Database(dbPath);
  // The default path reuses the resolveDbPath logic of db/index.ts: env var > ~/.tdai-memory-proxy/proxy.db.
  // Not via require ../db/index.js -- ESM fails under tsx -- inline it once directly.
  const os = _require("node:os");
  const path = _require("node:path");
  const fs = _require("node:fs");
  const fromEnv = process.env.PROXY_DB_PATH;
  const resolved =
    fromEnv && fromEnv.trim().length > 0
      ? fromEnv.trim()
      : path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return new Database(resolved);
}

// The kernel-sts COS assembly logic has been moved to the cost-guard submodule
// (packages/cost-guard/src/storage/kernel-sts-factory.ts)。
// The main repo obtains _kernelStsFactory via the initProxyStorage() dynamic import.

function startSweeperIfNeeded(storage: ProxyStorage, config: StorageConfig): void {
  if (storage.type !== "sqlite") return;
  if (_sweepTimer) return; // already running
  const ttlMs = config.ttlDays * 86400 * 1000;
  const run = () => {
    try {
      // Only clear the ttl bucket; nottl is kept permanently (consistent with the semantics of the COS lifecycle rule).
      (storage as SqliteStorage).sweep({ ttlMs });
    } catch (err) {
      console.warn(`${TAG} sweeper error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  _sweepTimer = setInterval(run, 5 * 60 * 1000);
  // don't hold the event loop just for the sweeper
  if (typeof _sweepTimer.unref === "function") _sweepTimer.unref();
}
