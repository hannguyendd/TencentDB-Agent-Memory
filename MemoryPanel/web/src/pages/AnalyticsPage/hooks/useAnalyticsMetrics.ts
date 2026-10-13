/**
 * useAnalyticsMetrics -- metrics-view data loading (CH probe + Space list + 5 metrics).
 *
 * Data flow constraint (do not change back to "probe config again inside load"):
 *   config is probed only once -> reduced to a chReady boolean -> the boolean drives data loading.
 *   Calling setConfig inside load would form a self-triggering loop with an effect that depends on the config object
 *   (each fetch returns a new reference -> effect re-runs -> setConfig again), causing infinite requests.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyticsApi,
  type AnalyticsRangeDays,
  type BypassReasonRow,
  type EndpointShareRow,
  type SessionInitSummary,
  type SessionTrendRow,
} from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';

export type ChState = 'probing' | 'ready' | 'not-configured' | 'unreachable' | 'probe-failed';

export const REFRESH_INTERVAL_MS = 60_000;

export function useAnalyticsMetrics(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
}) {
  const { enabled, days, spaceId } = params;

  const [chState, setChState] = useState<ChState>('probing');

  const [summary, setSummary] = useState<SessionInitSummary | null>(null);
  const [series, setSeries] = useState<SessionTrendRow[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointShareRow[]>([]);
  const [reasons, setReasons] = useState<BypassReasonRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const reqSeqRef = useRef(0);
  const chReady = chState === 'ready';
  const queryBody = useMemo(() => ({ days, space_id: spaceId }), [days, spaceId]);

  // CH config probe (once only)
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    void (async () => {
      try {
        const cfg = await analyticsApi.config();
        if (!alive) return;
        if (!cfg.configured) setChState('not-configured');
        else if (!cfg.reachable) setChState('unreachable');
        else setChState('ready');
      } catch (err) {
        if (!alive) return;
        setChState('probe-failed');
        setError(getErrorMessage(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);

  // Note: the full /analytics/spaces list is no longer fetched -- Space is fixed to the currently logged-in instance
  // (page data is isolated per instance); the full list would bring back space_ids of other instances in the shared CH,
  // which is useless and violates the isolation semantics.

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const [sum, ts, eps, rsns] = await Promise.all([
        analyticsApi.sessionSummary(queryBody),
        analyticsApi.sessionTimeseries(queryBody),
        analyticsApi.endpointShare(queryBody),
        analyticsApi.bypassReasons(queryBody),
      ]);
      if (seq !== reqSeqRef.current) return;
      setSummary(sum);
      setSeries(ts);
      setEndpoints(eps);
      setReasons(rsns);
      setUpdatedAt(new Date());
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [queryBody]);

  useEffect(() => {
    if (!chReady) return;
    void load();
  }, [chReady, load]);

  useEffect(() => {
    if (!chReady) return undefined;
    const timer = window.setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [chReady, load]);

  return {
    chState,
    chReady,
    summary,
    series,
    endpoints,
    reasons,
    loading,
    error,
    updatedAt,
    reload: load,
  };
}
