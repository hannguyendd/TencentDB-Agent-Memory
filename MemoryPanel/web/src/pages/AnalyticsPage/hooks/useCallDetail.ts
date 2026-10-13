/**
 * useCallDetail -- trace detail pagination and filtering.
 *
 * Uses the kernel `tool-calls/list` full pagination (not sampled). Filter dimensions supported by the kernel:
 * user_id (exact), bridge_source (exact), executed_endpoint (LIKE fuzzy).
 *
 * wiki / codegraph both belong to knowledge-service and cannot be distinguished by bridge_source alone,
 * so when the caller selects these two categories it switches to an endpoint keyword (tools/call/) + a panel-side category hint.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyticsApi,
  type AnalyticsRangeDays,
  type ToolCallRow,
} from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';

export const TRACE_PAGE_SIZE = 20;

export function useCallDetail(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
  userId: string | null;
  bridgeSource: string | undefined;
  endpointFilter: string;
}) {
  const { enabled, days, spaceId, userId, bridgeSource, endpointFilter } = params;

  const [rows, setRows] = useState<ToolCallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reqSeqRef = useRef(0);

  // Return to the first page when filters change, to avoid staying on an out-of-range offset showing an empty list
  useEffect(() => {
    setOffset(0);
  }, [days, spaceId, userId, bridgeSource, endpointFilter]);

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await analyticsApi.toolCallList({
        days,
        space_id: spaceId,
        kind: 'bridge_call',
        user_id: userId ?? undefined,
        bridge_source: bridgeSource,
        executed_endpoint: endpointFilter || undefined,
        offset,
        limit: TRACE_PAGE_SIZE,
      });
      if (seq !== reqSeqRef.current) return;
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setError(getErrorMessage(err));
      setRows([]);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [days, spaceId, userId, bridgeSource, endpointFilter, offset]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return {
    rows,
    total,
    offset,
    limit: TRACE_PAGE_SIZE,
    loading,
    error,
    setOffset,
    reload: load,
  };
}
