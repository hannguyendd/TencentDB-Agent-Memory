/**
 * useUsageStats -- cost-view data loading (4 usage/* items + usage-raw anomalies).
 *
 * Loaded separately from the metrics view (useAnalyticsMetrics): the cost section is in its own Tab, and requests are only sent once the user switches to
 * that Tab (enabled=true), avoiding 10+ CH queries on first paint.
 *
 * Scope: everything comes from kernel SQL aggregation/pagination and is **exact full-volume values**, with no panel-side sampling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyticsApi,
  USAGE_RAW_REASONS,
  type AnalyticsRangeDays,
  type UsageModelRow,
  type UsageRawReason,
  type UsageRawRow,
  type UsageSummary,
  type UsageTrendRow,
} from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';

export const USAGE_RAW_PAGE_SIZE = 20;

export type ReasonCounts = Record<UsageRawReason, number>;

const emptyReasonCounts = (): ReasonCounts => ({
  non_tokenhub: 0,
  unknown_model: 0,
  invalid_format: 0,
  invalid_credit: 0,
  report_failed: 0,
});

export function useUsageStats(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
}) {
  const { enabled, days, spaceId } = params;

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [series, setSeries] = useState<UsageTrendRow[]>([]);
  const [models, setModels] = useState<UsageModelRow[]>([]);

  const [rawRows, setRawRows] = useState<UsageRawRow[]>([]);
  const [rawTotal, setRawTotal] = useState(0);
  const [rawOffset, setRawOffset] = useState(0);
  const [rawReason, setRawReason] = useState<UsageRawReason | ''>('');
  const [reasonCounts, setReasonCounts] = useState<ReasonCounts>(emptyReasonCounts);

  const [loading, setLoading] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const seqRef = useRef(0);
  const rawSeqRef = useRef(0);
  const queryBody = useMemo(() => ({ days, space_id: spaceId }), [days, spaceId]);

  // Return to the first page when filters change, to avoid staying on an out-of-range offset
  useEffect(() => {
    setRawOffset(0);
  }, [days, spaceId, rawReason]);

  const loadAggregates = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError('');
    try {
      // reason tier counts: the kernel has no GROUP BY reason aggregation endpoint, so for each of the 5 enum values we fetch
      // a total (limit=1, no detail pull). This is necessary: non_tokenhub is "normal archiving of the
      // non-TokenHub channel" rather than an anomaly, and mixing it with real anomalies would make the total badly misleading.
      const [sum, ts, mds, ...counts] = await Promise.all([
        analyticsApi.usageSummary(queryBody),
        analyticsApi.usageTimeseries(queryBody),
        analyticsApi.usageByModel(queryBody),
        ...USAGE_RAW_REASONS.map((reason) =>
          analyticsApi.usageRawList({ ...queryBody, reason, offset: 0, limit: 1 }),
        ),
      ]);
      if (seq !== seqRef.current) return;
      setSummary(sum);
      setSeries(ts);
      setModels(mds);
      const nextCounts = emptyReasonCounts();
      USAGE_RAW_REASONS.forEach((reason, i) => {
        nextCounts[reason] = counts[i]?.total ?? 0;
      });
      setReasonCounts(nextCounts);
      setUpdatedAt(new Date());
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [queryBody]);

  const loadRaw = useCallback(async () => {
    const seq = ++rawSeqRef.current;
    setRawLoading(true);
    try {
      const res = await analyticsApi.usageRawList({
        ...queryBody,
        reason: rawReason || undefined,
        offset: rawOffset,
        limit: USAGE_RAW_PAGE_SIZE,
      });
      if (seq !== rawSeqRef.current) return;
      setRawRows(res.items);
      setRawTotal(res.total);
    } catch (err) {
      if (seq !== rawSeqRef.current) return;
      // A failed load of the anomaly report table should not mask the main aggregate data; show a separate notice
      setError(getErrorMessage(err));
      setRawRows([]);
    } finally {
      if (seq === rawSeqRef.current) setRawLoading(false);
    }
  }, [queryBody, rawReason, rawOffset]);

  useEffect(() => {
    if (!enabled) return;
    void loadAggregates();
  }, [enabled, loadAggregates]);

  useEffect(() => {
    if (!enabled) return;
    void loadRaw();
  }, [enabled, loadRaw]);

  const reload = useCallback(() => {
    void loadAggregates();
    void loadRaw();
  }, [loadAggregates, loadRaw]);

  return {
    summary,
    series,
    models,
    rawRows,
    rawTotal,
    rawOffset,
    rawReason,
    reasonCounts,
    rawLimit: USAGE_RAW_PAGE_SIZE,
    loading,
    rawLoading,
    error,
    updatedAt,
    setRawOffset,
    setRawReason,
    reload,
  };
}
