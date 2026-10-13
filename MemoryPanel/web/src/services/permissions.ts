/**
 * permissions.ts -- the single authoritative implementation of global permission checks.
 *
 * Extracted from the original demoStore.ts. isGlobalAdmin is the only "global admin" decision
 * entry point site-wide (unrelated to the backend implementation of team/agent/task; a pure frontend auth state check).
 */

/**
 * Global admin check: admin has all permissions and can see all content.
 *
 * The single authoritative source: the `user.user_type === 'system_admin'` of the auth/verify response,
 * written to `AuthState.isAdmin` by LoginGate at login.
 *
 * The `username === 'admin'` string fallback is no longer kept -- that fallback is a leftover from the early demo phase,
 * and would cause ordinary users whose display_name / username happens to be "admin" to be misjudged as global admin,
 * especially when "the user belongs to no team" or "the team has only oneself",
 * roleInTeam returns null and the UI renders with admin logic (e.g. ResourcePage shows AdminResourceLock),
 * leading to the problem of normal/member users seeing the admin lock page.
 */
export function isGlobalAdmin(_currentUser: string, isAdminFlag?: boolean): boolean {
  return isAdminFlag === true;
}
