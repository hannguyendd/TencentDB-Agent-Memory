/**
 * SkillCore — orchestration facade for the 6 manage actions
 *
 * Orchestration logic:
 *   1. Parse + validate SKILL.md (frontmatter)
 *   2. Get the head (if any)
 *   3. assertTeamMatch / assertOwner / assertVersionFresh
 *   4. Call SkillVersioning.appendNextVersion / createNewSkill
 *
 * 6 write actions:
 *   - create        create a new skill v1
 *   - update        replace SKILL.md
 *   - patch         single-point string replacement
 *   - delete        head status=archived
 *   - writeFiles    add/modify resources
 *   - removeFiles   delete resources
 *
 * 4 read actions:
 *   - get           return the detail (default head; a version can be specified)
 *   - list          return head rows by team_id + filters
 *   - search        FTS hits
 *   - listVersions  historical version metadata
 *   - readFile      read resource bytes
 */

import { parseSkillFile, validateSkillFile } from "./skill-format.js";
import { SkillResourceStore, type SkillResourcePayload } from "./skill-resource-store.js";
import type { ISkillStore, SkillSearchResult } from "./skill-store.interface.js";
import { SkillVersioning } from "./skill-versioning.js";
import { randomBase62 } from "../../utils/short-id.js";
import { strToU8, zipSync } from "fflate";
import {
  SkillPermissionError,
  assertOwner,
  assertTeamMatch,
  assertVersionFresh,
} from "./skill-permission.js";
import type {
  IdFields,
  ListSkillsOptions,
  SearchSkillsOptions,
  SkillStatus,
  Skill,
  SkillSimilarityResult,
  SkillProposeResult,
} from "./types.js";


const TAG = "[skill-core]";

// ═════════════════════════════════════════════════════════════════════
//  Error types (used by the gateway to map HTTP error codes)
// ═════════════════════════════════════════════════════════════════════


export type SkillCoreErrorCode =
  | "INVALID_FRONTMATTER"
  | "SKILL_FRONTMATTER_INVALID"
  | "SKILL_PATCH_NOT_UNIQUE"
  | "SKILL_NAME_DUPLICATE"
  | "SKILL_NOT_OWNER"
  | "SKILL_TEAM_MISMATCH"
  | "SKILL_NOT_FOUND"
  | "SKILL_VERSION_STALE"
  | "SKILL_VERSION_EXPIRED"
  | "SKILL_ID_COLLISION"
  | "INVALID_PATH"
  | "RESOURCE_TOO_LARGE"
  | "STORAGE_NOT_FOUND"
  | "LLM_UNAVAILABLE"
  | "SKILL_COS_REQUIRED"
  | "SKILL_EXPORT_TOO_LARGE";

export class SkillCoreError extends Error {
  constructor(public readonly code: SkillCoreErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillCoreError";
  }
}

// Utility: uniformly translate the various errors thrown from lower layers into SkillCoreError (keeping the original message)
function toCoreError(e: unknown): never {
  if (e instanceof SkillCoreError) throw e;
  const code = (e as { code?: string }).code as SkillCoreErrorCode | undefined;
  const msg = (e as Error).message;
  if (code) {
    throw new SkillCoreError(code, msg);
  }
  throw e as Error;
}

// ═════════════════════════════════════════════════════════════════════
//  Options
// ═════════════════════════════════════════════════════════════════════

export interface SkillCoreOptions {
  store: ISkillStore;
  resources: SkillResourceStore;
  versioning: SkillVersioning;
  /**
   * Used for skill_id generation. Default `skl-` + 12-character base62 (CSPRNG, 71 bits of true entropy).
   * Keeps the same length as the old sid (16 characters), only the character set is widened from base36 to base62 and a true random source is used.
   * Tests can inject a fixed value.
   */
  ulid?: () => string;
  /** Injection of Date.now. Default Date.now. */
  now?: () => number;
  /** TTL in seconds for old versions. 0 = disabled. */
  versionTtlSeconds?: number;
  /** Max number of non-head versions retained per skill. 0 = disabled. */
  maxNonHeadVersions?: number;
  /**
   * Fired synchronously after `delete` successfully archives the head. fire-and-forget: exceptions thrown by the hook
   * are swallowed and do not affect delete's return value (asset state drift is tolerable: the skill is already
   * archived, and the asset syncing a step late does not affect the business).
   *
   * Paired with `SkillVersioning.onSkillCreated`: one handles v1 registration, the other
   * handles whole-skill archiving, together covering both ends of the asset lifecycle.
   */
  onSkillArchived?: (params: { skill_id: string; team_id?: string }) => void;
  /**
   * Read-path self-healing re-registration hook.
   *
   * Fire timing: after `get` / `readFile` successfully returns a single skill.
   * Not fired for: `list` / `search` / `listing` / `listVersions` (browse-type, N entries at once,
   * costly even with an LRU; and these interfaces do not necessarily imply "use").
   *
   * Contract:
   *  - fire-and-forget: exceptions are swallowed and do not affect the read's return
   *  - the upper-level implementation must be idempotent and carry an LRU (only the first time per skill_id actually queries the store)
   *  - purpose: safety-net repair of missing assets (historical data / migration omissions / accidental manual deletion),
   *    ensuring the frontend control page can see this skill next time
   */
  onSkillAccessed?: (skill: Skill) => void;
}

// Input types for each action (all four IDs are optional)
export interface CreateInput extends IdFields {
  name: string;
  content: string;
  resources?: SkillResourcePayload[];
  metadata?: Record<string, unknown>;
}

export interface UpdateInput extends IdFields {
  skill_id: string;
  expected_version: number;
  content: string;
}

export interface PatchInput extends IdFields {
  skill_id: string;
  expected_version: number;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface DeleteInput extends IdFields {
  skill_id: string;
}

export interface GetInput extends IdFields {
  skill_id: string;
  version?: number;
  include_content?: boolean;
  include_manifest?: boolean;
}

export interface WriteFilesInput extends IdFields {
  skill_id: string;
  expected_version: number;
  files: SkillResourcePayload[];
}

export interface RemoveFilesInput extends IdFields {
  skill_id: string;
  expected_version: number;
  paths: string[];
}

export interface ReadFileInput extends IdFields {
  skill_id: string;
  version?: number;
  path: string;
  encoding?: "utf-8" | "base64";
}

export interface ExportInput extends IdFields {
  skill_id: string;
  version?: number;
  format?: "zip";
}

export interface ListInput extends IdFields {
  filters?: {
    owner_agent_id?: string;
    name_prefix?: string;
    status?: SkillStatus[];
  };
  pagination?: { limit?: number; offset?: number };
}

export interface SearchInput extends IdFields {
  query: string;
  top_k?: number;
  mode?: "bm25" | "embedding" | "hybrid";
}

export interface ListVersionsInput extends IdFields {
  skill_id: string;
  pagination?: { limit?: number; offset?: number };
}

// ═════════════════════════════════════════════════════════════════════
//  Implementation
// ═════════════════════════════════════════════════════════════════════

export class SkillCore {
  private readonly store: ISkillStore;
  private readonly resources: SkillResourceStore;
  private readonly versioning: SkillVersioning;
  private readonly ulid: () => string;
  private readonly now: () => number;
  private readonly versionTtlSeconds: number;
  private readonly maxNonHeadVersions: number;
  private readonly onSkillArchived?: SkillCoreOptions["onSkillArchived"];
  private readonly onSkillAccessed?: SkillCoreOptions["onSkillAccessed"];

  constructor(opts: SkillCoreOptions) {
    this.store = opts.store;
    this.resources = opts.resources;
    this.versioning = opts.versioning;
    // Default sid = `skl-` + 12-character base62 (CSPRNG, ~71 bits of true entropy); total length 16.
    // Same length as the old `skl-${Math.random().toString(36).slice(2,14)}`,
    // collision probability drops from ~1.1e-4 at 1 million entries in a single instance to ~1.5e-10 (see utils/short-id.ts).
    this.ulid = opts.ulid ?? (() => `skl-${randomBase62(12)}`);
    this.now = opts.now ?? (() => Date.now());
    this.versionTtlSeconds = opts.versionTtlSeconds ?? 0;
    this.maxNonHeadVersions = opts.maxNonHeadVersions ?? 0;
    this.onSkillArchived = opts.onSkillArchived;
    this.onSkillAccessed = opts.onSkillAccessed;
  }

  /** Fires after the read path reads a specific skill. Exceptions are swallowed and do not block the read. */
  private notifyAccessed(skill: Skill): void {
    if (!this.onSkillAccessed) return;
    try { this.onSkillAccessed(skill); } catch { /* swallow */ }
  }

  // ───────────────────────────────────────────────────────────────────
  //  WRITE actions
  // ───────────────────────────────────────────────────────────────────

  async create(input: CreateInput): Promise<Skill> {
    // 1) parse + validate
    const file = this.parseAndValidate(input.content);
    if (file.frontmatter.name !== input.name) {
      throw new SkillCoreError("INVALID_FRONTMATTER", `frontmatter.name '${file.frontmatter.name}' != body.name '${input.name}'`);
    }

    // 2) generate the sid and do a collision check
    //
    // Background: the default ulid goes through CSPRNG base62 with 12 characters (~71 bits of true entropy; for 1 million
    // skills in a single instance the collision probability is ~1.5e-10), so in engineering terms it "never collides"; but a preflight layer is still added
    // as a defense, turning "collision silently overwrites" into "collision retries". Why not add a DB UNIQUE constraint:
    //   - the SQLite skills table already has UNIQUE(skill_id, version), so a v1 collision is physically blocked
    //   - the TCVDB primary key is row_id (unique per row), so a "unique for v1 only" constraint cannot be added on skill_id
    //     (skills are inherently multi-version; versions 2/3 coexist with the same skill_id)
    // → an application-layer preflight is the only approach portable to both stores.
    //
    // Note: an injected ulid factory may not carry the 'skl-' prefix, so it is prepended here as a safety net.
    const MAX_ID_ATTEMPTS = 3;
    let sid = "";
    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt++) {
      const u = this.ulid();
      sid = u.startsWith("skl-") ? u : `skl-${u}`;

      // Query across the whole team (without team_id): retry as soon as the skill_id collides globally.
      // Use getHeadIncludingArchived to cover archived rows — archiving does not mean the sid is free,
      // the versions table's UNIQUE(skill_id, version) would still block the write.
      const existing = await this.store.getHeadIncludingArchived(sid);
      if (!existing) break;

      if (attempt >= MAX_ID_ATTEMPTS) {
        // 3 consecutive collisions — this can only be a broken ulid injector (e.g. a test that always returns the same value)
        // or a failed entropy source, not a probabilistic event; throw directly.
        throw new SkillCoreError(
          "SKILL_ID_COLLISION",
          `failed to generate a unique skill_id after ${MAX_ID_ATTEMPTS} attempts`,
        );
      }
    }

    try {
      return await this.versioning.createNewSkill(
        sid,
        input.agent_id ?? "default",
        { user_id: input.user_id, team_id: input.team_id, agent_id: input.agent_id, task_id: input.task_id },
        {
          content: input.content,
          name: input.name,
          description: file.frontmatter.description,
          resourcesToWrite: input.resources,
          metadata_json: input.metadata ? JSON.stringify(input.metadata) : undefined,
        },
      );
    } catch (e) {
      toCoreError(e);
    }
  }

  async update(input: UpdateInput): Promise<Skill> {
    const head = await this.requireHead(input.skill_id, input.team_id);
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
    assertVersionFreshWrap(head, input.expected_version);

    const file = this.parseAndValidate(input.content);
    if (file.frontmatter.name !== head.name) {
      throw new SkillCoreError("INVALID_FRONTMATTER", "name change is not allowed across versions");
    }

    try {
      const result = await this.versioning.appendNextVersion(head, this.ctxOf(input), {
        content: input.content,
        name: head.name,
        description: file.frontmatter.description,
      });
      void this.versioning.cleanupExpiredVersionsForSkill(
        head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions,
      ).catch(() => { /* fire-and-forget */ });
      return result;
    } catch (e) {
      toCoreError(e);
    }
  }

  async patch(input: PatchInput): Promise<Skill> {
    const head = await this.requireHead(input.skill_id, input.team_id);
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
    assertVersionFreshWrap(head, input.expected_version);

    // count occurrences
    const occ = countOccurrences(head.content, input.old_string);
    if (occ === 0) {
      throw new SkillCoreError("SKILL_PATCH_NOT_UNIQUE", `old_string not found`);
    }
    if (occ > 1 && !input.replace_all) {
      throw new SkillCoreError("SKILL_PATCH_NOT_UNIQUE", `old_string occurs ${occ} times; pass replace_all=true to replace all`);
    }

    const newContent = input.replace_all
      ? splitJoin(head.content, input.old_string, input.new_string)
      : head.content.replace(input.old_string, input.new_string);

    // re-parse + validate
    const file = this.parseAndValidate(newContent);
    if (file.frontmatter.name !== head.name) {
      throw new SkillCoreError("INVALID_FRONTMATTER", "patch attempted to rename skill");
    }

    try {
      const result = await this.versioning.appendNextVersion(head, this.ctxOf(input), {
        content: newContent,
        name: head.name,
        description: file.frontmatter.description,
      });
      void this.versioning.cleanupExpiredVersionsForSkill(
        head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions,
      ).catch(() => { /* fire-and-forget */ });
      return result;
    } catch (e) {
      toCoreError(e);
    }
  }

  async delete(input: DeleteInput): Promise<{ skill_id: string; archived: boolean }> {
    // Semantics: physical hard delete (changed in 2026-07, previously soft delete).
    // - head does not exist (skill does not exist / already deleted) → SKILL_NOT_FOUND
    // - use getHeadIncludingArchived to accommodate legacy archived rows: old data may still contain
    //   uncleaned archived heads (left over from the old soft-delete semantics); in that case delete should be treated as a "supplementary physical delete"
    //   rather than a 404.
    const head = await this.store.getHeadIncludingArchived(input.skill_id, input.team_id);
    if (input.team_id) assertTeamMatchWrap(head, input.team_id);
    if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);

    // physically delete all versions + clear storage + report in aggregate to shark(-N)
    const deleted = await this.versioning.deleteSkill(input.skill_id, input.team_id);

    // fire-and-forget: asset state sync failure does not roll back the delete
    // triggered only when deleted > 0 — aligned with store.deleteAllVersions semantics
    if (deleted > 0 && this.onSkillArchived) {
      try { this.onSkillArchived({ skill_id: input.skill_id, team_id: input.team_id }); }
      catch { /* swallow */ }
    }

    // keep the return structure wire-compatible: archived=true means "deletion completed" (a hard delete also reuses this field)
    return { skill_id: input.skill_id, archived: deleted > 0 };
  }

  async writeFiles(input: WriteFilesInput): Promise<Skill> {
    const head = await this.requireHead(input.skill_id, input.team_id);
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
    assertVersionFreshWrap(head, input.expected_version);

    try {
      const result = await this.versioning.appendNextVersion(head, this.ctxOf(input), {
        content: head.content,
        name: head.name,
        description: head.description,
        resourcesToWrite: input.files,
      });
      void this.versioning.cleanupExpiredVersionsForSkill(
        head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions,
      ).catch(() => { /* fire-and-forget */ });
      return result;
    } catch (e) {
      toCoreError(e);
    }
  }

  async removeFiles(input: RemoveFilesInput): Promise<Skill> {
    const head = await this.requireHead(input.skill_id, input.team_id);
    if (input.agent_id) assertOwnerWrap(head, input.agent_id, input.team_id);
    assertVersionFreshWrap(head, input.expected_version);

    // filter to paths that actually exist in the head manifest (avoids invalid resource changes triggering an empty v+1)
    const manifestPaths = new Set(head.manifest.map((m) => m.path));
    const toRemove = input.paths.filter((p) => manifestPaths.has(p));

    if (toRemove.length === 0) {
      return head; // idempotent
    }

    try {
      const result = await this.versioning.appendNextVersion(head, this.ctxOf(input), {
        content: head.content,
        name: head.name,
        description: head.description,
        resourcesToRemove: toRemove,
      });
      void this.versioning.cleanupExpiredVersionsForSkill(
        head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions,
      ).catch(() => { /* fire-and-forget */ });
      return result;
    } catch (e) {
      toCoreError(e);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  //  READ actions
  // ───────────────────────────────────────────────────────────────────

  async get(input: GetInput): Promise<Skill> {
    if (typeof input.version === "number") {
      // specified-version query: first confirm the skill exists (via the head), then query the specified version
      const head = await this.store.getHead(input.skill_id, input.team_id);
      if (input.team_id) assertTeamMatchWrap(head, input.team_id);
      if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");
      const row = await this.store.getByVersion(input.skill_id, input.version, input.team_id);
      if (!row) {
        throw new SkillCoreError(
          "SKILL_NOT_FOUND",
          `version ${input.version} not found (may have been GC'd); current head is v${head.version}`,
        );
      }
      this.assertVersionNotExpired(row, head.version);
      // self-heal on read: even when a historical version was fetched, trigger with the head (the asset only recognizes skill_id)
      this.notifyAccessed(head);
      return row;
    }
    // no version passed → return the latest head
    const row = await this.store.getHead(input.skill_id, input.team_id);
    if (input.team_id) assertTeamMatchWrap(row, input.team_id);
    if (!row) throw new SkillCoreError("SKILL_NOT_FOUND");
    this.notifyAccessed(row);
    return row;
  }

  async list(input: ListInput): Promise<{ items: Skill[]; total: number }> {
    const opts: ListSkillsOptions = {
      team_id: input.team_id,
      owner_agent_id: input.filters?.owner_agent_id ?? input.agent_id,
      // user_id is an audit column (who wrote the skill), NOT an ownership filter.
      // When team_id is present, skills are team-shared — filtering by user_id
      // would exclude skills written by other team members.
      // Only apply user_id filter when there is no team_id (personal scope).
      user_id: input.team_id ? undefined : input.user_id,
      // task_id is of the same nature as user_id: a write-audit field (recording the conversation context when the skill was first persisted),
      // and does not participate in the retrieval of "which skills are available". Passing it would make the extractor, on every new conversation (new task_id),
      // fail to see existing skills → the LLM goes skill_create → hits SKILL_NAME_DUPLICATE →
      // appends a suffix (foo-v2, foo-v3, …), producing lots of same-family skill_ids.
      // The Store layer retains the ability to filter by task_id (for explicit use by audit interfaces).
      task_id: undefined,
      name_prefix: input.filters?.name_prefix,
      status: input.filters?.status,
      limit: input.pagination?.limit,
      offset: input.pagination?.offset,
    };
    return this.store.listSkills(opts);
  }

  async search(input: SearchInput): Promise<SkillSearchResult[]> {
    const opts: SearchSkillsOptions = {
      team_id: input.team_id,
      query: input.query,
      topK: input.top_k,
      mode: input.mode,
      agent_id: input.agent_id,
      // Same rationale as list(): task_id is audit-only, not a read filter.
      // See the detailed comment on list().
      task_id: undefined,
      // Same rationale as list(): user_id is audit-only, not a read filter
      // when team-scoped. Skills are team-shared assets.
      user_id: input.team_id ? undefined : input.user_id,
    };
    return this.store.searchSkills(opts);
  }

  async listVersions(input: ListVersionsInput): Promise<{
    items: Array<Skill & { is_expired: boolean }>;
    total: number;
  }> {
    const items = await this.store.listVersions(input.skill_id, input.team_id, {
      limit: input.pagination?.limit,
      offset: input.pagination?.offset,
    });
    const total = await this.store.countVersions(input.skill_id, input.team_id);
    return {
      items: items.map((s) => ({ ...s, is_expired: this.isVersionExpired(s) })),
      total,
    };
  }

  async readFile(input: ReadFileInput): Promise<{
    path: string; content: string; encoding: "utf-8" | "base64";
    size_bytes: number; mime_type: string; version: number;
  }> {
    const head = await this.store.getHead(input.skill_id, input.team_id);
    if (input.team_id) assertTeamMatchWrap(head, input.team_id);
    if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");
    const ver = input.version ?? head.version;
    // verify whether the path is in that version's manifest (if head, look at head.manifest directly, otherwise query by version)
    const target = typeof input.version === "number" && input.version !== head.version
      ? await this.store.getByVersion(input.skill_id, input.version, input.team_id)
      : head;
    if (!target) {
      // head exists but the specified version cannot be found → the version was already GC'd, not that the skill does not exist
      throw new SkillCoreError(
        "STORAGE_NOT_FOUND",
        `version ${input.version} not found (may have been GC'd); current head is v${head.version}`,
      );
    }
    // TTL check: intercept when an old version's resource is specified
    if (typeof input.version === "number" && input.version !== head.version) {
      this.assertVersionNotExpired(target, head.version);
    }
    const exists = target.manifest.some((m) => m.path === input.path);
    if (!exists) throw new SkillCoreError("SKILL_NOT_FOUND", `path ${input.path} not in manifest of v${ver}`);

    const r = await this.resources.readResource(input.skill_id, ver, input.path, input.encoding ?? "utf-8");
    if (!r) throw new SkillCoreError("STORAGE_NOT_FOUND", "version directory missing (may be GC'd)");
    this.notifyAccessed(head);
    return {
      path: r.path,
      content: r.content,
      encoding: r.encoding,
      size_bytes: r.size_bytes,
      mime_type: r.mime_type,
      version: ver,
    };
  }

  async exportSkill(input: ExportInput): Promise<{
    zip_base64: string;
    filename: string;
    name: string;
    version: number;
    file_count: number;
    total_bytes: number;
    warnings: string[];
  }> {
    // 1. get the target version
    const head = await this.store.getHead(input.skill_id, input.team_id);
    if (input.team_id) assertTeamMatchWrap(head, input.team_id);
    if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");

    let target: Skill;
    if (typeof input.version === "number" && input.version !== head.version) {
      const byVersion = await this.store.getByVersion(input.skill_id, input.version, input.team_id);
      if (!byVersion) {
        throw new SkillCoreError(
          "SKILL_NOT_FOUND",
          `version ${input.version} not found`,
        );
      }
      target = byVersion;
      this.assertVersionNotExpired(target, head.version);
    } else {
      target = head;
    }

    // 2. read SKILL.md content (DB is the authoritative source)
    const content = target.content;

    // 3. read resource files
    const warnings: string[] = [];
    const resources: Array<{
      path: string; content: string; encoding: "base64"; is_executable: boolean;
    }> = [];

    for (const entry of target.manifest) {
      const r = await this.resources.readResource(
        input.skill_id, target.version, entry.path, "base64",
      );
      if (!r) {
        warnings.push(`${entry.path}: missing in storage, skipped`);
        continue;
      }
      resources.push({
        path: entry.path,
        content: r.content,
        encoding: "base64",
        is_executable: entry.is_executable,
      });
    }

    // 4. pack the zip
    const zipBuf = buildZip(target.name, content, resources);

    // 5. cap protection
    if (zipBuf.length > this.resources.getMaxSkillTotalBytes()) {
      throw new SkillCoreError(
        "SKILL_EXPORT_TOO_LARGE",
        `exported zip ${zipBuf.length} bytes exceeds max ${this.resources.getMaxSkillTotalBytes()} bytes`,
      );
    }

    return {
      zip_base64: zipBuf.toString("base64"),
      filename: `${target.name}.zip`,
      name: target.name,
      version: target.version,
      file_count: resources.length,
      total_bytes: zipBuf.length,
      warnings,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  //  helpers
  // ───────────────────────────────────────────────────────────────────

  private parseAndValidate(raw: string) {
    let file;
    try {
      file = parseSkillFile(raw);
      validateSkillFile(file);
    } catch (e) {
      // Parse / length / regex failure → 42203 (design §3.6)
      throw new SkillCoreError("SKILL_FRONTMATTER_INVALID", (e as Error).message);
    }
    return file;
  }

  private async requireHead(skillId: string, teamId?: string): Promise<Skill> {
    const head = await this.store.getHead(skillId, teamId);
    if (teamId) assertTeamMatchWrap(head, teamId);
    if (!head) throw new SkillCoreError("SKILL_NOT_FOUND");
    return head;
  }

  private ctxOf(input: { user_id?: string; team_id?: string; agent_id?: string; task_id?: string }) {
    return {
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
    };
  }

  // ── TTL helpers ──

  /** Determine whether a non-head version has expired. The head never expires; ttlSeconds=0 disables it. */
  private isVersionExpired(skill: Skill): boolean {
    if (skill.is_head) return false;
    if (!this.versionTtlSeconds) return false;
    return this.now() - skill.created_at_ms > this.versionTtlSeconds * 1000;
  }

  private assertVersionNotExpired(skill: Skill, headVersion: number): void {
    if (!this.isVersionExpired(skill)) return;
    const ageDays = ((this.now() - skill.created_at_ms) / 86400000).toFixed(1);
    const ttlDays = this.versionTtlSeconds / 86400;
    throw new SkillCoreError(
      "SKILL_VERSION_EXPIRED",
      `Skill '${skill.name}' version v${skill.version} has expired ` +
      `(created ${ageDays} days ago, TTL is ${ttlDays} days). ` +
      `Please use the latest version v${headVersion}.`,
    );
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Internal helpers
// ═════════════════════════════════════════════════════════════════════

function assertOwnerWrap(head: Skill, agentId: string, teamId?: string): void {
  try { assertOwner(head, agentId, teamId); }
  catch (e) {
    if (e instanceof SkillPermissionError) throw new SkillCoreError(e.code as SkillCoreErrorCode, e.message);
    throw e;
  }
}

function assertTeamMatchWrap(row: Skill | null, teamId: string): asserts row is Skill {
  try { assertTeamMatch(row, teamId); }
  catch (e) {
    if (e instanceof SkillPermissionError) throw new SkillCoreError(e.code as SkillCoreErrorCode, e.message);
    throw e;
  }
}

function assertVersionFreshWrap(head: Skill, expected: number): void {
  try { assertVersionFresh(head, expected); }
  catch (e) {
    if (e instanceof SkillPermissionError) throw new SkillCoreError(e.code as SkillCoreErrorCode, e.message);
    throw e;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function splitJoin(s: string, find: string, replace: string): string {
  return s.split(find).join(replace);
}

// ═════════════════════════════════════════════════════════════════════
//  zip packaging
// ═════════════════════════════════════════════════════════════════════

function buildZip(
  name: string,
  skillMdContent: string,
  resources: Array<{ path: string; content: string; encoding: "base64"; is_executable: boolean }>,
): Buffer {
  const files: Record<string, [Uint8Array, { level?: number; mtime?: Date; mode?: number }?]> = {};

  // 1. SKILL.md
  files[`${name}/SKILL.md`] = [strToU8(skillMdContent)];

  // 2. resource files (placed directly under name/, consistent with the import source directory structure)
  for (const r of resources) {
    const key = `${name}/${r.path}`;
    const buf = r.encoding === "base64"
      ? Uint8Array.from(Buffer.from(r.content, "base64"))
      : strToU8(r.content);
    files[key] = [buf, {
      mode: r.is_executable ? 0o755 : 0o644,
    }];
  }

  // fflate's Zippable type constraint on value is not entirely consistent with our Record,
  // but is fully compatible at runtime (Uint8Array + opts tuple is a valid ZippableFile).
  const zipped = zipSync(files as unknown as Parameters<typeof zipSync>[0]);
  return Buffer.from(zipped);
}
