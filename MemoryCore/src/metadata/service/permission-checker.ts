/**
 * Pure permission-decision functions.
 *
 * Corresponds to design doc §10.3 (checkPermission, three-part owner+scope+grant)
 * and §10.4 (canBindAsset, fixed asset-binding validation).
 *
 * Design points:
 *   - Decision order optimized to "resource → owner → member → visibility → role default → ACL → deny",
 *     so high-frequency scenarios (admin read/write / member read-only) are allowed at role default with no ACL table lookup.
 *   - Role default permissions are code-level hardcoded constants; no data needs to be pre-configured for roles.
 *   - Phase one is an allow-only model.
 */

import type { AssetEntity, TeamMemberEntity, AclEntity, Permission } from "../types.js";

export interface PermCheckLogger {
  debug: (msg: string) => void;
}

export interface PermCheckContext {
  user: { user_id: string };
  asset: AssetEntity | null;
  /** The user's membership under asset.team_id. */
  membership: TeamMemberEntity | null;
  action: Permission;
  /** All ACL records related to the asset (lazy-loaded: provided by the service only when the ACL step is reached). */
  aclRecords: AclEntity[];
  /** Optional; passed when action='use' and the caller is an agent. */
  agentId?: string;
  logger?: PermCheckLogger;
}

export interface PermCheckResult {
  allowed: boolean;
  reason: string;
}

const ADMIN_ACTIONS: Permission[] = ["read", "write", "assign", "share"];
const MEMBER_ACTIONS: Permission[] = ["read"];

const noopLogger: PermCheckLogger = { debug: () => {} };

export function checkPermission(ctx: PermCheckContext): PermCheckResult {
  const { user, asset, membership, action, aclRecords, agentId } = ctx;
  const logger = ctx.logger ?? noopLogger;

  // 1. Resource does not exist / archived
  if (!asset || asset.status === "archived") {
    logger.debug(`[META] perm_check DENY: asset not found or archived`);
    return { allowed: false, reason: "asset_not_available" };
  }

  // 2. Owner is fully allowed
  if (asset.owner_user_id === user.user_id) {
    logger.debug(`[META] perm_check ALLOW: owner`);
    return { allowed: true, reason: "owner" };
  }

  // 3. Not a team member
  if (!membership || membership.status !== "active") {
    logger.debug(`[META] perm_check DENY: not team member`);
    return { allowed: false, reason: "not_team_member" };
  }

  // 4. Visibility restriction
  switch (asset.visibility) {
    case "private":
      // Private semantics (changed 2026-07): strictly private, only owner_user_id can access.
      // Team admins are not allowed either -- because the owner check in step 2 already returned ALLOW first,
      // reaching here means the current user is not the owner, and even an admin is always denied.
      //
      // Semantic explanation:
      //   - private = personal private asset, nobody in the team can see it (including admins)
      //   - team    = shared with the whole team (team members can read, owner/admin can write)
      //   - restricted = strict ACL allowlist (see the case below)
      //
      // Impact:
      //   - list-accessible does not return other people's private assets (also applies to admin)
      //   - permission-checker.check also returns DENY when an admin accesses someone else's private asset
      //   - if an admin really needs to see it, have the owner switch it to team or grant via acl/grant
      logger.debug(`[META] perm_check DENY: visibility=private, role=${membership.role}`);
      return { allowed: false, reason: "visibility_restricted" };
    case "restricted":
      if (membership.role !== "admin") {
        // Non-admin: skip role defaults, only explicit ACL can grant access
        const matched = aclRecords.find(
          (acl) =>
            acl.permission === action &&
            acl.effect === "allow" &&
            ((acl.subject_type === "user" && acl.subject_id === user.user_id) ||
              (acl.subject_type === "team_role" && acl.subject_id === membership.role) ||
              (acl.subject_type === "agent" && !!agentId && acl.subject_id === agentId)),
        );
        if (matched) {
          logger.debug(`[META] perm_check ALLOW: restricted + acl id=${matched.id}`);
          return { allowed: true, reason: `acl:${matched.id}` };
        }
        logger.debug(`[META] perm_check DENY: visibility=restricted, no ACL match`);
        return { allowed: false, reason: "visibility_restricted" };
      }
      break;
    case "task":
      if (action !== "read" && membership.role !== "admin") {
        logger.debug(`[META] perm_check DENY: visibility=task, non-admin non-read`);
        return { allowed: false, reason: "visibility_restricted" };
      }
      break;
    case "team":
    case "agent":
      break;
    default:
      logger.debug(`[META] perm_check DENY: unknown visibility=${asset.visibility}`);
      return { allowed: false, reason: "visibility_restricted" };
  }

  // 5. Role default permissions (allow on hit, can skip the ACL lookup)
  const defaults = membership.role === "admin" ? ADMIN_ACTIONS : MEMBER_ACTIONS;
  if (defaults.includes(action)) {
    logger.debug(`[META] perm_check ALLOW: role_default=${membership.role}`);
    return { allowed: true, reason: `role_default:${membership.role}` };
  }

  // 6. Explicit ACL (three kinds of subject: user / team_role / agent)
  const matched = aclRecords.find(
    (acl) =>
      acl.permission === action &&
      acl.effect === "allow" &&
      ((acl.subject_type === "user" && acl.subject_id === user.user_id) ||
        (acl.subject_type === "team_role" && acl.subject_id === membership.role) ||
        (acl.subject_type === "agent" && !!agentId && acl.subject_id === agentId)),
  );
  if (matched) {
    logger.debug(`[META] perm_check ALLOW: acl id=${matched.id}`);
    return { allowed: true, reason: `acl:${matched.id}` };
  }

  logger.debug(`[META] perm_check DENY: no matching rule`);
  return { allowed: false, reason: "no_permission" };
}

/**
 * Whether the role default permissions cover this action (the service uses this to decide whether to lazily load the ACL).
 * Returning true means no ACL table lookup is needed.
 */
export function roleDefaultCovers(role: TeamMemberEntity["role"], action: Permission): boolean {
  const defaults = role === "admin" ? ADMIN_ACTIONS : MEMBER_ACTIONS;
  return defaults.includes(action);
}

/**
 * Determine whether an Asset's visibility allows binding to the specified Agent (§10.4).
 * Complements checkPermission: checkPermission governs "who can operate on a resource",
 * canBindAsset governs "whether a resource can be attached to an agent".
 */
export function canBindAsset(
  agent: Pick<import("../types.js").AgentEntity, "team_id" | "owner_user_id">,
  asset: Pick<AssetEntity, "visibility" | "team_id" | "owner_user_id">,
): boolean {
  switch (asset.visibility) {
    case "team":
      return asset.team_id === agent.team_id;
    case "agent":
      return asset.team_id === agent.team_id;
    case "private":
      return asset.owner_user_id === agent.owner_user_id && asset.team_id === agent.team_id;
    case "task":
    case "restricted":
      return false;
    default:
      return false;
  }
}
