/**
 * ProxyStorage -- a unified KV abstraction replacing the Redis direct calls previously scattered across the injection layer / Skill layer.
 *
 * See docs/design/2026-07-09-redis-to-cos-migration-plan.md section 3.
 *
 * Semantics:
 *   - key is a relative path string such as "short/inj-sess/abc.json". Absolute paths / path traversal are forbidden
 *   - putJSON/putText overwrite; a successful write is equivalent to "renewal" (updates lastModified, meaningful only for the ttl bucket)
 *   - putJSONIfAbsent/putTextIfAbsent CAS: write only if the key does not exist, returning whether the write succeeded
 *   - getJSON/getText return null when not found, no throw
 *   - delPrefix is used by clearBySession -- each backend implements it itself
 *   - listNames returns the basenames of all objects under the prefix (excluding the prefix)
 *
 * All methods are async; overwrites can be fire-and-forget (`.catch(() => {})`).
 * putIfAbsent must be awaited (the return value decides the following branch).
 */
export type ProxyStorageType = "cos" | "sqlite" | "fs" | "memory";

export interface ProxyStorage {
  readonly type: ProxyStorageType;

  putJSON(key: string, value: unknown): Promise<void>;
  putText(key: string, value: string): Promise<void>;

  /** Atomic "put if absent". Returns true if this call wrote successfully; false if the key already exists. */
  putJSONIfAbsent(key: string, value: unknown): Promise<boolean>;
  putTextIfAbsent(key: string, value: string): Promise<boolean>;

  getJSON<T>(key: string): Promise<T | null>;
  getText(key: string): Promise<string | null>;
  exists(key: string): Promise<boolean>;

  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<number>;

  listNames(prefix: string): Promise<string[]>;
}

/** Determine which bucket tier a key belongs to -- used by the sweeper and the lifecycle rule generator. */
export function bucketOf(key: string): "ttl" | "nottl" {
  return key.startsWith("ttl/") ? "ttl" : "nottl";
}
