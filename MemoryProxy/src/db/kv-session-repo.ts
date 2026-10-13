/**
 * KvSessionRepo —— SessionRepo backed by ProxyStorage.
 *
 * See docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2 §3.6.
 *
 * Key path:
 *   ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json
 *
 * spaceId is the isolation segment added by P4 (kernel-sts). Old callers passing an empty string fall back to `_default`.
 *
 * `upsert` is an async write-through -- once the caller's `await` completes, L2a is guaranteed to be persisted.
 * This is the direct basis of the 2026-07-13 fix for "cross-node session-init intermediate-state race -> request passes through to the LLM"
 * (under the old fire-and-forget semantics, the COS PUT could still be in flight when pod A closed the stream,
 * and the turn-2 landing on pod B missed L2a and fell into the tryHistoryScan fallback -> bypass).
 * Write failures keep the silent degradation: catch, only warn, never throw -- the upper-layer L1 remains authoritative.
 *
 * Read methods are async; a miss returns null and does not throw.
 *
 * `loadAllInitialized`：
 *   - Under the CosStorage backend, always returns [] (startup hydrate is disabled; lazy-load via probeL2a)
 *   - SqliteStorage / FsStorage / MemoryStorage use listNames + getJSON,
 *     recovering the 4-segment identity (spaceId, userId, agentSource, sessionId) from the key
 */
import type { SessionRepo, HydratedSessionRow } from "./sessionRepo.js";
import type { SessionInitState } from "../session/types.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { sessionDirOf } from "../storage/key-utils.js";

const TTL_BUCKET_PREFIX = "ttl/";
const MAIN_FILENAME = "inj-sess.json";

function mainKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sessionDirOf("ttl", sp, userId, agentSource, sessionId)}${MAIN_FILENAME}`;
}

export class KvSessionRepo implements SessionRepo {
  constructor(private readonly storage: ProxyStorage) {}

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<void> {
    // Compute the key up front -- assertKeySegment / assertAgentSource validation throws synchronously here,
    // letting callers observe illegal parameters at the wiring layer (instead of a silent async failure).
    const key = mainKey(spaceId, userId, agentSource, sessionId);
    try {
      await this.storage.putJSON(key, state);
    } catch (err) {
      // Silent degradation: L1 remains the authoritative write-through target; an L2a write failure does not block the main flow.
      const e = err as { statusCode?: number; code?: string; message?: string };
      console.warn(
        `[kv-session] upsert FAIL key=${key}: ` +
          `${e?.statusCode ?? ""} ${e?.code ?? ""} ${e?.message ?? String(err)}`,
      );
    }
  }

  async getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null> {
    try {
      return await this.storage.getJSON<SessionInitState>(
        mainKey(spaceId, userId, agentSource, sessionId),
      );
    } catch {
      return null;
    }
  }

  deleteBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void {
    this.storage
      .del(mainKey(spaceId, userId, agentSource, sessionId))
      .catch(() => { /* silent */ });
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    // Disable startup hydrate under CosStorage -- a full listObjects is too slow and of limited value
    // (with multiple nodes it only covers the first request on this node). Lazy-load via probeL2a instead.
    if (this.storage.type === "cos") return [];

    try {
      // listNames is given the "ttl/" prefix and returns names with that prefix removed,
      // expected to look like "<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json".
      const names = await this.storage.listNames(TTL_BUCKET_PREFIX);
      const out: HydratedSessionRow[] = [];
      const suffix = `/${MAIN_FILENAME}`;
      for (const name of names) {
        if (!name.endsWith(suffix)) continue;
        const stem = name.slice(0, -suffix.length);
        const segs = stem.split("/");
        if (segs.length !== 4) continue;
        const [spaceId, userId, agentSource, sessionId] = segs;
        const state = await this.storage.getJSON<SessionInitState>(
          TTL_BUCKET_PREFIX + name,
        );
        if (!state || state.status !== "initialized") continue;
        out.push({ spaceId, userId, agentSource, sessionId, state });
      }
      return out;
    } catch {
      return [];
    }
  }
}
