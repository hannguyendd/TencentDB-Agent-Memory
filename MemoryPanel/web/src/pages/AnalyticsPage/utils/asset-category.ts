/**
 * Endpoint / bridge_source -> four asset categories (Memory / Skill / Wiki / Code Graph) classification.
 *
 * Why do it panel-side: CH's `tool_call_logs` only records `executed_endpoint` and
 * `bridge_source`, and the kernel `tool-calls/endpoint-share` aggregates by raw endpoint (17 flat items),
 * lacking business semantics. Core is not changed in this iteration, so the classification rules live panel-side -- like the old panel
 * (online-data-platform `trace-context.ts:normalizeCategory`), it is pure string
 * matching and involves no LLM.
 *
 * Decision priority:
 *   1. bridge_source (most authoritative): memory-bridge / skill-bridge / knowledge-service
 *   2. endpoint prefix / endpoint name (the only basis when endpoint-share has only endpoint names)
 *   3. fallback other -- new endpoints are not misclassified when they go live, but are explicitly exposed as "Other"
 *
 * If a new endpoint falls into other, add a rule here instead of letting it silently blend into some category.
 */

export type AssetCategory = 'memory' | 'skill' | 'wiki' | 'codegraph' | 'other';

export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  'memory',
  'skill',
  'wiki',
  'codegraph',
  'other',
] as const;

/** knowledge-service further splits into Wiki / Code Graph by endpoint internally. */
const CODEGRAPH_TOOLS = ['node', 'impact', 'files', 'refs', 'callers', 'callees', 'graph'];
const WIKI_TOOLS = ['search', 'explore', 'read_page', 'list_pages', 'get_info', 'page'];

/** Memory-side endpoints (including the scenario / atomic / conversation groups). */
const MEMORY_PREFIXES = ['atomic/', 'scenario/', 'conversation/', 'persona', 'chat-memory'];

/** Skill-side endpoints. */
const SKILL_EXACT = ['get', 'get-by-name', 'search', 'list', 'listing', 'extract', 'versions', 'fork'];
const SKILL_PREFIXES = ['files/', 'skill/'];

function classifyKnowledgeTool(endpoint: string): AssetCategory {
  // Of the form tools/call/<tool>; take the last segment to decide
  const tool = endpoint.split('/').pop() ?? '';
  if (CODEGRAPH_TOOLS.some((t) => tool.includes(t))) return 'codegraph';
  if (WIKI_TOOLS.some((t) => tool.includes(t))) return 'wiki';
  return 'wiki';
}

/**
 * Classify a single call.
 *
 * @param endpoint executed_endpoint (required, the only basis in the endpoint-share scenario)
 * @param bridgeSource bridge_source (optional, available in the tool-calls/list scenario, highest priority)
 */
export function classifyAsset(endpoint: string, bridgeSource?: string): AssetCategory {
  const src = (bridgeSource ?? '').toLowerCase();
  const ep = (endpoint ?? '').toLowerCase();

  // 1. bridge_source first
  if (src.startsWith('memory')) return 'memory';
  if (src.startsWith('skill')) return 'skill';
  if (src.startsWith('knowledge')) return classifyKnowledgeTool(ep);

  if (!ep) return 'other';

  // 2. Endpoint decision
  if (ep.startsWith('tools/call/')) return classifyKnowledgeTool(ep);
  if (MEMORY_PREFIXES.some((p) => ep.startsWith(p))) return 'memory';
  if (SKILL_PREFIXES.some((p) => ep.startsWith(p))) return 'skill';
  if (SKILL_EXACT.includes(ep)) return 'skill';

  // 3. Fallback: don't guess
  return 'other';
}

export interface CategoryStat {
  category: AssetCategory;
  calls: number;
  pct: number;
  /** Raw endpoints grouped into this category (sorted by call count descending), shown in the tooltip as the classification basis. */
  endpoints: Array<{ endpoint: string; calls: number }>;
}

/**
 * Merge the full aggregate result of endpoint-share into four categories.
 *
 * Input comes from the kernel's full SQL aggregation, so the output calls/pct are likewise **exact full-volume values**,
 * not samples (unlike the member dimension). pct is recomputed from the total calls of the input rows, to avoid
 * rounding drift from summing the raw pct values directly.
 */
export function aggregateByCategory(
  rows: Array<{ executed_endpoint: string; calls: number }>,
): CategoryStat[] {
  const buckets = new Map<AssetCategory, { calls: number; endpoints: Array<{ endpoint: string; calls: number }> }>();
  let total = 0;

  for (const row of rows) {
    const category = classifyAsset(row.executed_endpoint);
    const calls = Number(row.calls) || 0;
    total += calls;
    const bucket = buckets.get(category) ?? { calls: 0, endpoints: [] };
    bucket.calls += calls;
    bucket.endpoints.push({ endpoint: row.executed_endpoint, calls });
    buckets.set(category, bucket);
  }

  return ASSET_CATEGORIES.map((category) => {
    const bucket = buckets.get(category);
    return {
      category,
      calls: bucket?.calls ?? 0,
      pct: total > 0 ? Math.round(((bucket?.calls ?? 0) / total) * 10000) / 100 : 0,
      endpoints: (bucket?.endpoints ?? []).sort((a, b) => b.calls - a.calls),
    };
  })
    // An other bucket that is all zeros is not shown to avoid noise; the four main asset categories are always shown (0 is meaningful too)
    .filter((s) => s.category !== 'other' || s.calls > 0);
}
