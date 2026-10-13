/**
 * Auth Store (zustand)
 *
 * Connects to the new panel Control (no Cookie, stateless proxy, see design doc 09 section 3.3).
 * Login credentials (instance_id + user_key) are cached in localStorage (lib/panelSession.ts),
 * and "log out" / "session expired" both just clear the local cache; Control has no logout API and no server-side session table.
 *
 * Multi-tab sync: listen to localStorage changes via the storage event.
 *   - Another tab logs in -> this tab automatically restores the login state (checkSession)
 *   - Another tab logs out / 401 -> this tab automatically exits to LoginGate
 *
 * Three auth states:
 *   - null      detecting login state (App calls checkSession on startup to read the localStorage cache)
 *   - undefined confirmed not logged in -> render LoginGate
 *   - AuthState logged in -> render the main UI
 */
import { create } from 'zustand';
import { readAuth, clearAuth, resumeSession, type AuthState } from '@/components/LoginGate';
import { onUnauthorized } from '@/lib/teamApi';
import { clearBackendCache, writeActiveTeamId } from '@/services';

const PANEL_SESSION_KEY = 'tdai-panel.session';

interface AuthStore {
  auth: AuthState | null | undefined;
  /** Written after a successful login (LoginGate's onLoggedIn callback) */
  setAuth: (auth: AuthState) => void;
  /** Log out: clear the local localStorage session and return to LoginGate (no backend call) */
  logout: () => Promise<void>;
  /** App startup reads the localStorage cache; regardless of the result, it advances auth from null to a definite state */
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  auth: null,

  setAuth: (auth) => {
    set({ auth });
  },

  logout: async () => {
    // The new panel has no server-side session; logout just clears the local cache, with no need for (and no existence of) a backend logout endpoint.
    // Clear the module-level backend cache (teams/agents/tasks) to avoid a new user briefly seeing the previous user's list after logging in.
    // Use clearBackendCache rather than invalidateBackendCache: the latter broadcasts an event that triggers the refetch listeners of mounted pages,
    // which are still making requests with the old session Header and would pull the old data back;
    // here only the cache is cleared, so that when the new user logs in and mounts components they naturally go through the first fetch.
    clearBackendCache();
    // activeTeamId may point to a team only the old user had permission for; clear it to avoid the new user selecting a team they have no permission for after login.
    writeActiveTeamId(null);
    clearAuth();
    set({ auth: undefined });
  },

  checkSession: async () => {
    const cached = readAuth();
    if (cached) {
      set({ auth: cached });
      return;
    }
    const auth = await resumeSession();
    set({ auth: auth ?? undefined });
  },
}));

/**
 * Cross-tab sync: listen to the localStorage storage event.
 *
 * The storage event fires only when "another tab" modifies localStorage (writes from this tab don't trigger it),
 * which is well suited to cross-tab state sync.
 *
 *   - Another tab logs in (writes tdai-panel.session) -> this tab restores the login state
 *   - Another tab logs out / 401 (deletes tdai-panel.session) -> this tab exits to LoginGate
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PANEL_SESSION_KEY) return;

    if (e.newValue === null) {
      // Another tab logged out -> this tab exits in sync
      clearBackendCache();
      writeActiveTeamId(null);
      clearAuth();
      useAuthStore.setState({ auth: undefined });
    } else {
      // Another tab logged in -> this tab restores the login state
      void useAuthStore.getState().checkSession();
    }
  });
}

// When any meta request returns HTTP 401 (e.g. a Control validation error lands on this code), globally clear the session and return to the login page.
// Under the new panel this is not the main logout trigger path (active logout goes through logout()), and serves only as a fallback.
// Like logout(), it clears the cache; otherwise after a 401 re-login the previous user's list would still be briefly visible.
// It only needs to be registered once when the store module loads.
onUnauthorized(() => {
  clearBackendCache();
  writeActiveTeamId(null);
  clearAuth();
  useAuthStore.setState({ auth: undefined });
});
