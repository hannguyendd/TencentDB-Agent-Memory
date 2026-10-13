/**
 * Business orchestration for **importing** Task external sources.
 *
 *   - Import: fetch details one by one -> createTask (source_type + source_url persisted) -> split into created/failed
 *     -> "participating Users" only sync the TAPD handlers (not the importer; skipped if no account is found)
 *
 * Import is a **one-time snapshot**: there is no "sync remote changes" (no scheduled sync, no manual sync from the drawer page).
 * Later remote changes do not flow back -- which is exactly why no credentials need to be stored.
 * It only makes use of the existing source_type / source_url; no new columns or tables.
 */

import type { MetadataService } from "../metadata/service/metadata-service.js";
import type { V3AuthContext } from "../metadata/router/auth.js";
import type { TaskEntity } from "../metadata/types.js";
import { TaskSourceError, type SourceCredential } from "./types.js";
import { TaskSourceRegistry } from "./registry.js";

/** Locator triple stored in metadata_json.external. */
export interface ExternalRef {
  provider: string;
  item_type: string;
  external_id: string;
  scope: string;
}

export interface ImportItem {
  external_id: string;
  item_type: string;
  scope: string;
}

export interface ImportResult {
  created: Array<{ external_id: string; task_id: string }>;
  failed: Array<{ external_id: string; error: string }>;
}

/**
 * Sentinel agent_id value used by participation records produced by import.
 *
 * participation_log's agent_id is required (appendParticipationLog internally calls
 * assertParticipationContext -> getAgentById, which throws agent_not_found if it does not exist),
 * while the import scenario has no real agent, so a fixed sentinel value must be used.
 *
 * **Contains no specific source name**: all sources share this one. If it were split per source into `tapd-import` /
 * `jira-import`, every new source would need another fake agent record and a synchronized frontend filter list --
 * the source identity should be read from the participation record's metadata (which records the provider), not encoded into agent_id.
 *
 * WARNING: this sentinel must **really exist** in meta_agents, otherwise every participation record is rejected.
 * It is now idempotently ensured by ensureImportAgent() at import time.
 */
export const IMPORT_AGENT_ID = "external-import";

/**
 * The order of auth_provider values tried when looking up an account name.
 *
 * Empirically, the same TAPD account may live in different auth realms (e.g. local / api_key),
 * and querying a single realm would miss it. The order is "most common external mapping realm -> local realm".
 */
const USERNAME_LOOKUP_PROVIDERS = ["api_key", "local", "woa"] as const;

export class TaskSourceImportService {
  constructor(private readonly svc: MetadataService) {}

  /**
   * Ensure the sentinel agent exists in meta_agents (idempotent).
   *
   * appendParticipationLog validates that the record for agent_id exists, and throws
   * `agent_not_found` if missing -- while the import scenario has no real agent, so a sentinel record must be created itself.
   * This goes directly through store.createAgent (bypassing createAgentForCaller's "member permission +
   * owner themselves" checks): the sentinel is a system-level bookkeeping entity that belongs to nobody's assets.
   *
   * Failure does not block import, but **must not be silent**: a silent catch once let "participating Users all empty"
   * go unnoticed for several rounds; a warn trail must be left.
   */
  async ensureImportAgent(teamId: string, ownerUserId: string): Promise<void> {
    try {
      // meta_agents.owner_user_id is NOT NULL; the import path has ensured ctx.userId has a value
      // (createTaskForCaller uses it as the creator); if it can't be obtained, better not to create than to write dirty data.
      if (!ownerUserId) {
        console.warn("[task-source] ensureImportAgent skipped: missing owner user id");
        return;
      }
      const existing = await this.svc.rawStore.getAgentById(IMPORT_AGENT_ID);
      if (existing) return;
      await this.svc.rawStore.createAgent({
        agent_id: IMPORT_AGENT_ID,
        team_id: teamId,
        owner_user_id: ownerUserId,
        name: "External task import",
        description: "Owner of the participation records produced by bulk import from third-party requirement systems (TAPD)",
        visibility: "team",
        status: "active",
      });
    } catch (err) {
      console.warn(
        `[task-source] ensureImportAgent failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Account name -> user_id.
   *
   * auth_provider is unknown (empirically the same account may live in different realms such as local / api_key),
   * so candidate providers are tried in order and the first hit is returned; returns null if not found --
   * **no automatic profile creation**: a TAPD handler may be an account outside the team (empirically aleronwang is not in
   * the user table), and auto-creating would conjure unauthenticated accounts out of thin air.
   */
  private async lookupUserIdByUsername(username: string): Promise<string | null> {
    const store = this.svc.rawStore;
    for (const provider of USERNAME_LOOKUP_PROVIDERS) {
      try {
        const user = await store.getUserByUsername(provider, username);
        if (user?.user_id) return user.user_id;
      } catch {
        // Try each provider in turn; continue on failure.
      }
    }
    return null;
  }

  /**
   * Batch import.
   *
   * A single failure does not block the rest (per-item try/catch routing) -- this is the core promise of "batch":
   * the failure of item N must not roll back earlier successes or fail the whole batch.
   */
  async import(
    providerId: string,
    teamId: string,
    items: ImportItem[],
    cred: SourceCredential,
    ctx: V3AuthContext,
  ): Promise<ImportResult> {
    await this.svc.assertExternalTaskImportAllowed(teamId, ctx);

    const provider = TaskSourceRegistry.get(providerId);
    if (items.length > provider.maxBatchSize) {
      throw new TaskSourceError(
        "batch_too_large",
        `batch size ${items.length} exceeds limit ${provider.maxBatchSize}`,
      );
    }
    const tctx = TaskSourceRegistry.contextFor(providerId, cred);
    // Participation records hang under the sentinel agent, and appendParticipationLog validates that this agent exists --
    // it must be created before writing, otherwise every item is rejected with agent_not_found.
    await this.ensureImportAgent(teamId, ctx.userId ?? "");

    const result: ImportResult = { created: [], failed: [] };
    for (const item of items) {
      try {
        const detail = await provider.fetchTask(tctx, item.external_id, item.scope, item.item_type);
        const task = await this.svc.createTaskForCaller(
          {
            team_id: teamId,
            creator_user_id: ctx.userId,
            title: detail.title || "(Untitled)",
            description: detail.body || null,
            /**
             * source_type only expresses the **broad category** and does not encode the specific source --
             * the specific source is always read from metadata_json.external.provider (see metadata_json below).
             *
             * If every source were stuffed into the TaskSourceType enum, adding a source would require changing the type definition +
             * everything that references it (types / schemas / gateway generated artifacts / frontend),
             * pinning the abstraction to a "list of known sources"; with a broad category, adding a source needs zero changes.
             */
            source_type: "external",
            source_url: detail.url ?? null,
            metadata_json: JSON.stringify({
              external: {
                provider: providerId,
                item_type: item.item_type,
                external_id: item.external_id,
                scope: item.scope,
              } satisfies ExternalRef,
            }),
          },
          ctx,
        );
        // "Participating Users" only sync the TAPD handlers (**not the importer**):
        // the handler is the item's actual owner; the importer is merely a carrier and should not be recorded as a participant.
        // If the account name has no matching user_id, skip it (no auto profile creation, no blocking the import).
        if (detail.owner) {
          const ownerId = await this.lookupUserIdByUsername(detail.owner);
          if (ownerId) {
            try {
              await this.svc.appendParticipationLog({
                team_id: teamId,
                task_id: task.task_id,
                agent_id: IMPORT_AGENT_ID,
                user_id: ownerId,
                source: "task-import",
                metadata_json: JSON.stringify({ provider: providerId }),
              });
            } catch (err) {
              // A participation record failure does not affect the import itself, but **must not be silent** (historical lesson).
              console.warn(
                `[task-source] appendParticipationLog failed (task=${task.task_id}, user=${ownerId}): ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        result.created.push({ external_id: item.external_id, task_id: task.task_id });
      } catch (err) {
        // No dedup: there is no unique index on source_url in the DB, so the same item can be imported repeatedly.
        // Hence there is also no "already imported -> skipped" branch; failures always go to failed.
        result.failed.push({ external_id: item.external_id, error: messageOf(err) });
      }
    }
    return result;
  }

}

/** Read the locator triple from metadata_json.external; returns null if missing or invalid. */
export function readExternalRef(task: TaskEntity): ExternalRef | null {
  if (!task.metadata_json) return null;
  try {
    const parsed = JSON.parse(task.metadata_json) as { external?: Partial<ExternalRef> };
    const e = parsed?.external;
    if (!e?.provider || !e?.external_id || !e?.item_type) return null;
    return {
      provider: e.provider,
      item_type: e.item_type,
      external_id: e.external_id,
      scope: e.scope ?? "",
    };
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
