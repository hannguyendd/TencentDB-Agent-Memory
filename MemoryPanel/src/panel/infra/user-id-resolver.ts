/**
 * user_key -> user_id cache resolver (used for telemetry instrumentation).
 *
 * ## Why it is needed
 * `panel_api_call_logs.user_id` is supplied by `c.set('resolvedUserId', ...)` after `resolveCallerUserId` in the route handler;
 * but the vast majority of routes (skill/*, meta/*, knowledge/*, and 60+ other endpoints) do not do this step -> user_id in CH is always empty.
 * knowledge/*, and 60+ other endpoints) do not do this step -> user_id in CH is always empty.
 *
 * ## Design
 * Centralized fallback at the middleware layer: `c.get('resolvedUserId') ?? resolver.get(userKey)`.
 * - **hit**: synchronously returns the cached user_id
 * - **miss**: returns undefined + fire-and-forget calls core `auth/verify` to fill the cache;
 *   the next request with the same user_key can hit
 * - **TTL**: 5 min (default); expired entries are lazily evicted + actively refreshed
 * - **Cap**: 5000 entries by default, LRU-ish; beyond the cap the oldest are dropped first
 * - **Zero blocking**: no path awaits the network -> instrumentation never affects the business
 *
 * ## Integration points
 * - constructed in `panel-deps.ts` and put into PanelDeps
 * - fallback call in `api-call-telemetry-middleware.ts`
 * - routes that already resolve, such as `chat-memory.ts` `/import`, hit directly via `c.set`,
 *   and may optionally call `warm(userKey, userId)` to warm up
 */
import type { MetaKernelPort } from '../kernel/ports/meta-kernel-port.js';
import type { MetaCallContext } from '../kernel/types.js';
import type { Logger } from './logger.js';

export interface PanelUserIdResolverOptions {
  ttlMs: number;
  maxSize: number;
}

const DEFAULT_OPTIONS: PanelUserIdResolverOptions = {
  ttlMs: 5 * 60 * 1000,
  maxSize: 5000,
};

interface CacheEntry {
  userId: string;
  expireAt: number;
}

/**
 * When the middleware uses it it **must provide ctx** (instanceId + gateway address, etc.) --
 * because auth/verify is a per-instance call, and the same user_key has
 * different semantics under different instances. The resolver uses `${instanceId}|${userKey}` as the cache key.
 */
export interface UserIdResolveCtx {
  instanceId: string;
  gatewayEndpoint: string;
  gatewayApiKey: string;
  reqId?: string;
}

export class PanelUserIdResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly refreshInFlight = new Set<string>();
  private readonly options: PanelUserIdResolverOptions;

  constructor(
    private readonly metaKernel: MetaKernelPort,
    private readonly logger: Logger,
    options: Partial<PanelUserIdResolverOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Synchronous lookup: returns user_id on a hit; on a miss returns undefined + asynchronous refresh.
   * Never throws, never blocks.
   */
  get(userKey: string, ctx: UserIdResolveCtx): string | undefined {
    if (!userKey) return undefined;
    const key = this.makeKey(ctx.instanceId, userKey);
    const entry = this.cache.get(key);
    if (entry && entry.expireAt > Date.now()) {
      return entry.userId;
    }
    // miss or expired -> fire-and-forget refresh
    this.scheduleRefresh(userKey, ctx);
    return undefined;
  }

  /**
   * Explicit warm-up: when a route has already called auth/verify and got the user_id,
   * put it in here to save one core call.
   */
  warm(userKey: string, userId: string, instanceId: string): void {
    if (!userKey || !userId) return;
    const key = this.makeKey(instanceId, userKey);
    this.putEntry(key, userId);
  }

  /** Actively evict (used in tests or when a user revokes a user_key). */
  invalidate(userKey: string, instanceId: string): void {
    this.cache.delete(this.makeKey(instanceId, userKey));
  }

  /** For tests: current cache size. */
  size(): number {
    return this.cache.size;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private makeKey(instanceId: string, userKey: string): string {
    return `${instanceId}|${userKey}`;
  }

  private scheduleRefresh(userKey: string, ctx: UserIdResolveCtx): void {
    const key = this.makeKey(ctx.instanceId, userKey);
    if (this.refreshInFlight.has(key)) return;
    this.refreshInFlight.add(key);
    void this.refresh(userKey, ctx, key);
  }

  private async refresh(
    userKey: string,
    ctx: UserIdResolveCtx,
    cacheKey: string,
  ): Promise<void> {
    try {
      const metaCtx: MetaCallContext = {
        instanceId: ctx.instanceId,
        gatewayEndpoint: ctx.gatewayEndpoint,
        gatewayApiKey: ctx.gatewayApiKey,
        userKey,
        reqId: ctx.reqId,
      };
      const env = await this.metaKernel.invoke(
        'auth/verify',
        { user_key: userKey },
        metaCtx,
      );
      if (env.code !== 0) return;
      const data = env.data as { valid?: boolean; user?: { user_id?: string } } | null;
      if (!data?.valid) return;
      const uid = data.user?.user_id;
      if (typeof uid !== 'string' || uid.length === 0) return;
      this.putEntry(cacheKey, uid);
    } catch (err) {
      // Do not throw or stop; instrumentation merely lacks user_id
      this.logger.debug('[user-id-resolver] refresh failed', {
        error: (err as Error).message,
      });
    } finally {
      this.refreshInFlight.delete(cacheKey);
    }
  }

  private putEntry(cacheKey: string, userId: string): void {
    // When over the cap, drop the oldest first (Map iteration order = insertion order)
    if (this.cache.size >= this.options.maxSize && !this.cache.has(cacheKey)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, {
      userId,
      expireAt: Date.now() + this.options.ttlMs,
    });
  }
}
