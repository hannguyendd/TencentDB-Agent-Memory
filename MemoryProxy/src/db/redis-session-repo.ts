/**
 * RedisSessionRepo — Redis-backed persistence for SessionInitState.
 *
 * Implements the SessionRepo interface. Key design:
 *   inj:sess:{spaceId}:{userId}:{agentSource}:{sessionId}  = SessionInitState JSON
 *
 * spaceId is the isolation segment added by P4 kernel-sts. Old callers passing an empty string fall back to `_default`.
 *
 * Since sessionKey === sessionId always holds and the by-sid reverse lookup has been
 * removed from the SessionRepo interface (see `2026-07-10-cos-ttl-nottl-split-plan.md`), this implementation also
 * drops the reverse-index writes.
 *
 * All errors degrade silently — the in-memory Map is always authoritative.
 */
import type { Redis } from "ioredis";
import type { SessionRepo, HydratedSessionRow } from "./sessionRepo.js";
import type { SessionInitState } from "../session/types.js";

const KEY_PREFIX = "inj:sess:";
const DEFAULT_TTL = 30 * 60; // 30 minutes

function compositeKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sp}:${userId}:${agentSource}:${sessionId}`;
}

export class RedisSessionRepo implements SessionRepo {
  private ttl: number;

  constructor(
    private redis: Redis,
    ttlSeconds?: number,
  ) {
    this.ttl = ttlSeconds ?? DEFAULT_TTL;
  }

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<void> {
    const key = KEY_PREFIX + compositeKey(spaceId, userId, agentSource, sessionId);
    // await the write-through: in multi-node deployments L2a must be persisted before pod A closes the stream,
    // otherwise pod B turn-2 will miss L2a -> tryHistoryScan bypass -> pass straight through to the LLM.
    // See the 2026-07-13 fix; write failures still degrade silently (L1 remains the authoritative fast path).
    try {
      await this.redis.setex(key, this.ttl, JSON.stringify(state));
    } catch {
      /* silent — the L1 authoritative fast path still applies */
    }
  }

  async getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null> {
    try {
      const raw = await this.redis.get(
        KEY_PREFIX + compositeKey(spaceId, userId, agentSource, sessionId),
      );
      if (!raw) return null;
      return JSON.parse(raw) as SessionInitState;
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
    this.redis
      .del(KEY_PREFIX + compositeKey(spaceId, userId, agentSource, sessionId))
      .catch(() => {});
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    try {
      const keys = await this.scanKeys(KEY_PREFIX + "*");
      if (keys.length === 0) return [];
      const raws = await this.redis.mget(...keys);
      const result: HydratedSessionRow[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (!raws[i]) continue;
        try {
          const state = JSON.parse(raws[i]!) as SessionInitState;
          if (state.status !== "initialized") continue;
          const tail = keys[i].slice(KEY_PREFIX.length);
          const parts = tail.split(":");
          if (parts.length < 4) continue;
          const [spaceId, userId, agentSource, ...rest] = parts;
          result.push({
            spaceId,
            userId,
            agentSource,
            sessionId: rest.join(":"),
            state,
          });
        } catch {
          /* skip corrupt */
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const reply = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "100",
      );
      cursor = reply[0];
      keys.push(...reply[1]);
    } while (cursor !== "0");
    return keys;
  }
}
