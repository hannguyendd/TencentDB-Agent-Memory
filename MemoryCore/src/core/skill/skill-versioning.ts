/**
 * skill-versioning — transactional orchestration of version increments
 *
 * Wraps skill-store's `appendVersion` and storage's `copyTree` into an "append a new version" primitive.
 * Simplifies the implementation of the 6 manage actions for SkillCore (Phase 6).
 *
 * A full "add a version" action:
 *   1. Get the head (if any)
 *   2. Validate: owner / version / whether the content changed
 *   3. storage copies the head's version directory to the new version directory (if there is a head)
 *   4. Apply this run's resource changes (write/remove) on the new version directory
 *   5. store.appendVersion writes the DB (inside a transaction)
 *   6. On failure, try to clean up the already-written storage copy (best-effort)
 */

import { createHash } from "node:crypto";

import type { ISkillStore } from "./skill-store.interface.js";
import { IdempotentNoOpError, SkillStoreError } from "./skill-store.interface.js";
import { SkillResourceStore, SkillResourceError, type SkillResourcePayload } from "./skill-resource-store.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { SkillManifestEntry, Skill } from "./types.js";

function computeContentHash(content: string): string {
  return createHash("md5").update(content, "utf-8").digest("hex");
}

export interface AppendVersionContext {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
}

export interface AppendVersionMutation {
  /** Full text of SKILL.md (including frontmatter). Required by all write paths (hash check for idempotency). */
  content: string;
  /** name / description extracted from the parsed frontmatter. */
  name: string;
  description: string;
  /** Resource changes: files added / overwritten in this run. */
  resourcesToWrite?: SkillResourcePayload[];
  /** Resource changes: relative paths deleted in this run. */
  resourcesToRemove?: string[];
  /** Optional: override metadata_json directly (default keeps the previous version's). */
  metadata_json?: string;
}

export interface SkillVersioningOptions {
  store: ISkillStore;
  resources: SkillResourceStore;
  storage: StorageAdapter;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /**
   * VDB count change callback (for reporting usage to Shark).
   * Fired after each successful store.appendVersion / store.deleteVersion.
   * @param delta +1 means one VDB document was added, -N means N were deleted.
   */
  onSkillVdbChanged?: (delta: number) => void;
  /**
   * Asset registration hook on v1 creation.
   *
   * Contract:
   *  - `await`ed before the storage and DB writes (up-front consistency protection)
   *  - throwing = createNewSkill fails, and neither storage nor the DB is written
   *  - the upper-level implementation must be idempotent (multiple calls for the same skill_id should succeed with no side effects)
   *  - triggered only by `createNewSkill`; neither `appendNextVersion` nor TTL cleanup triggers it
   *    (assets are unrelated to versions and recognize only skill_id)
   */
  onSkillCreated?: (params: {
    skill_id: string;
    team_id?: string;
    agent_id?: string;
    user_id?: string;
    name: string;
    description: string;
  }) => Promise<void>;
}

export class SkillVersioning {
  private readonly store: ISkillStore;
  private readonly resources: SkillResourceStore;
  private readonly storage: StorageAdapter;
  private readonly logger?: SkillVersioningOptions["logger"];
  private readonly onSkillVdbChanged?: (delta: number) => void;
  private readonly onSkillCreated?: SkillVersioningOptions["onSkillCreated"];

  constructor(opts: SkillVersioningOptions) {
    this.store = opts.store;
    this.resources = opts.resources;
    this.storage = opts.storage;
    this.logger = opts.logger;
    this.onSkillVdbChanged = opts.onSkillVdbChanged;
    this.onSkillCreated = opts.onSkillCreated;
  }

  /**
   * Create v1 of a brand-new skill. The head does not exist; the caller is responsible for generating the skill_id.
   *
   * Cross-system "transaction" orchestration (COS + skill DB + meta_assets):
   *
   *   1. writeResource → COS               ← least reliable, do it first; failure has zero DB side effects
   *   2. store.appendVersion → skill DB    ← on failure: reverse-clean COS (cleanupVersionDir)
   *   3. onSkillCreated → meta_assets      ← on failure: reverse-delete the skill DB (deleteSkill) + clean COS
   *
   * Why this order: there is no real transaction across 3 systems, only "ordering + compensation". The principle is
   * **do the most failure-prone first, do the zero-side-effect-on-failure first, and finish with the reliable**. COS is the most fragile (network/
   * auth/permissions), the skill DB is a local transaction that almost never fails, and the asset involves agent lookup/team
   * validation/multi-table writes but is also a local DB. The original implementation "write asset first" violated this principle: there was once
   * an orphan state where COS auth failed → the skill was not persisted → yet the asset table already had a row.
   *
   * Extreme cases (rollback of steps 2/3 also fails):
   *   - an orphan skill (skill persisted but asset missing) is self-healed by `onSkillAccessed` on read,
   *     and the user's next get/readFile will fill it in. The loop is closed.
   *   - an orphan COS file only takes up space; the read path all goes through the DB, so it is never read by mistake.
   */
  async createNewSkill(
    skillId: string,
    ownerAgentId: string,
    ctx: AppendVersionContext,
    mut: AppendVersionMutation,
  ): Promise<Skill> {
    const newVersion = 1;
    const storageDir = this.resources.versionDir(skillId, newVersion);

    // Aggregate total-size validation for the whole skill (design §3.5.1: ≤ 50MB) — pure computation, zero side effects.
    if (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) {
      this.resources.assertTotalSize([], mut.resourcesToWrite, []);
    }

    // ── Step 1: write COS (do the most fragile step first; failure has zero side effects) ─────────────────────
    let manifest: SkillManifestEntry[] = [];
    if (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) {
      try {
        for (const p of mut.resourcesToWrite) {
          const entry = await this.resources.writeResource(skillId, newVersion, p);
          manifest.push(entry);
        }
      } catch (e) {
        // some files may already be written; best-effort clean up the whole version directory
        await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
        throw e;
      }
    }

    // ── Step 2: write the skill DB (local transaction, almost never fails; on failure reverse-clean COS) ────
    let row: Skill;
    try {
      row = await this.store.appendVersion({
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        task_id: ctx.task_id,
        skill_id: skillId,
        name: mut.name,
        description: mut.description,
        content: mut.content,
        content_hash: computeContentHash(mut.content),
        manifest,
        storage_dir: storageDir,
        owner_agent_id: ownerAgentId,
        metadata_json: mut.metadata_json,
      });
    } catch (e) {
      await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
      throw e;
    }

    // ── Step 3: register meta_assets (agent/team validation + createAsset + bind) ──
    //  failure → reverse-delete the skill DB (deleteSkill) → reverse-clean COS → throw back the business error.
    //  onSkillCreated not injected (e.g. tdai-core did not attach the hook) → skip directly.
    if (this.onSkillCreated) {
      try {
        await this.onSkillCreated({
          skill_id: skillId,
          team_id: ctx.team_id,
          agent_id: ctx.agent_id,
          user_id: ctx.user_id,
          name: mut.name,
          description: mut.description,
        });
      } catch (assetErr) {
        // reverse-delete the skill DB. deleteSkill itself may also fail (DB down),
        // but with very low probability; even if it fails, onSkillAccessed self-healing on read can converge the orphan skill.
        // reportVdbDelta=false: the +1 was never reported (it is reported only after step 3), and if rollback
        // reported -1 it would make shark's accounting go negative.
        try {
          await this.deleteSkill(skillId, ctx.team_id, { reportVdbDelta: false });
        } catch (rollbackErr) {
          this.logger?.error(
            `[skill-tx] rollback deleteSkill failed for ${skillId} (team=${ctx.team_id ?? "-"}): ` +
              (rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)),
          );
        }
        // The COS directory was already cleaned inside deleteSkill (listVersions → rmdir), so not repeated here.
        // But if deleteSkill did not reach the storage cleanup because the DB was down, clean it once more as a safety net.
        await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
        throw assetErr;
      }
    }

    // all system writes succeeded → report the VDB delta
    this.onSkillVdbChanged?.(1);
    return row;
  }

  /**
   * Append a new version on top of an existing head. The head must exist (the caller first calls store.getHead to get it).
   *
   * Content unchanged (same content_hash) and no resource changes → return head (idempotent, no storage / DB write).
   */
  async appendNextVersion(
    head: Skill,
    ctx: AppendVersionContext,
    mut: AppendVersionMutation,
  ): Promise<Skill> {
    const newVersion = head.version + 1;
    const newStorageDir = this.resources.versionDir(head.skill_id, newVersion);
    const oldStorageDir = head.storage_dir;
    const newContentHash = computeContentHash(mut.content);

    const noContentChange = newContentHash === head.content_hash;
    const noResourceChange =
      (!mut.resourcesToWrite || mut.resourcesToWrite.length === 0) &&
      (!mut.resourcesToRemove || mut.resourcesToRemove.length === 0);

    if (noContentChange && noResourceChange) {
      return head; // idempotent
    }

    // Aggregate total-size validation for the whole skill (design §3.5.1: ≤ 50MB).
    if (
      (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) ||
      (mut.resourcesToRemove && mut.resourcesToRemove.length > 0)
    ) {
      this.resources.assertTotalSize(
        head.manifest,
        mut.resourcesToWrite,
        mut.resourcesToRemove,
      );
    }

    // 1) copy the old version directory to the new version directory (if the old version has content)
    try {
      await this.storage.copyTree(oldStorageDir, newStorageDir);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // if the old version has no directory at all (the old skill was created without resources), skip the copy
      if (!/STORAGE_NOT_FOUND/.test(msg)) {
        throw e;
      }
    }

    // 2) apply the resource changes on the new version directory
    let manifest: SkillManifestEntry[] = [...head.manifest];
    try {
      if (mut.resourcesToRemove) {
        for (const p of mut.resourcesToRemove) {
          await this.resources.removeResource(head.skill_id, newVersion, p);
          manifest = manifest.filter((m) => m.path !== p);
        }
      }
      if (mut.resourcesToWrite) {
        for (const p of mut.resourcesToWrite) {
          const entry = await this.resources.writeResource(head.skill_id, newVersion, p);
          // merge into the manifest (overwriting the same path)
          manifest = manifest.filter((m) => m.path !== entry.path);
          manifest.push(entry);
        }
      }
    } catch (e) {
      await this.cleanupVersionDir(newStorageDir).catch(() => { /* ignore */ });
      throw e;
    }

    // 3) write the DB (inside a transaction + fts sync)
    try {
      const row = await this.store.appendVersion({
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        task_id: ctx.task_id,
        skill_id: head.skill_id,
        name: mut.name,
        description: mut.description,
        content: mut.content,
        content_hash: newContentHash,
        manifest,
        storage_dir: newStorageDir,
        owner_agent_id: head.owner_agent_id,
        metadata_json: mut.metadata_json ?? head.metadata_json,
      });
      this.onSkillVdbChanged?.(1);
      return row;
    } catch (e) {
      // DB failure → clean up the newly copied directory
      // Note: store.appendVersion no longer does hash idempotency (handled by this class's early short-circuit),
      // so it will not throw IdempotentNoOpError; the type is still exported so external code only needs to import from one place.
      await this.cleanupVersionDir(newStorageDir).catch(() => { /* ignore */ });
      throw e;
    }
  }

  // ─────────────────────────────────────────────────
  //  helpers
  // ─────────────────────────────────────────────────

  private async cleanupVersionDir(dir: string): Promise<void> {
    if (!dir) return;
    try { await this.storage.rmdir(dir); } catch { /* ignore */ }
  }

  // ─────────────────────────────────────────────────
  //  True delete: delete all versions of a skill at once (including storage and shark reporting)
  // ─────────────────────────────────────────────────

  /**
   * Physically delete a whole skill (including all version rows + the storage directory of each version).
   *
   * Orchestration semantics:
   *   1. first listVersions to get the storage_dir of all versions (the DB is the authoritative source; read before deleting)
   *   2. store.deleteAllVersions — DELETE all version rows at once + clear fts / vec
   *   3. rmdir storage version by version (failure only warns, no DB rollback)
   *   4. report `onSkillVdbChanged(-N)` once in aggregate (N = the number of rows actually deleted)
   *      — unlike the TTL path which does `onSkillVdbChanged(-1)` row by row, delete reports as a whole block,
   *      reducing shark HTTP requests; semantically both accumulate shark MemoryDelta.
   *
   * Returns the number of rows actually deleted. Returns 0 when the skill does not exist and does not trigger reporting (to avoid false reports).
   *
   * Permission checks (team_id / owner / expected_version) are done by the caller SkillCore.delete.
   * This method does no business-rule validation and only does physical cleanup by (skill_id, team_id).
   */
  async deleteSkill(
    skillId: string,
    teamId?: string,
    opts?: {
      /**
       * Whether to report the VDB delta. Default true (normal delete path).
       * The rollback path of createNewSkill should pass false — because the corresponding +1 was never reported
       * (the +1 is sent only after all three steps of create are green), and reporting -N again in rollback would make
       * shark's accounting go negative.
       */
      reportVdbDelta?: boolean;
    },
  ): Promise<number> {
    const reportDelta = opts?.reportVdbDelta ?? true;

    // 1. first pull the metadata of all versions (to get storage_dir). listVersions has a cap of 1000,
    //    and the version count of a single skill is far below this value under TTL protection + business caps.
    const versions = await this.store.listVersions(skillId, teamId, { limit: 1000, offset: 0 });

    // 2. physically delete the DB rows
    const deleted = await this.store.deleteAllVersions(skillId, teamId);
    if (deleted <= 0) {
      // nothing was deleted (skill does not exist / team mismatch) → do not report, do not clean storage
      return 0;
    }

    // 3. clean the storage directories (failure only warns) — use the dir obtained from listVersions,
    //    rather than assembling the path, tolerating inconsistent storage_dir naming of historical versions.
    for (const v of versions) {
      if (!v.storage_dir) continue;
      try {
        await this.storage.rmdir(v.storage_dir);
      } catch {
        this.logger?.warn(`[skill-delete] storage rmdir failed for ${v.storage_dir}`);
      }
    }

    // 4. report to shark once (-N); not reported on the rollback path (see the opts comment)
    if (reportDelta) {
      this.onSkillVdbChanged?.(-deleted);
    }

    return deleted;
  }

  // ─────────────────────────────────────────────────
  //  Version cleanup: clean up excess/expired old versions after writes
  // ─────────────────────────────────────────────────

  private static readonly KEEP_RECENT = 3;

  /**
   * Max number of version rows a single cleanup can handle (= the hard cap of the store.listVersions backend).
   * Once a single skill has more than 1000 versions, the oldest versions beyond 1000 cannot be seen or deleted this time,
   * and must converge in batches over the next few write paths. In production the measured top-3 version counts are < 200, which is enough.
   */
  private static readonly LIST_LIMIT = 1000;

  /**
   * Clean up old versions of the given skill (delete DB rows first, then storage directories).
   * Called fire-and-forget, does not throw.
   *
   * Two dimensions, taking the union (whichever is stricter takes effect):
   *  - Time (ttlSeconds > 0): non-head versions with created_at < now - ttlSeconds are deleted;
   *    the most recent KEEP_RECENT non-head versions are guaranteed (not deleted even if expired), to prevent
   *    just-written historical versions from being cleaned immediately under frequent writes.
   *  - Count (maxNonHeadVersions > 0): when the number of non-head versions exceeds N, delete the oldest
   *    excess. Note the count dimension is **not protected by KEEP_RECENT** — it already guarantees
   *    "keep the newest N", and stacking KEEP_RECENT would make small N values ineffective.
   *  - Both 0: return early and do nothing (default behavior, backward compatible).
   *
   * The head is never deleted (all three backends' deleteVersion hardcode is_head=0);
   * archived skills are skipped as a whole group.
   */
  async cleanupExpiredVersionsForSkill(
    skillId: string,
    ttlSeconds: number,
    maxNonHeadVersions = 0,
    now?: number,
  ): Promise<void> {
    if (ttlSeconds <= 0 && maxNonHeadVersions <= 0) return;

    // ⚠️ A large limit must be passed explicitly: listVersions' backend default is 50; omitting limit would cause
    // skills with more than 50 versions to never converge to the real cap (silently ineffective, no error).
    // 1000 is the hard cap of the three backends (Math.min(..., 1000)), aligned with the existing approach at deleteSkill:350.
    const all = await this.store.listVersions(
      skillId,
      undefined,
      { limit: SkillVersioning.LIST_LIMIT, offset: 0 },
    );
    if (!all.length) return;

    // archived skills are protected as a whole group
    const head = all.find((v) => v.is_head);
    if (!head || head.status === "archived") return;

    // version DESC — newest first
    const sorted = [...all].sort((a, b) => b.version - a.version);
    const nonHeadSorted = sorted.filter((v) => !v.is_head);

    // collect the version numbers to delete for each of the two dimensions, then take the union.
    const toDelete = new Set<number>();

    // ── Count dimension ──
    if (maxNonHeadVersions > 0 && nonHeadSorted.length > maxNonHeadVersions) {
      for (const v of nonHeadSorted.slice(maxNonHeadVersions)) {
        toDelete.add(v.version);
      }
    }

    // ── Time dimension ──
    if (ttlSeconds > 0) {
      const nowMs = now ?? Date.now();
      const cutoffMs = nowMs - ttlSeconds * 1000;
      // KEEP_RECENT protects the most recent N non-head versions (even if expired)
      const protectedVersions = new Set(
        nonHeadSorted.slice(0, SkillVersioning.KEEP_RECENT).map((v) => v.version),
      );
      for (const v of nonHeadSorted) {
        if (protectedVersions.has(v.version)) continue;
        if (v.created_at_ms >= cutoffMs) continue;
        toDelete.add(v.version);
      }
    }

    if (toDelete.size === 0) return;

    // union delete (look up metadata by version number's position in nonHeadSorted to get storage_dir)
    const metaByVersion = new Map(nonHeadSorted.map((v) => [v.version, v]));
    for (const version of toDelete) {
      const v = metaByVersion.get(version);
      if (!v) continue;

      // delete the DB rows first (the data source), then the storage directories (the appendage)
      const deleted = await this.store.deleteVersion(v.skill_id, version);
      if (!deleted) continue;

      // report the VDB deletion (negative value)
      this.onSkillVdbChanged?.(-1);

      // storage deletion failure is only logged and does not affect the correctness of the DB
      try {
        await this.storage.rmdir(v.storage_dir);
      } catch {
        this.logger?.warn(`[skill-ttl] storage rmdir failed for ${v.storage_dir}`);
      }
    }
  }

}

// re-export the error type so upper layers only need to import from one place
export { IdempotentNoOpError, SkillStoreError, SkillResourceError };
