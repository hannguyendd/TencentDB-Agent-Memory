/**
 * Public action list for the kernel /v3/meta/* (v3.2: 55 actions, internal excluded).
 * Note: agent-fixed-asset/* is still registered in META_ACTIONS but the public proxy returns 501 NOT_IN_SCOPE;
 * Control business routes can call it directly via metaKernel.invoke.
 */

export const META_LIST_ACTIONS = new Set([
  'user/list',
  'user-key/list',
  'team/list',
  'team-member/list',
  'agent/list',
  'task/list',
  'task-agent/list',
  'asset/list',
  'asset/list-accessible',
  'agent-fixed-asset/list',
  'agent-fixed-asset/list-with-detail',
  // summary-by-agents is a non-paginated list envelope, not part of META_LIST_ACTIONS
  'acl/list',
  'participation-log/list',
]);

export const META_ACTIONS = [
  'user/create',
  // Sibling endpoint: admin creates an account with an explicit user_key; otherwise fully symmetric with user/create.
  'user/create-with-key',
  'user/get',
  'user/delete',
  'user/list',
  'user-key/create',
  'user-key/list',
  'user-key/get',
  'user-key/revoke',
  'user-key/update',
  'team/create',
  'team/get',
  'team/update',
  'team/delete',
  'team/list',
  'team-member/add',
  'team-member/remove',
  'team-member/list',
  'team-member/get',
  'agent/create',
  'agent/get',
  'agent/update',
  'agent/delete',
  'agent/list',
  'agent/archive',
  'agent/set-default-template',
  'agent/get-default-template',
  'task/create',
  'task/get',
  'task/update',
  'task/delete',
  'task/list',
  'task/archive',
  'task-agent/link',
  'task-agent/unlink',
  'task-agent/list',
  'participation-log/append',
  'participation-log/list',
  'asset/create',
  'asset/get',
  'asset/update',
  'asset/delete',
  'asset/list',
  'asset/list-accessible',
  'asset/touch-usage',
  'agent-fixed-asset/set',
  'agent-fixed-asset/list',
  'agent-fixed-asset/list-with-detail',
  'agent-fixed-asset/summary-by-agents',
  'acl/grant',
  'acl/revoke',
  'acl/list',
  'acl/check',
  'auth/verify',
  'instance-quota/get',
  'config/user/get',
  'config/user/set',
] as const;

export type MetaAction = (typeof META_ACTIONS)[number];

/**
 * Action prefixes not yet exposed to the panel.
 *
 * asset/* is now open: when a skill is "assigned to an Agent" via the authorization endpoint (acl/grant), the skill must first
 * be registered as a meta asset (asset/create, owner = current logged-in user), then the target agent is granted use permission.
 * agent-fixed-asset/* (runtime fixed-injection binding) remains closed for now.
 */
const NOT_IN_SCOPE_PREFIXES = ['agent-fixed-asset/'] as const;

export function isNotInScopeAction(action: string): boolean {
  return NOT_IN_SCOPE_PREFIXES.some((prefix) => action.startsWith(prefix));
}

export const ALLOWED_PANEL_ACTIONS = new Set(
  META_ACTIONS.filter((action) => !isNotInScopeAction(action)),
);
