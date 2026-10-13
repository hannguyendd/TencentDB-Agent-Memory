/**
 * Member-dimension aggregation -- panel-side merge of call details by user_id.
 *
 * Why do it panel-side: the kernel provides no "aggregate by member" display endpoint
 * (`tool-calls/watermark` does GROUP BY user_id, but its return is a fingerprint structure for the recall incremental pipeline,
 * and lacks endpoint/latency, so it is unsuitable for display); Core is not changed in this iteration.
 *
 * Warning: **sampled scope**: data is pulled by paging `tool-calls/list`, with a page limit of 200 and at most
 * MAX_SAMPLE_PAGES pages. When total exceeds the sample size, truncated=true, and the UI must explicitly label
 * "based on the latest N / total records"; it must not be treated as a full-volume scope.
 */
import { classifyAsset, type AssetCategory } from './asset-category';
import type { ToolCallRow } from '@/lib/api/analytics';

/** Maximum sampled pages (200/page -> up to 2000 records). */
export const MAX_SAMPLE_PAGES = 10;

export interface MemberStat {
  user_id: string;
  /** Number of calls within the sampling window. */
  calls: number;
  /** Number of distinct sessions. */
  sessions: number;
  /** The asset category this member called most. */
  topCategory: AssetCategory | null;
  /** Call count per category. */
  byCategory: Record<AssetCategory, number>;
  /** Average latency (ms). */
  avgElapsedMs: number;
  /** Failure count (upstream_status >= 400 or reject_reason non-empty). */
  errors: number;
  /** Time of the most recent call within the sampling window. */
  lastCallAt: string;
}

function emptyByCategory(): Record<AssetCategory, number> {
  return { memory: 0, skill: 0, wiki: 0, codegraph: 0, other: 0 };
}

/**
 * Aggregate bucket label for an empty user_id.
 *
 * Warning: this is **not** a real user_id, only a panel-side placeholder group:
 *   - cannot be used for user/list name resolution (it would waste a user_ids quota slot and not be found)
 *   - cannot be used for drill-down (passing it to the kernel as a user_id is semantically wrong)
 * Callers must explicitly recognize and skip it, and show the i18n "Unassigned" in the UI.
 */
export const UNASSIGNED_USER = '(unassigned)';

/**
 * Aggregate call details by user_id, returned in descending order of call count.
 *
 * Rows with an empty user_id go into the `UNASSIGNED_USER` bucket: such events do exist in CH
 * (the reporting side carried no user context), and silently dropping them would make the total disagree with the KPI.
 */
export function aggregateByMember(rows: ToolCallRow[]): MemberStat[] {
  const map = new Map<
    string,
    MemberStat & { sessionSet: Set<string>; elapsedSum: number; elapsedCount: number }
  >();

  for (const row of rows) {
    const key = row.user_id || UNASSIGNED_USER;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        user_id: key,
        calls: 0,
        sessions: 0,
        topCategory: null,
        byCategory: emptyByCategory(),
        avgElapsedMs: 0,
        errors: 0,
        lastCallAt: '',
        sessionSet: new Set<string>(),
        elapsedSum: 0,
        elapsedCount: 0,
      };
      map.set(key, entry);
    }

    entry.calls += 1;
    if (row.session_key) entry.sessionSet.add(row.session_key);

    const category = classifyAsset(row.executed_endpoint, row.bridge_source);
    entry.byCategory[category] += 1;

    // elapsed_ms of 0 is mostly unrecorded; exclude it from the average's denominator, to avoid diluting the average latency to 0
    if (row.elapsed_ms > 0) {
      entry.elapsedSum += row.elapsed_ms;
      entry.elapsedCount += 1;
    }

    if (row.upstream_status >= 400 || row.reject_reason) entry.errors += 1;
    if (row.timestamp > entry.lastCallAt) entry.lastCallAt = row.timestamp;
  }

  return Array.from(map.values())
    .map((e) => {
      const entries = Object.entries(e.byCategory) as Array<[AssetCategory, number]>;
      const top = entries.reduce<[AssetCategory, number] | null>(
        (acc, cur) => (cur[1] > 0 && (!acc || cur[1] > acc[1]) ? cur : acc),
        null,
      );
      return {
        user_id: e.user_id,
        calls: e.calls,
        sessions: e.sessionSet.size,
        topCategory: top ? top[0] : null,
        byCategory: e.byCategory,
        avgElapsedMs: e.elapsedCount > 0 ? Math.round(e.elapsedSum / e.elapsedCount) : 0,
        errors: e.errors,
        lastCallAt: e.lastCallAt,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.user_id.localeCompare(b.user_id));
}
