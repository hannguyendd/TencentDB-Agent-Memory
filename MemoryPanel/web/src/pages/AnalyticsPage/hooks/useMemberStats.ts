/**
 * useMemberStats -- member-dimension aggregation (panel-side sampling).
 *
 * The kernel has no "aggregate by member" display endpoint and Core is not changed in this iteration, so `tool-calls/list` is paged and
 * sampled, then GROUP BY user_id is done panel-side. truncated=true means the sample does not cover the full volume,
 * and the UI must label the scope.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { analyticsApi, type AnalyticsRangeDays } from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';
import { aggregateByMember, MAX_SAMPLE_PAGES, type MemberStat } from '../utils/member-stats';

export function useMemberStats(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
}) {
  const { enabled, days, spaceId } = params;

  const [members, setMembers] = useState<MemberStat[]>([]);
  const [sampled, setSampled] = useState(0);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reqSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await analyticsApi.toolCallSample(
        { days, space_id: spaceId },
        MAX_SAMPLE_PAGES,
      );
      if (seq !== reqSeqRef.current) return;
      setMembers(aggregateByMember(res.rows));
      setSampled(res.rows.length);
      setTotal(res.total);
      setTruncated(res.truncated);
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setError(getErrorMessage(err));
      setMembers([]);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [days, spaceId]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return { members, sampled, total, truncated, loading, error, reload: load };
}
