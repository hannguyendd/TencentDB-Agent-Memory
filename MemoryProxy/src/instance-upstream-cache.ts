/**
 * Instance Upstream Config Cache — per-instance model-group config
 * fetched from Core `/v3/internal/meta/instance-upstream/list` (interface D).
 *
 * Rewritten to v2 (model groups). See
 * docs/design/2026-08-25-instance-upstream-config.md §5 / §7.
 *
 * Cache semantics (same as v1, only the data structure changes):
 *   - Key: spaceId (one entry per instance, covering all groups + extraction)
 *   - TTL: determined by config.instanceUpstream.cacheTtlSec (seconds, default 30),
 *          hard expiry, no refresh-on-access
 *   - Stale-if-error: on fetch failure, return last known good value
 *   - First-time failure: return empty array (= triggers the resolveForAgent zero-row fallback,
 *     treated as official, everything goes through the global upstream + alias, same as the old behavior)
 *   - Max entries: 256, evict oldest-written on overflow
 *
 * ## v1 → v2 API migration
 *
 * The old interface `resolveUpstreamConfig(items, agentSource, type)` is split into two:
 *   - `resolveForAgent(items, agentSource)` → 4-state resolution for conversation requests (override/official/blocked/unmanaged)
 *   - `resolveExtraction(items)` → extraction requests (returns null to mean "use global", never produces blocked)
 *
 * `shouldOverride` is retained; it returns true only for kind=override or a non-null extraction result; the alias-skip gate uniformly goes through it.
 */

import type { CoreSkillConfig, InstanceUpstreamConfig } from "./types.js";

const TAG = "[instance-upstream-cache]";
const FALLBACK_TTL_SEC = 30; // default 30 seconds
const MAX_ENTRIES = 256;

/**
 * Normalize TTL (seconds → milliseconds). Only positive integers are accepted; invalid/negative/zero/NaN/fractional/undefined all fall back to the default 30s
 * + one warn line, ensuring the "100% backward compatible when unconfigured by default" red line ([[default-no-config-backward-compat]]).
 * Normalized once on every handler call; the overhead is negligible.
 */
function normalizeTtlMs(rawSec: number | undefined): number {
  if (rawSec === undefined) return FALLBACK_TTL_SEC * 1000;
  if (!Number.isFinite(rawSec) || !Number.isInteger(rawSec) || rawSec <= 0) {
    console.warn(`${TAG} instanceUpstream.cacheTtlSec=${rawSec} is invalid, falling back to default ${FALLBACK_TTL_SEC}s`);
    return FALLBACK_TTL_SEC * 1000;
  }
  return rawSec * 1000;
}

// ── Types (v2 model group) ────────────────────────────────────────────────

export type GroupType = "default" | "custom" | "extraction";
export type UpstreamMode = "official" | "custom_unified" | "custom_passthrough";

/** Each row returned by Core interface D (note api_key is plaintext, only because this is an internal interface). */
export interface InstanceUpstreamRow {
  group_id: string;
  group_type: GroupType;
  name: string;
  agents: string[];
  enabled: boolean;
  mode: UpstreamMode;
  base_url: string;
  api_key: string;      // Plaintext obtained from the internal interface, for the Proxy to forward upstream
  model_id: string;
  // ── Extra fields Core actually returns ────────────────────────────────────
  // The Proxy itself does not consume them, but the real API response has them and test mocks fill them too; leaving them out of the type
  // would make any test that builds data from the real response fail with TS2353.
  /** DB row primary key, not consumed by callers */
  id?: number;
  /** Description text of the group, not consumed by callers */
  description?: string;
  /** Version number, used for CAS updates, not consumed by the Proxy */
  version?: number;
  /** Snapshot of the full set of agents the group supported at the time (lets the Panel see which agents an old group applies to) */
  supported_agents_snapshot?: string[];
  created_at?: string;
  updated_at?: string;
}

/**
 * resolveForAgent 4-state return:
 *   - override:  matches custom.agents and enabled → forward using that row's config
 *   - official:  matches default.agents and enabled (or the zero-row fallback when items is empty) → go through the global upstream + alias
 *   - blocked:   hits a default/custom group but enabled=false → deny service (UPSTREAM_DISABLED 400)
 *   - unmanaged: agent is in neither default nor any custom → deny service (AGENT_NOT_CONFIGURED 400)
 */
export type Resolution =
  | { kind: "override"; row: InstanceUpstreamRow }
  | { kind: "official"; row: InstanceUpstreamRow | null }
  | { kind: "blocked"; reason: "default_disabled" | "custom_disabled"; group_id: string }
  | { kind: "unmanaged"; agent: string };

interface CacheEntry {
  items: InstanceUpstreamRow[];
  expiresAt: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();
const lastGood = new Map<string, InstanceUpstreamRow[]>();

// ── Fetch from Core ──────────────────────────────────────────────────────────

async function fetchFromCore(
  config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  spaceId: string,
): Promise<InstanceUpstreamRow[]> {
  const url = `${config.endpoint.replace(/\/$/, "")}/v3/internal/meta/instance-upstream/list`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.serviceToken}`,
      "x-tdai-service-id": spaceId,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(config.timeoutMs || 3000),
  });

  if (!resp.ok) {
    throw new Error(`${TAG} HTTP ${resp.status} from ${url}`);
  }

  const env = await resp.json() as { code?: number; data?: { items?: InstanceUpstreamRow[] } };
  if (env.code !== 0) {
    throw new Error(`${TAG} envelope error code=${env.code}`);
  }
  return env.data?.items ?? [];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all upstream config rows for an instance (cached, TTL determined by config, stale-if-error).
 *
 * Returns empty array when:
 *   - Instance has no config AND Core seed not yet triggered (extreme timing)
 *   - Core unreachable AND no prior cached value
 *
 * An empty array is treated by resolveForAgent as the "zero-row fallback", going official + global upstream + alias
 * (fully identical to v1 behavior, ensuring business does not break when the config system is down).
 *
 * Parameters are split in two:
 *   - `skillConfig` provides the D interface's endpoint / serviceToken / timeoutMs (shares the core gateway)
 *   - `cacheConfig` provides the cache TTL; the whole block may be omitted (test friendly) / fields may be missing (default 30s)
 */
export async function getInstanceUpstreamConfigs(
  skillConfig: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  spaceId: string,
  cacheConfig?: Partial<InstanceUpstreamConfig>,
): Promise<InstanceUpstreamRow[]> {
  if (!spaceId) return [];

  // Check cache (TTL-based, not LRU — access does NOT refresh expiry)
  const cached = cache.get(spaceId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.items;
  }

  // Cache miss or expired → fetch from Core
  let fresh: InstanceUpstreamRow[] | null = null;
  let fetchErr: unknown = null;
  try {
    fresh = await fetchFromCore(skillConfig, spaceId);
  } catch (err) {
    fetchErr = err;
  }

  if (fresh !== null) {
    // Success → write cache + lastGood
    evictIfNeeded();
    const ttlMs = normalizeTtlMs(cacheConfig?.cacheTtlSec);
    cache.set(spaceId, { items: fresh, expiresAt: Date.now() + ttlMs });
    lastGood.set(spaceId, fresh);
    return fresh;
  }

  // Fetch failed → stale-if-error fallback
  const stale = lastGood.get(spaceId);
  if (stale !== undefined) {
    const reason = fetchErr instanceof Error ? fetchErr.message : "unknown";
    console.warn(`${TAG} stale-if-error for spaceId=${spaceId} (reason: ${reason})`);
    return stale;
  }

  // First-time failure, no history → return empty (= resolveForAgent zero-row fallback = official)
  if (fetchErr) {
    console.warn(
      `${TAG} fetch failed for spaceId=${spaceId}, no stale fallback: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
    );
  }
  return [];
}

/**
 * Conversation request resolution: input an items array + agent, output a 4-state Resolution.
 *
 * See §7.3. **Key point**: when items is an empty array it returns `{kind:"official", row:null}`,
 * and the handler always treats row=null as "go through the global upstream + alias" -- this is a direct embodiment of the
 * "backward compatibility" red line ([[default-no-config-backward-compat]]): when Core is down / seed fails /
 * the stale cache misses the first time, business behavior equals v1 and this feature will not cause a 500.
 */
export function resolveForAgent(
  items: InstanceUpstreamRow[],
  agentSource: string,
): Resolution {
  // Only care about the group rows used by conversation (default + custom); ignore extraction rows
  const convRows = items.filter(
    (r) => r.group_type === "default" || r.group_type === "custom",
  );

  // 0. Zero-row fallback: protected by the backward-compat red line
  if (convRows.length === 0) {
    return { kind: "official", row: null };
  }

  // 1. Find the custom group that explicitly covers this agent
  const custom = convRows.find(
    (r) => r.group_type === "custom" && r.agents.includes(agentSource),
  );
  if (custom) {
    if (!custom.enabled) {
      return { kind: "blocked", reason: "custom_disabled", group_id: custom.group_id };
    }
    return { kind: "override", row: custom };
  }

  // 2. Find the default group that explicitly covers this agent
  const def = convRows.find(
    (r) => r.group_type === "default" && r.agents.includes(agentSource),
  );
  if (def) {
    if (!def.enabled) {
      return { kind: "blocked", reason: "default_disabled", group_id: def.group_id };
    }
    return { kind: "official", row: def };
  }

  // 3. Agent is not in any group's agents list → unmanaged (the admin deliberately gives it no upstream)
  return { kind: "unmanaged", agent: agentSource };
}

/**
 * Extraction request resolution: dedicated to systemUser requests.
 *
 * All three cases return null (gracefully fall back to the global upstream + alias, never block):
 *   1. Not configured: no extraction row exists
 *   2. Configured but disabled: enabled=false
 *   3. Incomplete config (write validation should in theory catch this): base_url is an empty string
 *
 * **Explicitly distinct** from the disabled semantics of default/custom groups -- extraction is system behavior and must not deny service.
 */
export function resolveExtraction(
  items: InstanceUpstreamRow[],
): InstanceUpstreamRow | null {
  const ext = items.find((r) => r.group_type === "extraction");
  if (!ext || !ext.enabled || !ext.base_url) return null;
  return ext;
}

/**
 * Decide whether this resolution is a "user-defined upstream" (needs alias translation skipped + no credit reporting).
 *
 * Used by the handler's alias-skip gate (§7.5, following the caller-dispatch of 1b33b03f):
 *   - Conversation requests: pass in the result of resolveForAgent; only kind=override returns true
 *   - Extraction requests: pass in the result of resolveExtraction; only non-null returns true (equivalent to "configured + enabled + base_url non-empty")
 */
export function shouldOverride(
  x: Resolution | InstanceUpstreamRow | null,
): x is InstanceUpstreamRow | Extract<Resolution, { kind: "override" }> {
  if (x === null) return false;
  if ("kind" in x) return x.kind === "override";
  // Already a row (the return of resolveExtraction)
  return true;
}

// ── Internals ────────────────────────────────────────────────────────────────

function evictIfNeeded(): void {
  if (cache.size < MAX_ENTRIES) return;
  // Evict oldest-written entry (first key in insertion-order Map)
  const oldestKey = cache.keys().next().value as string | undefined;
  if (oldestKey) {
    cache.delete(oldestKey);
    // Keep lastGood for stale-if-error — only remove from TTL cache
  }
}

/** Clear all cache (for testing). */
export function clearCache(): void {
  cache.clear();
  lastGood.clear();
}

/**
 * Test only: write items directly into the cache so the handler hits override / extraction scenarios
 * without spinning up a real Core mock. ttlMs defaults to 60s, enough for a unit test's lifetime.
 */
export function __primeCacheForTests(spaceId: string, items: InstanceUpstreamRow[], ttlMs = 60_000): void {
  cache.set(spaceId, { items, expiresAt: Date.now() + ttlMs });
  lastGood.set(spaceId, items);
}
