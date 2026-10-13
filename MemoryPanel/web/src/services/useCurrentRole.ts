/**
 * useCurrentRole -- get the role of the currently logged-in user
 *
 * Returns 'admin' | 'member' | 'reviewer' | null (null = not logged in).
 *
 * Role model (the single authoritative definition; do not change back to "judge admin by the team member table"):
 *   - admin  is a **global role**, unrelated to whether any team is created/joined (even with no team at present, it is always admin).
 *     The admin's responsibility is to manage teams (create teams, enter members), not to manage specific resources.
 *   - member is a **team-level role**, i.e. a member of some team, responsible for managing resources (agent/skill/wiki/code/memory) within the team.
 *   - Therefore the decision order must be: first check whether the user is a global admin; if not, then look up their member role in the active team.
 *     The reverse, "check the team member table first and treat as no role if not found", is wrong -- it would cause "when the admin account has no team
 *     to be misjudged as non-admin (even null)".
 */
import { useMemo } from 'react';
import { useTeams, roleInTeam, isGlobalAdmin } from '@/services';
import { useAuthStore } from '@/stores/auth';

export type TeamRole = 'admin' | 'member' | 'reviewer';

export function useCurrentRole(): TeamRole | null {
  const { auth } = useAuthStore();
  const { activeTeam } = useTeams();
  return useMemo(() => {
    if (!auth) return null;
    // Global admin: independent of team, always admin (does not depend on the activeTeam / team.members lookup result)
    // isAdmin comes from user_type === 'system_admin' in auth/verify, the single authoritative field.
    if (isGlobalAdmin(auth.user, auth.isAdmin)) return 'admin';
    // Non-admin: the role depends on their member record in the current active team (generally just 'member')
    return roleInTeam(activeTeam, auth.user_id);
  }, [activeTeam, auth]);
}
