/**
 * useTeamParticipation -- fetch the participation log of the whole team, bucketed by task_id.
 */
import { useCallback, useEffect, useState } from 'react';
import { participationLogsApi } from '@/lib/teamApi';
import type { TaskParticipationView } from '../utils/workbench-utils';

/**
 * One request covers the statistics for the N tasks on the list page (avoiding N fanout requests),
 * and the detail page also reuses the same data, reading from the Map.
 *
 * - Data source: appended by the proxy side to the kernel `/v3/meta/participation-log/*` when session init completes
 * - On request failure it degrades to an empty Map, showing 0 / '—' everywhere, without blocking other areas
 * - Automatically re-fetches following BACKEND_REFRESH_EVENT
 */
export function useTeamParticipation(teamId: string | null): Map<string, TaskParticipationView> {
  const [byTask, setByTask] = useState<Map<string, TaskParticipationView>>(() => new Map());

  const fetchLogs = useCallback(async () => {
    if (!teamId) {
      setByTask(new Map());
      return;
    }
    try {
      const logs = await participationLogsApi.listByTeam(teamId);
      const buckets = new Map<string, { users: Set<string>; agentIds: Set<string> }>();
      for (const log of logs) {
        if (!log.task_id) continue;
        let bucket = buckets.get(log.task_id);
        if (!bucket) {
          bucket = { users: new Set(), agentIds: new Set() };
          buckets.set(log.task_id, bucket);
        }
        if (log.user_id) bucket.users.add(log.user_id);
        if (log.agent_id) bucket.agentIds.add(log.agent_id);
      }
      const next = new Map<string, TaskParticipationView>();
      for (const [taskId, { users, agentIds }] of buckets) {
        next.set(taskId, { users: [...users], agentIds: [...agentIds] });
      }
      setByTask(next);
    } catch (err) {
      console.warn('[TaskWorkbench] load participation logs failed:', err);
      setByTask(new Map());
    }
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;
    fetchLogs().catch(() => { /* handled inside */ });
    const handler = () => { if (!cancelled) fetchLogs(); };
    window.addEventListener('tdai-memory.backend-refresh', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('tdai-memory.backend-refresh', handler);
    };
  }, [fetchLogs]);

  return byTask;
}
