/**
 * stores/backend.ts -- global backend data store (zustand).
 *
 * Replaces the module-level variables in backendStore.ts (_cachedTeams / _cachedAgentsMap / _inflightTeams ...).
 *
 * Core design:
 *   - teamsLoaded / agentsLoadedTeamIds: mark "already loaded",
 *     so that every component mount doesn't fetch again.
 *   - invalidate(): called after write operations, clears all caches + broadcasts BACKEND_REFRESH_EVENT.
 *   - invalidateTeam(teamId): on team switch, clears only the current team's agents/tasks cache.
 *   - useTeams / useAgents / useTasks: read data from the store + trigger fetches, with multiple components sharing the same state.
 */

import { create } from 'zustand';
import { useEffect, useState } from 'react';
import {
  teamsApi,
  membersApi,
  agentsApi,
  tasksApi,
  type TeamMember as BackendMember,
} from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import i18n from '@/i18n';
import { seedDisplayNameCache } from '@/services/user-profile-store';

// Re-import pure functions (adapters / types) from backendStore.ts, to avoid circular dependencies
import {
  type Team,
  type Agent,
  type Task,
  adaptTeam,
  adaptMember,
  adaptAgent,
  adaptTask,
  readActiveTeamId,
  writeActiveTeamId,
  ensureValidActiveTeamId,
} from '@/services/backendStore';

// ========================= Event constants =========================

const BACKEND_REFRESH_EVENT = 'tdai-memory.backend-refresh';
const LOCAL_CHANGE_EVENT = 'tdai-memory.demo-store-change';

function emitBackendRefresh() {
  try { window.dispatchEvent(new Event(BACKEND_REFRESH_EVENT)); } catch { /* ignore */ }
}

// ========================= Store types =========================

interface BackendState {
  // Data
  teams: Team[];
  activeTeamId: string | null;
  agentsByTeam: Record<string, Agent[]>;
  // Full total (the total returned by the kernel), based on which the frontend computes the total page count
  tasksTotalByTeam: Record<string, number>;
  // Backend pagination cache: tasksPagesByTeam[teamId]["offset:limit"] = Task[]
  tasksPagesByTeam: Record<string, Record<string, Task[]>>;
  // loaded flags (avoid repeated fetches)
  teamsLoaded: boolean;
  teamsLoading: boolean;
  agentsLoadedTeamIds: Set<string>;
  // in-flight dedupe
  inflightTeams: Promise<void> | null;
  inflightAgents: Record<string, Promise<Agent[]>>;
  inflightTasks: Record<string, Promise<Task[]> | undefined>;
  /**
   * Epoch counter: incremented on clearAll (logout / 401) / invalidate.
   * refreshTeams / fetchAgents / fetchTasks capture the current epoch when initiated, and after the await returns,
   * if the epoch has changed (meaning a logout/cache clear happened in between), the result is discarded -- preventing the in-flight requests of the old session
   * from writing the previous user's teams/agents/tasks back into the store after completing, or writing the old team
   * back to the localStorage activeTeamId, causing a new user to briefly/persistently see old data after logging in.
   */
  epoch: number;

  // actions
  fetchTeams: () => Promise<void>;
  /**
   * Force re-fetching the team list (ignoring the teamsLoaded cache, keeping in-flight dedupe).
   * With `silent: true` teamsLoading is not flipped at the UI layer -- for background keep-fresh
   * scenarios such as dropdown expansion, avoiding consumers like TeamManagementPanel entering
   * a full loading placeholder because teamsLoading=true (manifesting as "click the dropdown once and the page refreshes").
   */
  refreshTeams: (opts?: { silent?: boolean }) => Promise<void>;
  fetchAgents: (teamId: string) => Promise<Agent[]>;
  fetchTasks: (teamId: string, params?: { limit?: number; offset?: number; force?: boolean }) => Promise<Task[]>;
  setActiveTeamId: (teamId: string | null) => void;
  invalidate: () => void;
  invalidateTeam: (teamId: string) => void;
  clearAll: () => void;
}

// ========================= Store implementation =========================

export const useBackendStore = create<BackendState>((set, get) => ({
  teams: [],
  activeTeamId: readActiveTeamId(),
  agentsByTeam: {},
  tasksTotalByTeam: {},
  tasksPagesByTeam: {},
  teamsLoaded: false,
  teamsLoading: false,
  agentsLoadedTeamIds: new Set(),
  inflightTeams: null,
  inflightAgents: {},
  inflightTasks: {},
  epoch: 0,

  fetchTeams: async () => {
    const state = get();
    // Already loaded -> don't fetch again (only re-fetched after invalidate / clearAll)
    if (state.teamsLoaded) return;
    await get().refreshTeams();
  },

  refreshTeams: async (opts?: { silent?: boolean }) => {
    const state = get();
    // in-flight dedupe: when multiple components mount at the same time only one request is sent
    if (state.inflightTeams) { await state.inflightTeams; return; }

    const silent = opts?.silent === true;
    // Capture the epoch at initiation: if a logout/cache clear happens in between (epoch incremented), this result must be discarded
    const epoch = state.epoch;
    const promise = (async () => {
      // A silent refresh does not flip teamsLoading -- consumers (TeamManagementPanel etc.) rely on it
      // to show a loading placeholder; flipping it in background keep-fresh scenarios like dropdown expansion would cause
      // "click the dropdown once and the whole page flashes to loading and then recovers".
      if (!silent) set({ teamsLoading: true });
      try {
        const backendTeams = await teamsApi.list();
        // Fetch members in batch (N+1 -> N, but this is a backend API limitation, there is no batch endpoint)
        const memberResults = await Promise.all(
          backendTeams.map((t) => membersApi.list(t.team_id).catch(() => [] as BackendMember[]))
        );
        // Old-session results returned after a logout/cache clear: discard, preventing old teams from being written back to the store,
        // and preventing ensureValidActiveTeamId from writing the old team back to the localStorage activeTeamId.
        if (get().epoch !== epoch) return;
        const adapted = backendTeams.map((bt, i) =>
          adaptTeam(bt, memberResults[i].map(adaptMember))
        );
        seedDisplayNameCache(adapted.flatMap((t) => t.members));
        ensureValidActiveTeamId(adapted);
        set({
          teams: adapted,
          teamsLoaded: true,
          teamsLoading: false,
          activeTeamId: readActiveTeamId(),
        });
      } catch (err) {
        if (get().epoch !== epoch) return;
        console.error('[backend store] refreshTeams failed:', err);
        set({ teamsLoading: false });
        tea.notify.error(i18n.t('backend.loadTeamsFailed'));
      } finally {
        // Only clear "its own" in-flight marker: a stale request must not clear the reference of a new request
        set((s) => (s.inflightTeams === promise ? { inflightTeams: null } : {}));
      }
    })();

    set({ inflightTeams: promise });
    await promise;
  },

  fetchAgents: async (teamId: string) => {
    const state = get();
    // Already loaded -> return the cache directly
    if (state.agentsLoadedTeamIds.has(teamId)) {
      return state.agentsByTeam[teamId] ?? [];
    }
    // in-flight dedupe
    if (state.inflightAgents[teamId] != null) {
      return state.inflightAgents[teamId];
    }

    const epoch = state.epoch;
    const promise = (async () => {
      try {
        const backendAgents = await agentsApi.list(teamId);
        // Old-session results returned after a logout/cache clear: discard, do not write to the store
        if (get().epoch !== epoch) return [];
        const adapted = backendAgents.map((ba, i) => adaptAgent(ba, i));
        set((s) => ({
          agentsByTeam: { ...s.agentsByTeam, [teamId]: adapted },
          agentsLoadedTeamIds: new Set(s.agentsLoadedTeamIds).add(teamId),
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        return adapted;
      } catch (err) {
        if (get().epoch !== epoch) return [];
        console.error('[backend store] fetchAgents failed:', err);
        set((s) => ({
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadAgentsFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightAgents: { ...s.inflightAgents, [teamId]: promise } }));
    return promise;
  },

  fetchTasks: async (teamId: string, params?: { limit?: number; offset?: number; force?: boolean }) => {
    const state = get();
    const limit = params?.limit ?? 20;
    const offset = params?.offset ?? 0;
    // Cache key: at (offset, limit) granularity (teamId is already isolated by the tasksPagesByTeam[teamId] layer)
    const cacheKey = `${offset}:${limit}`;
    // The in-flight key must carry teamId -- when two teams fetch concurrently with the same pagination params,
    // if they shared offset:limit as the key, the later team would await the earlier team's request,
    // and neither write the cache nor really send a request itself, leaving the page blank forever.
    const inflightKey = `${teamId}:${cacheKey}`;
    // Cached and not a forced refresh -> return directly
    if (!params?.force && state.tasksPagesByTeam[teamId]?.[cacheKey]) {
      return state.tasksPagesByTeam[teamId][cacheKey];
    }
    // in-flight dedupe
    if (state.inflightTasks[inflightKey]) { await state.inflightTasks[inflightKey]; return get().tasksPagesByTeam[teamId]?.[cacheKey] ?? []; }

    const epoch = state.epoch;
    const promise = (async () => {
      try {
        const { items: tasksWithAgents, total } = await tasksApi.listWithAgents(teamId, { limit, offset });
        // Old-session results returned after a logout/cache clear: discard, do not write to the store
        if (get().epoch !== epoch) return [];
        const adapted = tasksWithAgents.map((t) =>
          adaptTask(t, t.agents.filter((a) => a.status === 'active').map((a) => a.agent_id))
        );
        set((s) => {
          const teamPages = s.tasksPagesByTeam[teamId] ?? {};
          return {
            tasksPagesByTeam: { ...s.tasksPagesByTeam, [teamId]: { ...teamPages, [cacheKey]: adapted } },
            tasksTotalByTeam: { ...s.tasksTotalByTeam, [teamId]: total },
            inflightTasks: Object.fromEntries(
              Object.entries(s.inflightTasks).filter(([k]) => k !== inflightKey)
            ),
          };
        });
        return adapted;
      } catch (err) {
        console.error('[backend store] fetchTasks failed:', err);
        set((s) => ({
          inflightTasks: Object.fromEntries(
            Object.entries(s.inflightTasks).filter(([k]) => k !== inflightKey)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadTasksFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightTasks: { ...s.inflightTasks, [inflightKey]: promise } }));
    return promise;
  },

  setActiveTeamId: (teamId) => {
    writeActiveTeamId(teamId);
    set({ activeTeamId: teamId });
  },

  // Called after write operations: clear all caches + broadcast a refresh
  invalidate: () => {
    set((s) => ({
      teams: [],
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      tasksTotalByTeam: {},
      tasksPagesByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
      inflightTasks: {},
      // In-flight request results from before the write operation are stale data and must be discarded
      epoch: s.epoch + 1,
    }));
    emitBackendRefresh();
  },

  // Called on team switch: clear only the current team's agents/tasks cache
  invalidateTeam: (teamId) => {
    set((s) => {
      const agentsLoadedTeamIds = new Set(s.agentsLoadedTeamIds);
      agentsLoadedTeamIds.delete(teamId);
      const agentsByTeam = { ...s.agentsByTeam };
      delete agentsByTeam[teamId];
      const tasksPagesByTeam = { ...s.tasksPagesByTeam };
      delete tasksPagesByTeam[teamId];
      const tasksTotalByTeam = { ...s.tasksTotalByTeam };
      delete tasksTotalByTeam[teamId];
      return { agentsLoadedTeamIds, agentsByTeam, tasksPagesByTeam, tasksTotalByTeam };
    });
    emitBackendRefresh();
  },

  // Called on logout / 401: clear all caches but don't broadcast the event
  clearAll: () => {
    set((s) => ({
      teams: [],
      // Also clear the activeTeamId inside the store (writeActiveTeamId(null) only clears localStorage,
      // here the in-memory state is cleared as a safeguard, to avoid leaving the old team behind when no useTeams mount is listening)
      activeTeamId: null,
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      tasksTotalByTeam: {},
      tasksPagesByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
      inflightTasks: {},
      // Increment the epoch: so the in-flight request results of the old session are discarded after returning
      epoch: s.epoch + 1,
    }));
  },
}));

// ========================= React Hooks =========================

/**
 * useTeams -- read the team list + activeTeamId from the store.
 *
 * Multiple components calling useTeams() trigger fetchTeams only once (teamsLoaded flag + in-flight dedupe).
 * After a write operation call invalidate() -> teamsLoaded=false -> re-fetch on the next component mount/render.
 * Switching team goes through setActiveTeamId -> writes localStorage + updates state.
 */
export function useTeams(): {
  teams: Team[];
  activeTeamId: string | null;
  activeTeam: Team | null;
  loading: boolean;
} {
  const teams = useBackendStore((s) => s.teams);
  const teamsLoaded = useBackendStore((s) => s.teamsLoaded);
  const teamsLoading = useBackendStore((s) => s.teamsLoading);
  const activeTeamId = useBackendStore((s) => s.activeTeamId);
  const fetchTeams = useBackendStore((s) => s.fetchTeams);

  useEffect(() => {
    if (!teamsLoaded && !teamsLoading) {
      void fetchTeams();
    }
  }, [teamsLoaded, teamsLoading, fetchTeams]);

  // Listen to localStorage changes (triggered when TeamSwitcher writes activeTeamId)
  const [, force] = useState(0);
  useEffect(() => {
    const onLocalChange = () => {
      useBackendStore.setState({ activeTeamId: readActiveTeamId() });
      force((n) => n + 1);
    };
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
    return () => window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  }, []);

  const activeTeam = teams.find((t) => t.team_id === activeTeamId) ?? null;
  return { teams, activeTeamId, activeTeam, loading: teamsLoading };
}

const EMPTY_AGENTS: Agent[] = [];
const EMPTY_TASKS: Task[] = [];

/**
 * useAgents -- read the agent list of a given team from the store.
 *
 * Multiple components calling with the same teamId trigger only one fetch.
 * It re-fetches only after invalidate() or invalidateTeam(teamId).
 */
export function useAgents(teamId: string | null | undefined): {
  agents: Agent[];
  loading: boolean;
} {
  // Use a ref to cache the last teamId, avoiding the selector returning a different reference each time
  const agents = useBackendStore((s) =>
    teamId ? (s.agentsByTeam[teamId] ?? EMPTY_AGENTS) : EMPTY_AGENTS
  );
  const loaded = useBackendStore((s) => (teamId ? s.agentsLoadedTeamIds.has(teamId) : true));
  const fetchAgents = useBackendStore((s) => s.fetchAgents);

  useEffect(() => {
    if (!teamId) return;
    if (!loaded) {
      void fetchAgents(teamId);
    }
  }, [teamId, loaded, fetchAgents]);

  return { agents, loading: !!teamId && !loaded };
}

/**
 * useTasks -- read the task list of a given team from the store.
 */
export function useTasks(teamId: string | null | undefined, page: number = 1, pageSize: number = 12): {
  tasks: Task[];
  total: number;
  loading: boolean;
} {
  const offset = (page - 1) * pageSize;
  const cacheKey = `${offset}:${pageSize}`;
  const tasks = useBackendStore((s) =>
    teamId ? (s.tasksPagesByTeam[teamId]?.[cacheKey] ?? EMPTY_TASKS) : EMPTY_TASKS
  );
  const total = useBackendStore((s) =>
    teamId ? (s.tasksTotalByTeam[teamId] ?? 0) : 0
  );
  const loaded = useBackendStore((s) =>
    teamId ? !!s.tasksPagesByTeam[teamId]?.[cacheKey] : true
  );
  const fetchTasks = useBackendStore((s) => s.fetchTasks);

  useEffect(() => {
    if (!teamId || loaded) return;
    void fetchTasks(teamId, { limit: pageSize, offset });
  }, [teamId, offset, pageSize, loaded, fetchTasks]);

  return { tasks, total, loading: !!teamId && !loaded };
}

/**
 * readActiveTeamAgents -- synchronously read the cached agent list (does not trigger a request).
 * For scenarios like SkillsPanel that only need a "reference list".
 */
export function readActiveTeamAgents(teamId: string | null): Array<{ id: string; name: string }> {
  if (!teamId) return [];
  const cached = useBackendStore.getState().agentsByTeam[teamId];
  if (cached) return cached.map((a) => ({ id: a.agent_id, name: a.name }));
  // Cache miss: trigger a background fetch
  void useBackendStore.getState().fetchAgents(teamId);
  return [];
}

// ========================= Export invalidate / clearAll (called by mutations) =========================

export function invalidateBackendCache(): void {
  useBackendStore.getState().invalidate();
}

export function clearBackendCache(): void {
  useBackendStore.getState().clearAll();
}

export function invalidateTeamCache(teamId: string): void {
  useBackendStore.getState().invalidateTeam(teamId);
}
