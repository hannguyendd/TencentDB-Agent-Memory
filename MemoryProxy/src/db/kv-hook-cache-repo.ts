/**
 * KvHookCacheRepo —— HookCacheRepo backed by ProxyStorage.
 *
 * See docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2 §3.6.
 *
 * Key path:
 *   ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-hook/<hookId>.json
 *
 * spaceId is the isolation segment added by P4 (kernel-sts). Old callers passing an empty string fall back to `_default`.
 *
 * QPS amplification warning: `putMany` goes from 1 HSET to N concurrent PUTs; `getAllForSession`
 * goes from 1 HGETALL to 1 LIST + N GETs. The injection layer usually has 3-5 hookIds per session,
 * which is acceptable; if load tests show a bottleneck it can degrade to packing the whole session.
 */
import type { HookCacheRepo, HookCacheEntry } from "./hookCacheRepo.js";
import type { ContextBlock } from "../injection/types.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { sessionDirOf, assertKeySegment } from "../storage/key-utils.js";

function hookDir(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sessionDirOf("ttl", sp, userId, agentSource, sessionId)}inj-hook/`;
}

function keyOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
  hookId: string,
): string {
  assertKeySegment("hookId", hookId);
  return `${hookDir(spaceId, userId, agentSource, sessionId)}${hookId}.json`;
}

export class KvHookCacheRepo implements HookCacheRepo {
  constructor(private readonly storage: ProxyStorage) {}

  async put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): Promise<void> {
    await this.storage
      .putJSON(keyOf(spaceId, userId, agentSource, sessionId, hookId), blocks)
      .catch(() => { /* silent */ });
  }

  async putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    // Concurrent PUTs -- keeps wall-clock ≈ a single PUT instead of N serial ones
    await Promise.all(
      entries.map((e) =>
        this.storage
          .putJSON(keyOf(spaceId, userId, agentSource, sessionId, e.hookId), e.blocks)
          .catch(() => { /* silent */ }),
      ),
    );
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    try {
      return await this.storage.getJSON<ContextBlock[]>(
        keyOf(spaceId, userId, agentSource, sessionId, hookId),
      );
    } catch {
      return null;
    }
  }

  async getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]> {
    try {
      const dir = hookDir(spaceId, userId, agentSource, sessionId);
      const names = await this.storage.listNames(dir);
      const out: HookCacheEntry[] = [];
      const settled = await Promise.all(
        names
          .filter((n) => n.endsWith(".json"))
          .map(async (n) => {
            const blocks = await this.storage
              .getJSON<ContextBlock[]>(dir + n)
              .catch(() => null);
            if (!Array.isArray(blocks)) return null;
            return { hookId: n.slice(0, -".json".length), blocks };
          }),
      );
      for (const e of settled) if (e) out.push(e);
      return out;
    } catch {
      return [];
    }
  }

  async clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<void> {
    await this.storage
      .delPrefix(hookDir(spaceId, userId, agentSource, sessionId))
      .catch(() => { /* silent */ });
  }
}
