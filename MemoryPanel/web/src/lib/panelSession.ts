/**
 * Panel Session - session cache of the new panel frontend (localStorage).
 *
 * Aligned with docs/architecture/09-new-panel-control-backend-design.md §3.3.2:
 * the new panel Control is a stateless proxy and does not build Cookie/Session; login credentials
 * (instance_id + user_key) are held by the frontend itself, cached in localStorage
 * (shared across tabs, not invalidated on closing a tab), and read from here on every meta request to inject Headers:
 *   - X-Tdai-Service-Id (= registry id = kernel x-tdai-service-id; early doc versions used
 *     the name `X-Metadata-Instance-Id`, renamed since meta-api.openapi.yaml v1.1.0,
 *     always follow the latest contract, otherwise Control reports 400 MISSING_INSTANCE_ID)
 *   - X-Tdai-User-Key (except auth/verify)
 *
 * Previously sessionStorage (tab-level) was used, so a newly opened tab required logging in again.
 * Switched to localStorage so multiple tabs share the login state, and logout is synced via the storage event.
 */
import type { PublicUser } from './teamApi';

export interface PanelSession {
  /** Auth source; the default value means a legacy user_key session. */
  authMethod?: 'user_key' | 'idp';
  /** = registry id = kernel x-tdai-service-id; determined when choosing an instance on the login page */
  instanceId: string;
  /** Display only (name in the instance list), not required */
  instanceName?: string;
  /** API key of a legacy user_key session; IdP Session uses an empty-string placeholder, and the real user_key is not sent down. */
  userKey: string;
  /** auth/verify response data.user (optional, used for display + as the source of owner_user_id/creator_user_id) */
  user?: PublicUser;
}

const STORAGE_KEY = 'tdai-panel.session';

/** Read the current session; returns null when there is no session or parsing fails (does not throw, callers treat it as not logged in) */
export function getPanelSession(): PanelSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PanelSession;
  } catch {
    return null;
  }
}

/** Write the session after a successful login (auth/verify returns valid===true) */
export function setPanelSession(session: PanelSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* Privacy mode / storage quota anomaly: fail silently, without blocking the in-memory state of this session after login */
  }
}

/** Clear the session on logout / 401 fallback */
export function clearPanelSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
