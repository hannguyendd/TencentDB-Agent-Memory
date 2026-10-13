/**
 * BindingRepo — long-lived session binding persistence.
 *
 * Stores a small "note" in KV, recording only the outcome + id group, never auto-cleaned (`nottl/` prefix).
 * Used to wake dormant conversations + let the bridge look up identity in L2.
 *
 * ── Signature note ────────────────────────────────────────────────────────
 * See docs/design/2026-08-03-binding-flatten.md:
 *   - The original scheme (2026-07-10) used `(userId, agentSource, sessionId)` as a 3-segment key,
 *     plus `spaceId` from P4 (2026-07-12 kernel-sts), making 4 segments in total
 *   - But the bridge-side curl can only supply (spaceId, sessionId) -- it cannot get userId/agentSource,
 *     so on a cross-pod L1 miss the old key could never be rebuilt, ending in a 401
 *   - After flattening: method signatures shrink to `(spaceId, sessionId)`, userId/agentSource move into
 *     the `SessionBinding` struct, and `userKey` is stored too (after memory-bridge L2b
 *     recovery, chat_memory retrieval no longer degrades)
 */

import type { Redis } from "ioredis";

const REDIS_KEY_PREFIX = "inj:binding:";
const DEFAULT_BINDING_TTL_DAYS = 30;

export interface SessionBinding {
  outcome: "initialized" | "bypassed";
  userId?: string;
  teamId?: string;
  agentId?: string;
  taskId?: string;
  /**
   * URL path agent prefix (`claude-code` / `codebuddy` ...). Carried over from the identity when the session init
   * is persisted, and used by the bridge to stamp outbound requests on lookup.
   */
  agentSource?: string;
  /**
   * User apiKey. memory-bridge needs it when restoring chat_memory retrieval to ask the kernel
   * for imported agents (see `memory-bridge.ts:resolveMemoryCtxs`); when missing it
   * silently degrades to self-only. The old 4-segment path did not carry this field, so recovery always degraded --
   * it is stored together after flattening, which fixes that as a side effect.
   */
  userKey?: string;
}

export interface BindingRepo {
  getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null>;
  putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void>;
  deleteBinding(spaceId: string, sessionId: string): Promise<void>;
  touchLastSeen(spaceId: string, sessionId: string): Promise<void>;
}

function ttlSeconds(days: number): number {
  return days * 86400;
}

function redisKey(spaceId: string, sessionId: string): string {
  const sp = spaceId || "_default";
  return `${REDIS_KEY_PREFIX}${sp}:${sessionId}`;
}

export class RedisBindingRepo implements BindingRepo {
  constructor(
    private redis: Redis,
    private bindingTtlDays: number = DEFAULT_BINDING_TTL_DAYS,
  ) {}

  async getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null> {
    try {
      const all = await this.redis.hgetall(redisKey(spaceId, sessionId));
      if (!all || Object.keys(all).length === 0) return null;
      return {
        outcome: (all.outcome as "initialized" | "bypassed") || "initialized",
        userId: all.user_id || undefined,
        teamId: all.team_id || undefined,
        agentId: all.agent_id || undefined,
        taskId: all.task_id || undefined,
        agentSource: all.agent_source || undefined,
        userKey: all.user_key || undefined,
      };
    } catch {
      return null;
    }
  }

  async putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void> {
    const now = Date.now().toString();
    try {
      const fields: Record<string, string> = {
        outcome: binding.outcome,
        created_at: now,
        last_seen: now,
      };
      if (binding.userId) fields.user_id = binding.userId;
      if (binding.teamId) fields.team_id = binding.teamId;
      if (binding.agentId) fields.agent_id = binding.agentId;
      if (binding.taskId) fields.task_id = binding.taskId;
      if (binding.agentSource) fields.agent_source = binding.agentSource;
      if (binding.userKey) fields.user_key = binding.userKey;

      const key = redisKey(spaceId, sessionId);
      await this.redis.hset(key, fields);
      await this.redis.expire(key, ttlSeconds(this.bindingTtlDays));
    } catch {
      /* ignore */
    }
  }

  async deleteBinding(spaceId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.del(redisKey(spaceId, sessionId));
    } catch {
      /* ignore */
    }
  }

  async touchLastSeen(spaceId: string, sessionId: string): Promise<void> {
    try {
      const key = redisKey(spaceId, sessionId);
      await this.redis.hset(key, "last_seen", Date.now().toString());
      await this.redis.expire(key, ttlSeconds(this.bindingTtlDays));
    } catch {
      /* ignore */
    }
  }
}

/** Null repo for when Redis is disabled. */
export class NullBindingRepo implements BindingRepo {
  async getBinding(_spaceId: string, _sessionId: string): Promise<SessionBinding | null> { return null; }
  async putBinding(_spaceId: string, _sessionId: string, _binding: SessionBinding): Promise<void> {}
  async deleteBinding(_spaceId: string, _sessionId: string): Promise<void> {}
  async touchLastSeen(_spaceId: string, _sessionId: string): Promise<void> {}
}
