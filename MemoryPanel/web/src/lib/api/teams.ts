/**
 * api/teams.ts — Team + TeamMember（meta/team/* + meta/team-member/*）。
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { Team, TeamMember } from './types';

export const teamsApi = {
  /**
   * List teams where the current user is an active member.
   * meta/team/list requires the body to carry user_id or user_key; identity in the header alone is not enough.
   * admin also passes their own user_id (the backend has no user/list-style "instance-level list of all teams" yet).
   */
  list: async () => {
    const me = await getCurrentUser();
    return metaListAll<Team>('team/list', { user_id: me.user_id });
  },

  /** Team detail */
  get: (teamId: string) => metaPost<Team>('team/get', { team_id: teamId }),

  /** Create team */
  create: async (data: { name: string; description?: string }) => {
    const me = await getCurrentUser();
    return metaPost<Team>('team/create', {
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
    });
  },

  /** Update team */
  update: (teamId: string, data: { name?: string; description?: string }) =>
    metaPost<Team>('team/update', { team_id: teamId, ...data }),

  /**
   * Delete team (meta team/delete).
   * Note: the backend schema requires a `team_ids` array (several can be deleted at once); passing the singular `team_id`
   * is silently stripped by zod and then fails validation due to missing `team_ids` → 400. Deletion is cascading,
   * and also deletes the team's members, agents, tasks and all assets.
   */
  delete: (teamId: string) => metaPost<{ ok: boolean }>('team/delete', { team_ids: [teamId] }),
};

export const membersApi = {
  /** List team members */
  list: (teamId: string) => metaListAll<TeamMember>('team-member/list', { team_id: teamId }),

  /**
   * Add a member (join the team by a known user_id).
   *
   * "Opening an account" (getting a user_key) and "joining a team" are two independent things: after the user logs in with their own
   * user_key they can get their own user_id from auth/verify; a team admin only needs
   * to know this user_id to call team-member/add (a standard meta action).
   * There is no equivalent of "create an account by username" - to look up a user_id by username, use `usersApi.list`
   * passing `{ username }` for an exact match.
   */
  add: (teamId: string, data: { user_id: string; role: 'admin' | 'member' | 'reviewer' }) =>
    metaPost<TeamMember>('team-member/add', { team_id: teamId, user_id: data.user_id, role: data.role }),

  /** Remove a member */
  remove: async (teamId: string, userId: string) => {
    await metaPost<{ ok: boolean }>('team-member/remove', { team_id: teamId, user_id: userId });
  },
};
