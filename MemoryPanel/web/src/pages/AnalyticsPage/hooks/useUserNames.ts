/**
 * useUserNames -- batch resolution of user_id -> username.
 *
 * Why not use `useDisplayNameResolver` directly: during render it issues a separate
 * `user/get` for every missed id (distinct_users on this page measured 29, and the trace / usage / raw tables all carry
 * user_id), producing dozens of concurrent requests. Here a single `user/list({ user_ids })` batch fetch is used instead.
 *
 * Contract constraints (checked against the kernel `v3-meta-schemas.ts:userListSchema`):
 *   - `user_ids` is capped at **100**; exceeding it returns 400 -> so batch by 100
 *   - Omitting `team_id` requires the caller to be system_admin (see metadata-service
 *     `listUsersForCaller`: non-system_admin throws missing_team_id). The observability page itself is
 *     admin-only, so the condition is met
 *   - The Panel proxy layer applies the hideKnowledgeServiceUser filter to `user/list`, so internal billing
 *     accounts are not found -> fall back to showing the raw id (expected behavior, not treated as an error)
 *
 * Resolved results are fed back into `seedDisplayNameCache`, so other pages share the same cache.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usersApi } from '@/lib/api/users';
import { seedDisplayNameCache } from '@/services/user-profile-store';

/** The user_ids cap of the kernel userListSchema. */
const USER_IDS_BATCH_MAX = 100;

export function useUserNames(userIds: Array<string | null | undefined>): (id: string) => string {
  const [names, setNames] = useState<Record<string, string>>({});
  // ids already requested (including failed resolutions), to avoid repeatedly retrying ids that cannot be found
  const attemptedRef = useRef(new Set<string>());

  // Use content rather than the array reference as the dependency, otherwise every render re-triggers the fetch
  const pendingKey = useMemo(() => {
    const unique = new Set<string>();
    for (const id of userIds) {
      if (id && !names[id] && !attemptedRef.current.has(id)) unique.add(id);
    }
    return [...unique].sort().join(',');
  }, [userIds, names]);

  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(',').filter(Boolean);
    ids.forEach((id) => attemptedRef.current.add(id));

    let cancelled = false;
    void (async () => {
      try {
        for (let i = 0; i < ids.length; i += USER_IDS_BATCH_MAX) {
          const batch = ids.slice(i, i + USER_IDS_BATCH_MAX);
          const users = await usersApi.list({ user_ids: batch });
          if (cancelled) return;

          const resolved: Record<string, string> = {};
          for (const u of users) {
            const name = u.display_name || u.username;
            if (name) resolved[u.user_id] = name;
          }
          if (Object.keys(resolved).length > 0) {
            setNames((prev) => ({ ...prev, ...resolved }));
            seedDisplayNameCache(
              Object.entries(resolved).map(([user_id, username]) => ({ user_id, username })),
            );
          }
        }
      } catch {
        // Fail silently: ids that cannot be resolved fall back to the raw value, without blocking the dashboard
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pendingKey]);

  return useCallback((id: string) => (id ? (names[id] ?? id) : ''), [names]);
}
