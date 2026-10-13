/**
 * CosStorage -- the object-storage implementation of ProxyStorage (COS / S3-compatible).
 *
 * Positioning: the first choice for multi-instance production.
 *
 * Dependency injection: does not `import COS from "cos-nodejs-sdk-v5"` directly, but takes a minimal
 * `CosLikeBackend` interface (PUT / GET / HEAD / DELETE / LIST), injected by the factory layer
 * with a real SDK instance. This lets unit tests verify the full CosStorage logic with a mock backend
 * without touching a real bucket; in production the injected one is the openclaw plugin's SharedCosClient wrapper.
 *
 * Key semantics:
 *   - putIfAbsent uses the COS `If-None-Match: "*"` header -- returns 412 if it exists
 *   - TTL is handled by the bucket lifecycle rule as a backstop (based on lastModified)
 *   - Credential 403 / retry logic is handled by the underlying backend, not at this layer
 */
import type { ProxyStorage } from "./proxy-storage.js";

/**
 * CosLikeBackend contract -- **defined in cos-types.ts, re-exported here for backward compatibility**.
 *
 * Production implementation: CosStorageBackendMultiSpace in the cost-guard submodule (via
 * `await import("@context-proxy/cost-guard")`). Tests: use an in-memory mock
 * (see cos-storage.test.ts).
 *
 * After the submodule extraction on 2026-07-13, cos-types.ts was added to hold CosLikeBackend +
 * KernelStsCosOptions; this file only re-exports them, signatures unchanged, to avoid breaking old callers
 * `import { CosLikeBackend } from "./cos-storage.js"`。
 */
export type { CosLikeBackend } from "./cos-types.js";
import type { CosLikeBackend } from "./cos-types.js";

export class CosStorage implements ProxyStorage {
  readonly type = "cos" as const;

  constructor(private readonly backend: CosLikeBackend) {}

  async putText(key: string, value: string): Promise<void> {
    await this.backend.putObject(key, Buffer.from(value, "utf-8"));
  }

  async putJSON(key: string, value: unknown): Promise<void> {
    return this.putText(key, JSON.stringify(value));
  }

  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    try {
      await this.backend.putObject(key, Buffer.from(value, "utf-8"), { "If-None-Match": "*" });
      return true;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 412) return false; // Preconditions failed = key existed
      throw err;
    }
  }

  async putJSONIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.putTextIfAbsent(key, JSON.stringify(value));
  }

  async getText(key: string): Promise<string | null> {
    const buf = await this.backend.getObject(key);
    if (!buf) return null;
    return buf.toString("utf-8");
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.getText(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return this.backend.headObject(key);
  }

  async del(key: string): Promise<void> {
    await this.backend.deleteObject(key);
  }

  async delPrefix(prefix: string): Promise<number> {
    const keys = await this.backend.listKeys(prefix);
    let n = 0;
    for (const k of keys) {
      await this.backend.deleteObject(k).catch(() => { /* best-effort */ });
      n++;
    }
    return n;
  }

  async listNames(prefix: string): Promise<string[]> {
    const keys = await this.backend.listKeys(prefix);
    return keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));
  }
}
