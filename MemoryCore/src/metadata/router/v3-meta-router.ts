/**
 * v3 metadata routes (/v3/meta/*, 55 endpoints).
 *
 * Corresponds to design doc §7 + implementation plan M3.3. Mirrors the v2-router dispatch pattern:
 *   - POST only, prefix /v3/meta
 *   - x-tdai-user-key user auth + bootstrap route exceptions (see auth.ts)
 *   - each handler validates with a Zod schema before calling MetadataService
 *   - MetadataError → the corresponding envelope code; unknown exceptions → 500
 *
 * Reuses the v2 envelope utilities to keep response formats consistent.
 */

import type * as http from "node:http";
import type { ZodType } from "zod";
import {
  successEnvelope,
  errorEnvelope,
  resolveRequestId,
} from "../../gateway/v2-router.js";
import { formatZodError, type ApiResponseEnvelope } from "../../gateway/v2-schemas.js";
import type { Logger } from "../../core/types.js";
import { MetadataService, MetadataError } from "../service/metadata-service.js";
import {
  authenticateV3,
  extractUserKeyHeader,
  V3_NO_USER_KEY_ROUTES,
  type V3AuthContext,
} from "./auth.js";
import { extractInstanceId } from "./instance.js";
import { resolvePagination } from "./pagination.js";
import { resolveUserId } from "../service/resolve-user-id.js";
import type { AgentFilter, TaskFilter, ParticipationLogFilter } from "../types.js";
import * as S from "./v3-meta-schemas.js";
import {
  createMetaApiTraceContext,
  logMetaApiEntry,
  logMetaApiError,
  logMetaApiRejected,
  logMetaApiResponse,
} from "./meta-api-trace.js";
import {
  getApiTraceConfig,
  runWithApiRequestContext,
} from "../../api-trace/index.js";
import { requireEntity, EntityType } from "./entity-ref-validator.js";

export const V3_PREFIX = "/v3/meta";
const TAG = "[META-V3]";

export interface V3MetaRouterDeps {
  getMetadataService: (instanceId: string) => MetadataService | undefined | Promise<MetadataService | undefined>;
  logger: Logger;
  /**
   * Returns the list of agents supported by the current Core deployment.
   * Used by the §6.A supported-agents endpoint echo, the agents enum validation on groups/create + update,
   * and as the seed default data source. Loaded by Core at startup from gateway.yaml
   * upstream.supportedAgents (see §8.1 Core-side changes).
   */
  getSupportedAgents: () => import("../types.js").SupportedAgent[];
}

/** Runtime dependencies consumed by handlers (the 4th argument passed in by the bind layer). */
export interface V3MetaRouterRuntimeDeps {
  getSupportedAgents: () => import("../types.js").SupportedAgent[];
}

type Ctx = V3AuthContext;
type BizFn<T> = (
  data: T,
  ctx: Ctx,
  svc: MetadataService,
  requestId: string,
  deps: V3MetaRouterRuntimeDeps,
) => Promise<unknown>;
type Handler = (
  body: unknown,
  ctx: Ctx,
  svc: MetadataService,
  requestId: string,
  deps: V3MetaRouterRuntimeDeps,
) => Promise<ApiResponseEnvelope>;

/** Schema validation + business call + success wrapping; business exceptions are handled uniformly by dispatch. */
function bind<S2 extends ZodType>(schema: S2, fn: BizFn<S2["_output"]>): Handler {
  return async (body, ctx, svc, requestId, deps) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
    const data = await fn(parsed.data as S2["_output"], ctx, svc, requestId, deps);
    return successEnvelope(data, requestId);
  };
}

function orNotFound<T>(entity: T | null, code: string, id: string): T {
  if (entity === null || entity === undefined) {
    throw new MetadataError(code, `not found: ${id}`);
  }
  return entity;
}

const OK = { ok: true } as const;

// ── Route table (55 endpoints) ──
const routeTable: Record<string, Handler> = {
  // User
  [`${V3_PREFIX}/user/create`]: bind(S.userCreateSchema, async (d, c, s) => {
    s.assertCanManageUsers(c);
    return s.createNormalUser(d);
  }),
  // Sibling endpoint: lets system_admin explicitly specify user_key when creating an account. Auth is fully symmetric with /user/create.
  // Zod only validates that username + user_key are non-empty; a passed-in user_id is stripped and ignored by zod.
  [`${V3_PREFIX}/user/create-with-key`]: bind(S.userCreateWithKeySchema, async (d, c, s) => {
    s.assertCanManageUsers(c);
    return s.createNormalUserWithKey(d);
  }),
  // After external auth (e.g. WOA) login, determine whether it is the first time: look up the user by (auth_provider, external_id).
  // Looks up core's existing meta_users.external_id; no match = first time.
  [`${V3_PREFIX}/user/find-by-external`]: bind(S.userFindByExternalSchema, async (d, c, s) => {
    s.assertCanManageUsers(c);
    return s.findUserByExternalId(d.external_id, d.auth_provider);
  }),
  // External auth binds an existing account: write the external IdP unique id into the user's external_id.
  // auth_provider is also written as the external domain, so that it stays in the same domain as the find-by-external read
  // (writing only external_id without the domain → the next reverse lookup misses).
  // After binding, the existing account can still log in with the original user_key; external auth is just an added entry point.
  [`${V3_PREFIX}/user/bind-external`]: bind(S.userBindExternalSchema, async (d, c, s) => {
    s.assertCanManageUsers(c);
    return s.bindExternalIdToUser(d.user_id, d.external_id, d.auth_provider, d.display_name);
  }),
  [`${V3_PREFIX}/user/get`]: bind(S.userGetSchema, async (d, c, s) => {
    const userId = await resolveUserId(s, d);
    return s.getUserForCaller(userId, c);
  }),
  [`${V3_PREFIX}/user/delete`]: bind(S.userDeleteSchema, (d, c, s) => s.deleteUsersForCaller(d.user_ids, c)),
  [`${V3_PREFIX}/user/list`]: bind(S.userListSchema, (d, c, s) =>
    s.listUsersForCaller(d, c, resolvePagination(d)),
  ),

  [`${V3_PREFIX}/user-key/create`]: bind(S.userKeyCreateSchema, async (d, c, s) => {
    const userId = d.user_id ?? c.userId;
    if (!userId) throw new MetadataError("permission_denied", "user_id required for admin bootstrap");
    s.assertUserScope(userId, c.userId, c.isAdmin, c.isSystemAdmin);
    return s.createUserKey(userId, { name: d.name, expires_at: d.expires_at });
  }),
  [`${V3_PREFIX}/user-key/list`]: bind(S.userKeyListSchema, async (d, c, s) => {
    const userId = d.user_id ?? c.userId;
    if (!userId) throw new MetadataError("permission_denied", "user_id required");
    s.assertUserScope(userId, c.userId, c.isAdmin, c.isSystemAdmin);
    return s.listUserKeys(userId, resolvePagination(d));
  }),
  [`${V3_PREFIX}/user-key/get`]: bind(S.userKeyGetSchema, async (d, c, s) =>
    s.getUserKeyForCaller(d.key_id, c.userId, c.isAdmin, c.isSystemAdmin),
  ),
  [`${V3_PREFIX}/user-key/revoke`]: bind(S.userKeyRevokeSchema, async (d, c, s) => {
    const entity = await s.rawStore.getUserKeyById(d.key_id);
    if (!entity) throw new MetadataError("user_key_not_found", `user key not found: ${d.key_id}`);
    s.assertUserScope(entity.user_id, c.userId, c.isAdmin, c.isSystemAdmin);
    await s.revokeUserKey(d.key_id);
    return OK;
  }),
  [`${V3_PREFIX}/user-key/update`]: bind(S.userKeyUpdateSchema, async (d, c, s) => {
    const entity = await s.rawStore.getUserKeyById(d.key_id);
    if (!entity) throw new MetadataError("user_key_not_found", `user key not found: ${d.key_id}`);
    s.assertUserScope(entity.user_id, c.userId, c.isAdmin, c.isSystemAdmin);
    const { key_id, ...patch } = d;
    return s.updateUserKey(key_id, patch);
  }),

  // Team
  [`${V3_PREFIX}/team/create`]: bind(S.teamCreateSchema, (d, c, s) => s.createTeamForCaller(d, c)),
  [`${V3_PREFIX}/team/get`]: bind(S.teamGetSchema, async (d, _c, s) => orNotFound(await s.getTeamById(d.team_id), "team_not_found", d.team_id)),
  [`${V3_PREFIX}/team/update`]: bind(S.teamUpdateSchema, async (d, c, s) => {
    const { team_id, ...patch } = d;
    return s.updateTeamForCaller(team_id, patch, c);
  }),
  [`${V3_PREFIX}/team/delete`]: bind(S.teamDeleteSchema, (d, c, s) => s.deleteTeamsForCaller(d.team_ids, c)),
  [`${V3_PREFIX}/team/list`]: bind(S.teamListSchema, async (d, _c, s) => {
    const userId = await resolveUserId(s, d);
    const filter = d.name ? { name: d.name } : undefined;
    return s.listTeamsByUser(userId, resolvePagination(d), filter);
  }),

  // TeamMember
  [`${V3_PREFIX}/team-member/add`]: bind(S.teamMemberAddSchema, async (d, c, s) => {
    await requireEntity(s, EntityType.User, d.user_id);
    return s.addTeamMemberForCaller(d, c);
  }),
  [`${V3_PREFIX}/team-member/remove`]: bind(S.teamMemberRemoveSchema, async (d, c, s) => {
    await requireEntity(s, EntityType.User, d.user_id);
    await s.removeTeamMemberForCaller(d.team_id, d.user_id, c);
    return OK;
  }),
  [`${V3_PREFIX}/team-member/list`]: bind(S.teamMemberListSchema, (d, c, s) =>
    s.listTeamMembersForCaller(d.team_id, c, resolvePagination(d)),
  ),
  [`${V3_PREFIX}/team-member/get`]: bind(S.teamMemberGetSchema, async (d, c, s) =>
    s.getTeamMemberForCaller(d.team_id, d.user_id, c)),

  // Agent
  [`${V3_PREFIX}/agent/create`]: bind(S.agentCreateSchema, (d, c, s) => s.createAgentForCaller(d, c)),
  [`${V3_PREFIX}/agent/get`]: bind(S.agentGetSchema, async (d, _c, s) => orNotFound(await s.getAgentById(d.agent_id), "agent_not_found", d.agent_id)),
  [`${V3_PREFIX}/agent/update`]: bind(S.agentUpdateSchema, async (d, c, s) => {
    const { agent_id, ...patch } = d;
    return s.updateAgentForCaller(agent_id, patch, c);
  }),
  [`${V3_PREFIX}/agent/delete`]: bind(S.agentDeleteSchema, (d, c, s) => s.deleteAgentsForCaller(d.agent_ids, c)),
  [`${V3_PREFIX}/agent/list`]: bind(S.agentListSchema, async (d, _c, s) => {
    const pagination = resolvePagination(d);
    if (d.team_id) {
      // team_id branch: if owner_user_id is also passed, filter by both ("agents I own within the team"),
      // used for the panel's "private agent visibility" scenario. Behavior is unchanged when not passed (all of the team).
      const filter: AgentFilter = {};
      if (d.status) filter.status = d.status;
      if (d.owner_user_id) filter.owner_user_id = d.owner_user_id;
      if (d.name) filter.name = d.name;
      return s.listAgentsByTeam(d.team_id, pagination, filter);
    }
    const ownerId = d.owner_user_id ?? await resolveUserId(s, { user_key: d.owner_user_key });
    const filter2: AgentFilter = {};
    if (d.status) filter2.status = d.status;
    if (d.name) filter2.name = d.name;
    return s.listAgentsByOwner(ownerId, pagination, Object.keys(filter2).length ? filter2 : undefined);
  }),
  [`${V3_PREFIX}/agent/archive`]: bind(S.agentArchiveSchema, (d, c, s) => s.archiveAgentForCaller(d.agent_id, c)),

  // Task
  [`${V3_PREFIX}/task/create`]: bind(S.taskCreateSchema, (d, c, s) => s.createTaskForCaller(d, c)),
  [`${V3_PREFIX}/task/get`]: bind(S.taskGetSchema, async (d, _c, s) => orNotFound(await s.getTaskById(d.task_id), "task_not_found", d.task_id)),
  [`${V3_PREFIX}/task/update`]: bind(S.taskUpdateSchema, (d, c, s) => {
    const { task_id, ...patch } = d;
    return s.updateTaskForCaller(task_id, patch, c);
  }),
  [`${V3_PREFIX}/task/delete`]: bind(S.taskDeleteSchema, (d, c, s) => s.deleteTasksForCaller(d.task_ids, c)),
  [`${V3_PREFIX}/task/list`]: bind(S.taskListSchema, async (d, _c, s) => {
    const filter: TaskFilter = {};
    if (d.status) filter.status = d.status;
    if (d.title) filter.title = d.title;
    if (d.creator_user_id) {
      filter.creator_user_id = d.creator_user_id;
    } else if (d.creator_user_key) {
      filter.creator_user_id = await resolveUserId(s, { user_key: d.creator_user_key });
    }
    const pagination = resolvePagination(d);
    if (d.team_id) return s.listTasksByTeam(d.team_id, pagination, filter);
    return s.listTasks(filter, pagination);
  }),
  [`${V3_PREFIX}/task/archive`]: bind(S.taskArchiveSchema, (d, c, s) => s.archiveTaskForCaller(d.task_id, c)),

  // TaskAgent
  [`${V3_PREFIX}/task-agent/link`]: bind(S.taskAgentLinkSchema, (d, c, s) =>
    s.linkTaskAgentForCaller(d.task_id, d.agent_id, d.role_in_task, c),
  ),
  [`${V3_PREFIX}/task-agent/unlink`]: bind(S.taskAgentUnlinkSchema, async (d, c, s) => {
    await requireEntity(s, EntityType.Agent, d.agent_id);
    await s.unlinkTaskAgentForCaller(d.task_id, d.agent_id, c);
    return OK;
  }),
  [`${V3_PREFIX}/task-agent/list`]: bind(S.taskAgentListSchema, (d, _c, s) =>
    s.listTaskAgents(d.task_id, resolvePagination(d)),
  ),

  // ParticipationLog
  [`${V3_PREFIX}/participation-log/append`]: bind(S.participationLogAppendSchema, (d, c, s) =>
    s.appendParticipationLogForCaller(d, c),
  ),
  [`${V3_PREFIX}/participation-log/list`]: bind(S.participationLogListSchema, (d, c, s) => {
    const filter: ParticipationLogFilter = { team_id: d.team_id };
    if (d.task_id) filter.task_id = d.task_id;
    if (d.agent_id) filter.agent_id = d.agent_id;
    if (d.user_id) filter.user_id = d.user_id;
    if (d.created_after) filter.created_after = d.created_after;
    if (d.created_before) filter.created_before = d.created_before;
    if (d.dedupe !== undefined) filter.dedupe = d.dedupe;
    return s.listParticipationLogsForCaller(filter, c, resolvePagination(d));
  }),

  // Asset
  [`${V3_PREFIX}/asset/create`]: bind(S.assetCreateSchema, (d, c, s) => s.createAssetForCaller(d, c)),
  // Caller-perspective read (horizontal privilege escalation fix): no access returns null → 404, without leaking asset existence
  [`${V3_PREFIX}/asset/get`]: bind(S.assetGetSchema, async (d, c, s) => orNotFound(await s.getAssetForCaller(d.asset_id, c), "asset_not_found", d.asset_id)),
  [`${V3_PREFIX}/asset/update`]: bind(S.assetUpdateSchema, (d, c, s) => {
    const { asset_id, ...patch } = d;
    return s.updateAssetForCaller(asset_id, patch, c);
  }),
  [`${V3_PREFIX}/asset/delete`]: bind(S.assetDeleteSchema, (d, c, s) => s.deleteAssetsForCaller(d.asset_ids, c)),
  // Caller-perspective read (horizontal privilege escalation fix): membership check + per-item permission filtering, same source as list-accessible
  [`${V3_PREFIX}/asset/list`]: bind(S.assetListSchema, (d, c, s) => s.listAssetsForCaller(d, c)),
  [`${V3_PREFIX}/asset/list-accessible`]: bind(S.assetListAccessibleSchema, (d, _c, s) =>
    s.listAccessibleAssets(d)),

  [`${V3_PREFIX}/asset/touch-usage`]: bind(S.assetTouchUsageSchema, async (d, c, s) => {
    await s.touchAssetUsageForCaller(d.asset_id, c);
    return OK;
  }),

  // AgentFixedAsset
  [`${V3_PREFIX}/agent-fixed-asset/set`]: bind(S.fixedAssetSetSchema, async (d, c, s) => {
    await s.setAgentFixedAssetsForCaller(d.agent_id, d.bindings, c);
    return OK;
  }),
  [`${V3_PREFIX}/agent-fixed-asset/list`]: bind(S.fixedAssetListSchema, (d, _c, s) =>
    s.listAgentFixedAssets(d.agent_id, resolvePagination(d)),
  ),
  [`${V3_PREFIX}/agent-fixed-asset/list-with-detail`]: bind(S.fixedAssetListWithDetailSchema, (d, _c, s) => s.listAgentFixedAssetsWithDetail(d)),
  [`${V3_PREFIX}/agent-fixed-asset/summary-by-agents`]: bind(S.fixedAssetSummaryByAgentsSchema, (d, _c, s) =>
    s.summarizeAgentFixedAssetsByAgents({ agent_ids: d.agent_ids, asset_id: d.asset_id }),
  ),

  // ACL
  [`${V3_PREFIX}/acl/grant`]: bind(S.aclGrantSchema, async (d, c, s) => {
    if (d.subject_type === "user") await requireEntity(s, EntityType.User, d.subject_id);
    else if (d.subject_type === "agent") await requireEntity(s, EntityType.Agent, d.subject_id);
    const granted_by = d.granted_by ?? await resolveUserId(s, { user_key: d.granted_by_key });
    const { granted_by_key: _k, ...rest } = d;
    return s.grantAclForCaller({ ...rest, granted_by }, c);
  }),
  [`${V3_PREFIX}/acl/revoke`]: bind(S.aclRevokeSchema, async (d, c, s) => {
    await s.revokeAclForCaller(d.id, c);
    return OK;
  }),
  [`${V3_PREFIX}/acl/list`]: bind(S.aclListSchema, (d, c, s) =>
    s.listAclByAssetForCaller(d.asset_id, c, resolvePagination(d)),
  ),
  [`${V3_PREFIX}/acl/check`]: bind(S.aclCheckSchema, async (d, _c, s) => {
    if (d.agent_id) await requireEntity(s, EntityType.Agent, d.agent_id);
    return s.checkAssetPermission(d);
  }),

  // Auth
  [`${V3_PREFIX}/auth/verify`]: bind(S.authVerifySchema, async (d, c, s) => s.verifyAuthForCaller(d.user_key, c)),

  // ConfigParam (v3.2)
  [`${V3_PREFIX}/instance-quota/get`]: bind(S.instanceQuotaGetSchema, async (_d, _c, s) => {
    return s.configParams.getInstanceQuotaLimits();
  }),
  [`${V3_PREFIX}/config/user/get`]: bind(S.configUserGetSchema, async (d, c, s) => {
    await requireEntity(s, EntityType.User, d.user_id);
    s.assertCallerIsOwner(d.user_id, c.userId!);
    return s.configParams.getUserConfigForCaller(d);
  }),
  [`${V3_PREFIX}/config/user/set`]: bind(S.configUserSetSchema, async (d, c, s) => {
    await requireEntity(s, EntityType.User, d.user_id);
    s.assertCallerIsOwner(d.user_id, c.userId!);
    return s.configParams.setUserConfigForCaller(d);
  }),

  // InstanceUpstreamConfig v2 (see docs/design/2026-08-25-instance-upstream-config.md §6)
  //
  // Depends on deps.getSupportedAgents(): reads upstream.supportedAgents from the Core gateway config.
  // Used for: the supported-agents endpoint echo; agents enum validation for B/C-class endpoints + seed data source.

  // §6.A supported-agents (provided by this module once mounted on Core)
  //
  // Also triggers seeding: this is the very first call the Panel makes on its first screen; the response body itself only returns supportedAgents,
  // but seeding along the way ensures that when the user then calls groups/list they can see the default row (lazy config = from the user's
  // perspective "every instance comes with a default").
  [`${V3_PREFIX}/upstream/supported-agents`]: bind(S.supportedAgentsSchema, async (_d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    const supported = deps.getSupportedAgents();
    await s.ensureDefaultSeeded(supported);
    return { items: supported };
  }),

  // §6.B groups/*
  [`${V3_PREFIX}/instance-upstream/groups/list`]: bind(S.upstreamGroupsListSchema, async (_d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.listInstanceUpstreamGroups(deps.getSupportedAgents());
  }),
  [`${V3_PREFIX}/instance-upstream/groups/create`]: bind(S.upstreamGroupsCreateSchema, async (d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.createInstanceUpstreamCustomGroup(d, deps.getSupportedAgents());
  }),
  [`${V3_PREFIX}/instance-upstream/groups/update`]: bind(S.upstreamGroupsUpdateSchema, async (d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.updateInstanceUpstreamGroup(d, deps.getSupportedAgents());
  }),
  [`${V3_PREFIX}/instance-upstream/groups/toggle`]: bind(S.upstreamGroupsToggleSchema, async (d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.toggleInstanceUpstreamGroup(d, deps.getSupportedAgents());
  }),
  [`${V3_PREFIX}/instance-upstream/groups/delete`]: bind(S.upstreamGroupsDeleteSchema, async (d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.deleteInstanceUpstreamGroup(d, deps.getSupportedAgents());
  }),

  // §6.C extraction/*
  //
  // All write paths pass supportedAgents as a safety net for existing instances whose first request is not list, to seed
  // (see §11.11f decision + docs/design 2026-08-25 §5.5 existing-instance fallback):
  // a Panel user may go straight to "create extraction" or "create custom", skipping list;
  // without seeding the default row, subsequent hermes/other agent requests would hit AGENT_NOT_CONFIGURED.
  // extraction/get does not write and has no seed need, so it keeps read-only semantics.
  [`${V3_PREFIX}/instance-upstream/extraction/get`]: bind(S.upstreamExtractionGetSchema, async (_d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.getInstanceUpstreamExtraction(deps.getSupportedAgents());
  }),
  [`${V3_PREFIX}/instance-upstream/extraction/create`]: bind(S.upstreamExtractionCreateSchema, async (d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.createInstanceUpstreamExtraction(d, deps.getSupportedAgents());
  }),
  [`${V3_PREFIX}/instance-upstream/extraction/update`]: bind(S.upstreamExtractionUpdateSchema, async (d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.updateInstanceUpstreamExtraction(d, deps.getSupportedAgents());
  }),
  [`${V3_PREFIX}/instance-upstream/extraction/toggle`]: bind(S.upstreamExtractionToggleSchema, async (d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.toggleInstanceUpstreamExtraction(d, deps.getSupportedAgents());
  }),
  [`${V3_PREFIX}/instance-upstream/extraction/delete`]: bind(S.upstreamExtractionDeleteSchema, async (_d, c, s, _reqId, deps) => {
    s.assertCanManageUsers(c);
    return s.deleteInstanceUpstreamExtraction(deps.getSupportedAgents());
  }),
};

/** Registered v3 route paths (for tests / docs). */
export const V3_ROUTES = Object.keys(routeTable);

/** MetadataError code → envelope code. */
function mapErrorCode(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  switch (code) {
    case "permission_denied":
    case "agent_team_mismatch":
    case "task_agent_not_linked":
      return 403;
    case "asset_not_bindable":
    case "duplicate_entry":
    case "duplicate_user_key":
    case "key_limit_exceeded":
    case "user_limit_exceeded":
    case "team_limit_exceeded":
    case "last_key_cannot_revoke":
    case "already_initialized":
    case "last_system_admin":
    case "member_already_exists":
      return 409;
    case "invalid_credentials":
    case "invalid_password":
      return 401;
    case "missing_instance_id":
    case "invalid_instance_id":
    case "missing_team_id":
    case "filter_not_allowed":
    case "invalid_user_ids":
      return 400;
    case "user_inactive":
      return 403;
    case "user_key_not_found":
      return 404;
    // ── v2 InstanceUpstream error codes (§6.E) ──
    case "GROUP_NOT_FOUND":
      return 404;
    case "EXTRACTION_ALREADY_CONFIGURED":
    case "WRITE_CONFLICT":
      return 409;
    case "PERMISSION_DENIED":
      return 403;
    case "AGENTS_OVERLAP":
    case "DUPLICATE_GROUP_NAME":
    case "INVALID_AGENTS":
    case "INVALID_MODE_FOR_GROUP_TYPE":
    case "MISSING_BASE_URL":
    case "MISSING_API_KEY":
    case "MISSING_GROUP_NAME":
    case "DEFAULT_GROUP_IMMUTABLE_FIELDS":
    case "CANNOT_DELETE_DEFAULT":
    case "USE_EXTRACTION_ENDPOINT":
    case "EXTRACTION_NOT_CONFIGURED":
    case "CANNOT_CREATE_DEFAULT":
    case "GROUP_TYPE_MISMATCH":
      return 400;
    default:
      return 400;
  }
}

/**
 * v3 route dispatch. Returns true on a hit (already responded); returns false for non-/v3/meta or non-POST (handed back to the upper layer).
 */
export async function handleV3MetaRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: V3MetaRouterDeps,
): Promise<boolean> {
  if (!pathname.startsWith(V3_PREFIX) || method !== "POST") return false;
  const handler = routeTable[pathname];
  if (!handler) return false;

  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);
  const traceCtx = createMetaApiTraceContext({ route: pathname, requestId });

  let instanceId: string;
  try {
    instanceId = extractInstanceId(req.headers);
    traceCtx.instanceId = instanceId;
  } catch (err) {
    if (err instanceof MetadataError) {
      const code = mapErrorCode(err.code);
      const message = `${err.code}: ${err.message}`;
      logMetaApiRejected(traceCtx, { httpStatus: code, envelopeCode: code, message });
      sendJson(res, code, errorEnvelope(code, message, requestId));
      return true;
    }
    throw err;
  }

  const svc = await Promise.resolve(deps.getMetadataService(instanceId));
  if (!svc) {
    logMetaApiRejected(traceCtx, {
      httpStatus: 503,
      envelopeCode: 503,
      message: "MetadataService not available",
    });
    sendJson(res, 503, errorEnvelope(503, "MetadataService not available", requestId));
    return true;
  }

  // Auth: V3_NO_USER_KEY_ROUTES
  let ctx: Ctx;
  const headerUserKey = extractUserKeyHeader(req.headers);
  if (V3_NO_USER_KEY_ROUTES.has(pathname)) {
    ctx = { token: "", isAdmin: false, isSystemAdmin: false };
  } else {
    if (!headerUserKey) {
      logMetaApiRejected(traceCtx, {
        httpStatus: 401,
        envelopeCode: 401,
        message: "unauthorized: missing_user_key",
      });
      sendJson(res, 401, errorEnvelope(401, "unauthorized: missing_user_key", requestId));
      return true;
    }
    const auth = await authenticateV3(headerUserKey, svc);
    if (!auth.ok || !auth.ctx) {
      const status = auth.status ?? 401;
      const message = `unauthorized: ${auth.reason}`;
      logMetaApiRejected(traceCtx, { httpStatus: status, envelopeCode: status, message });
      sendJson(res, status, errorEnvelope(status, message, requestId));
      return true;
    }
    ctx = auth.ctx;
    traceCtx.userId = ctx.userId;
  }

  try {
    const body = await parseJsonBody(req);
    const traceModule = getApiTraceConfig().policy.module;
    await runWithApiRequestContext(
      {
        requestId,
        route: pathname,
        module: traceModule,
        instanceId,
        userId: ctx.userId,
      },
      async () => {
        logMetaApiEntry(traceCtx, body);
        deps.logger.debug?.(`${TAG} ${pathname} instance=${instanceId} user=${ctx.userId ?? "(admin)"}`);
        const runtime: V3MetaRouterRuntimeDeps = {
          getSupportedAgents: deps.getSupportedAgents,
        };
        const envelope = await handler(body, ctx, svc, requestId, runtime);
        const httpStatus = envelope.code === 0 ? 200 : envelope.code >= 400 && envelope.code < 600 ? envelope.code : 200;
        logMetaApiResponse(traceCtx, envelope, httpStatus);
        sendJson(res, httpStatus, envelope);
      },
    );
  } catch (err) {
    if (err instanceof MetadataError) {
      const code = mapErrorCode(err.code);
      const message = `${err.code}: ${err.message}`;
      deps.logger.warn?.(`${TAG} [${pathname}] ${message}`);
      logMetaApiError(traceCtx, err, { envelopeCode: code, httpStatus: code });
      // detail (e.g. conflict_groups of AGENTS_OVERLAP) is carried into envelope.data for the frontend to render
      sendJson(res, code, errorEnvelope(code, message, requestId, err.detail));
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error?.(`${TAG} [${pathname}] unexpected: ${msg}`);
      logMetaApiError(traceCtx, err, { envelopeCode: 500, httpStatus: 500 });
      sendJson(res, 500, errorEnvelope(500, "internal_error", requestId));
    }
  }
  return true;
}
