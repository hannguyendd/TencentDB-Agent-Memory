/**
 * Entity reference existence validation utility.
 *
 * Lets v3-meta-router handlers verify, before the business call, that input prefixed metadata IDs
 * exist in the store; if not, throws MetadataError (→ 404).
 *
 * Usage:
 *   await requireEntity(svc, EntityType.User, d.user_id);
 */

import { MetadataService, MetadataError } from "../service/metadata-service.js";

/** Enum of metadata entity types, used by requireEntity calls. */
export const enum EntityType {
  User = "user",
  Team = "team",
  Agent = "agent",
  Task = "task",
  Asset = "asset",
  UserKey = "userKey",
  Acl = "acl",
}

const LOOKUP: Record<EntityType, (svc: MetadataService, id: string) => Promise<unknown>> = {
  [EntityType.User]: (svc, id) => svc.getUserById(id),
  [EntityType.Team]: (svc, id) => svc.getTeamById(id),
  [EntityType.Agent]: (svc, id) => svc.getAgentById(id),
  [EntityType.Task]: (svc, id) => svc.getTaskById(id),
  [EntityType.Asset]: (svc, id) => svc.getAssetById(id),
  [EntityType.UserKey]: (svc, id) => svc.rawStore.getUserKeyById(id),
  [EntityType.Acl]: (svc, id) => svc.rawStore.getAclById(id),
};

const ERROR_CODE: Record<EntityType, string> = {
  [EntityType.User]: "user_not_found",
  [EntityType.Team]: "team_not_found",
  [EntityType.Agent]: "agent_not_found",
  [EntityType.Task]: "task_not_found",
  [EntityType.Asset]: "asset_not_found",
  [EntityType.UserKey]: "user_key_not_found",
  [EntityType.Acl]: "acl_not_found",
};

/**
 * Validate that a single entity ID exists; if not, throw MetadataError (mapped to 404).
 *
 * @param svc  MetadataService of the current instance
 * @param type entity type enum
 * @param id   prefixed entity ID
 */
export async function requireEntity(
  svc: MetadataService,
  type: EntityType,
  id: string,
): Promise<void> {
  const entity = await LOOKUP[type](svc, id);
  if (!entity) {
    throw new MetadataError(ERROR_CODE[type], `not found: ${id}`);
  }
}
