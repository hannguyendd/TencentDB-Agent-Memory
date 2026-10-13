/**
 * useUsageList -- per-request usage detail pagination (usage/list).
 *
 * Used by the drill-down drawer: exact filtering by model_id or user_id (the two dimensions the kernel supports).
 * enabled is controlled by drawer visibility + the current Tab; closing the drawer stops requests.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyticsApi,
  type AnalyticsRangeDays,
  type UsageLogRow,
} from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';

export const USAGE_LIST_PAGE_SIZE = 20;

export function useUsageList(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
  userId?: string;
  modelId?: string;
}) {
  const { enabled, days, spaceId, userId, modelId } = params;

  const [rows, setRows] = useState<UsageLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const seqRef = useRef(0);

  // Return to the first page when filters change, to avoid staying on an out-of-range offset
  useEffect(() => {
    setOffset(0);
  }, [days, spaceId, userId, modelId]);

  const query = useMemo(
    () => ({
      days,
      space_id: spaceId,
      user_id: userId || undefined,
      model_id: modelId || undefined,
    }),
    [days, spaceId, userId, modelId],
  );

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await analyticsApi.usageList({
        ...query,
        offset,
        limit: USAGE_LIST_PAGE_SIZE,
      });
      if (seq !== seqRef.current) return;
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(getErrorMessage(err));
      setRows([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [query, offset]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return {
    rows,
    total,
    offset,
    limit: USAGE_LIST_PAGE_SIZE,
    loading,
    error,
    setOffset,
    reload: load,
  };
}
