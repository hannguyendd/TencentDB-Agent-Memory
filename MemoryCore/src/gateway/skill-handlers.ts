/**
 * /skill/* HTTP handlers — v3 (migrated from v2, 2026-06-17).
 *
 * Corresponding design doc: docs/design/2026-06-17-skill-redesign-v2.md §3.5 / §3.6.
 *
 * Error code mapping (core-layer SkillCoreError -> HTTP envelope code):
 *   INVALID_FRONTMATTER       -> 40001  (frontmatter.name inconsistent with body/head)
 *   INVALID_PATH              → 40001
 *   SKILL_NOT_OWNER           → 40301
 *   SKILL_TEAM_MISMATCH       → 40302
 *   SKILL_NOT_FOUND           → 40401
 *   SKILL_VERSION_STALE       → 40901
 *   RESOURCE_TOO_LARGE        → 41301
 *   SKILL_NAME_DUPLICATE      → 42201
 *   SKILL_PATCH_NOT_UNIQUE    → 42202
 *   SKILL_FRONTMATTER_INVALID -> 42203  (frontmatter parse / length / regex)
 *   STORAGE_NOT_FOUND         -> 50301  (version directory GC'd)
 *   QUEUE_UNAVAILABLE         -> 50301  (queue not ready at extract time)
 *   LLM_UNAVAILABLE           -> 50302  (LLM unavailable)
 *   others                    -> 50001
 */

import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import {
  createRequestSchema,
  updateRequestSchema,
  patchRequestSchema,
  deleteRequestSchema,
  getRequestSchema,
  getByNameRequestSchema,
  listRequestSchema,
  searchRequestSchema,
  versionsRequestSchema,
  filesWriteRequestSchema,
  filesRemoveRequestSchema,
  filesReadRequestSchema,
  listingRequestSchema,
  extractRequestSchema,
  exportRequestSchema,
  conversationAddRequestSchema,
  forceArchiveRequestSchema,
} from "./skill-schemas.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { SkillCoreError, type SkillCore } from "../core/skill/skill-core.js";
import type { SkillExtractor } from "../core/skill/skill-extractor.js";
import type { Logger } from "../core/types.js";
import type { Skill, ResolvedSkillConfig } from "../core/skill/types.js";
import { DEFAULT_COMPRESS_OPTIONS } from "../core/skill/conversation-add/message-compressor.js";
import { DEFAULT_OVERSIZE_OPTIONS } from "../core/skill/conversation-add/oversize-strategy.js";
import { prepareArchivePayload } from "../core/skill/conversation-add/prepare-archive.js";
import type { CompressibleMessage } from "../core/skill/conversation-add/message-compressor.js";
import { trace } from "../core/report/trace.js";
import { metricProducer } from "../core/report/kafka-metric-producer.js";
import { obsLogger } from "../core/report/obs-logger.js";

const TAG = "[skill-handlers]";

// [obs] All observability instrumentation goes through the obsLogger base (`src/core/report/obs-logger.ts`);
// event names `skill.<xxx>.done` / `skill.<xxx>.<phase>` are written as literals, and fields are
// inline dictionaries. undefined values are passed as-is without filtering -- fully consistent with other modules in the repo (e.g.
// core/report/traced-task-executor.ts). Degradation is provided by the try/catch inside
// obsLogger, and business code adds no extra defenses.

// ═════════════════════════════════════════════════════════════════════
//  Deps
// ═════════════════════════════════════════════════════════════════════

export interface SkillRouterDeps {
  getSkillCore: () => SkillCore | undefined;
  /** Optional. Extractor instance (driven internally by the worker). */
  getSkillExtractor?: () => SkillExtractor | undefined;
  /** Optional. Resolved skill config; handleListing uses searchTopK to limit the number of injected entries. */
  getResolvedSkillConfig?: () => ResolvedSkillConfig | undefined;
  logger: Logger;
  /**
   * Service mode: resolve per-instance SkillCore (TcvdbSkillStore + COS).
   * When provided, takes precedence over getSkillCore() for /v3/skill/* requests
   * that carry x-tdai-service-id.
   */
  resolveSkillCore?: (instanceId: string) => Promise<SkillCore | undefined>;
  /** Quota manager for skill count limit checks (like memory's checkMemoryQuota). */
  quotaManager?: import("../core/quota/quota-manager.js").QuotaManager;
  /**
   * Service mode: build a SkillExtractor for a given SkillCore.
   * Pass in the per-instance SkillCore (TCVDB + COS) + the current request's instanceId, and return an extractor.
   * Used for synchronous extraction of /v3/skill/extract in service mode, replacing standalone's queue async mode.
   *
   * `instanceId` is passed to `resolveStandaloneLlmForRuntime` to assemble
   * `${baseUrl}/proxy/<instanceId>/v1` -- without it, in the `provider=proxy`
   * scenario the skill extractor would hit the wrong upstream URL.
   */
  buildSkillExtractor?: (
    core: SkillCore,
    instanceId: string,
  ) => SkillExtractor | Promise<SkillExtractor>;
  /**
   * Get the (per instance) MetadataService. Used to automatically register the
   * skill asset (asset_id === skill_id) after handleCreate succeeds and bind it to the owner agent's fixed-asset.
   *
   * In standalone mode SkillCore is constructed globally by TdaiCore (without hooks), so the handler
   * layer does this registration; in service mode the onSkillCreated hook in buildSkillCore does the same
   * thing (idempotent, repeated calls have no side effects). Both paths are covered, ensuring the frontend console always shows the skill.
   *
   * The semantics are consistent with handleConversationAdd in v2-router using the same dep to automatically register chat_memory assets
   * (see v2-router.ts:648 and metadata-service.ts:ensureSkillAsset).
   */
  getMetadataService?: (instanceId: string) => Promise<import("../metadata/service/metadata-service.js").MetadataService>;
  /**
   * `POST /v3/skill/conversation/add` + `POST /v3/skill/extract`
   * Shared provider of wired results. Returns a whole set { handler, trigger, buffer, ... }:
   *   - handleConversationAdd uses .handler
   *   - handleExtract uses .trigger
   *
   * In service mode each tenant holds its own; in standalone mode a singleton is returned. The wiring layer
   * (server.ts) caches + resolves it by auth.serviceId.
   */
  resolveConversationAdd?: (instanceId: string) => Promise<
    import("../core/skill/conversation-add/wire.js").WiredConversationAddHandler | undefined
  >;
  /**
   * Optional. Analytics ClickHouse read-only client (reuses the same lazy singleton as /v3/analytics/*).
   * Used by the `mode='activity'` branch of `handleListing` to read `skill_usage_logs` and compute MRR.
   *
   * Not provided / returns null -> activity mode falls back directly to the original BM25/full logic, with no impact on the main path.
   *
   * Design: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md
   */
  getAnalyticsChClient?: () => Promise<
    import("./analytics/analytics-ch-client.js").AnalyticsChClient | null
  >;
}

// ═════════════════════════════════════════════════════════════════════
//  Error mapping
// ═════════════════════════════════════════════════════════════════════

const ERROR_CODE_MAP: Record<string, number> = {
  INVALID_FRONTMATTER: 40001,
  INVALID_PATH: 40001,
  SKILL_NOT_OWNER: 40301,
  SKILL_TEAM_MISMATCH: 40302,
  SKILL_NOT_FOUND: 40401,
  SKILL_VERSION_STALE: 40901,
  RESOURCE_TOO_LARGE: 41301,
  SKILL_NAME_DUPLICATE: 42201,
  SKILL_PATCH_NOT_UNIQUE: 42202,
  SKILL_FRONTMATTER_INVALID: 42203,
  STORAGE_NOT_FOUND: 50301,
  LLM_UNAVAILABLE: 50302,
  SKILL_COS_REQUIRED: 50303,
  SKILL_ID_COLLISION: 50304,
  SKILL_VERSION_EXPIRED: 41002,
  SKILL_EXPORT_TOO_LARGE: 41301,
};

function mapCoreError(e: unknown, requestId: string, deps?: SkillRouterDeps, meta?: Record<string, unknown>): ApiResponseEnvelope {
  if (e instanceof SkillCoreError) {
    const code = ERROR_CODE_MAP[e.code] ?? 50001;

    // On version conflict, record a warn log, to help gather conflict-frequency statistics later
    if (e.code === "SKILL_VERSION_STALE" && deps) {
      deps.logger.warn(
        `${TAG} version_conflict requestId=${requestId} skill_id=${meta?.skill_id ?? "?"} ` +
        `expected_version=${meta?.expected_version ?? "?"} detail="${e.message}"`,
      );
    }

    // The version-conflict 409 response additionally carries current_version, convenient for caller retries
    if (e.code === "SKILL_VERSION_STALE") {
      const match = e.message?.match(/head is (\d+)/);
      const currentVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { current_version: currentVersion });
    }

    // The stale-version 410 response additionally carries latest_version, convenient for caller upgrades
    if (e.code === "SKILL_VERSION_EXPIRED") {
      const match = e.message?.match(/latest version v(\d+)/);
      const latestVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { latest_version: latestVersion });
    }

    return errorEnvelope(code, e.message, requestId);
  }
  return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
}

function formatZodErr(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

// ═════════════════════════════════════════════════════════════════════
//  Shared preconditions
// ═════════════════════════════════════════════════════════════════════

/**
 * Unified precondition check: prefer to obtain the per-instance SkillCore (TCVDB + COS)
 * via resolveSkillCore(auth.serviceId), falling back to getSkillCore() (standalone).
 *
 * Fix (2026-07-04): in service mode the read handlers previously only used getSkillCore() (standalone
 * SQLite), so after writing to per-instance TCVDB the read queried the empty SQLite. Now the read/write paths are aligned on the same
 * store resolution logic.
 */
async function precheck<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

/**
 * Precheck for write paths: logic exactly the same as precheck, just with a name that expresses "write semantics" more clearly.
 * Kept to maintain naming consistency of existing handlers; the two could be merged, but backward compatibility is kept for now.
 */
async function precheckWrite<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

// Shape a Skill row into SkillSummary form (without content; add the manifest when used as detail)
// Fields aligned with design doc §3.4 SkillSummary.
/** Deserialize skill.metadata_json into a metadata object; invalid JSON returns undefined. */
function parseMetadata(s: Skill): Record<string, unknown> | undefined {
  const raw = s.metadata_json;
  if (!raw || raw === "{}" || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(s: Skill) {
  const metadata = parseMetadata(s);
  return {
    skill_id: s.skill_id,
    name: s.name,
    description: s.description,
    version: s.version,
    is_head: s.is_head,
    status: s.status,
    owner_user_id: s.user_id,
    owner_agent_id: s.owner_agent_id,
    team_id: s.team_id,
    task_id: s.task_id,
    created_at_ms: s.created_at_ms,
    updated_at_ms: s.updated_at_ms,
    ...(metadata ? { metadata } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Handlers
// ═════════════════════════════════════════════════════════════════════

export async function handleCreate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(createRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleCreate.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  // Quota check (like memory's checkMemoryQuota)
  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleCreate.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.create(pre.data);
    try { trace.report("skill.create", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name }); } catch { /* noop */ }

    // -- Automatically register the skill asset (asset_id === skill_id) + bind to the owner agent's fixed-asset --
    //
    // Why do it here:
    //   - in standalone mode SkillCore is constructed globally by TdaiCore (no onSkillCreated hook);
    //   - without supplementary registration here, metadata-layer endpoints such as asset/list-accessible / acl/* cannot find this skill,
    //     and the frontend console's "team assets / authorization" chain is completely broken.
    //
    // Relationship with service mode:
    //   - in service mode the gateway attaches the same-named hook when constructing a per-instance SkillCore with buildSkillCore,
    //     and both paths call `metaSvc.ensureSkillAsset({ skill_id, team_id, agent_id, name })`,
    //     which is already idempotent in metadata-service.ts (LRU + primary-key dedup), so repeated calls have no side effects.
    //
    // Failure policy:
    //   - throw an exception -> the create request as a whole returns an error. Avoids the silently inconsistent state of "skill persisted but asset missing"
    //     (users would wonder "I created it successfully but cannot see it").
    //   - consistent with how ensureChatMemoryAsset is done in handleConversationAdd of v2-router.ts.
    if (deps.getMetadataService && r.team_id && r.owner_agent_id) {
      try {
        const metaSvc = await deps.getMetadataService(auth.serviceId);
        await metaSvc.ensureSkillAsset({
          skill_id: r.skill_id,
          team_id: r.team_id,
          agent_id: r.owner_agent_id,
          name: r.name,
        });
      } catch (err) {
        deps.logger.error(
          `${TAG} ensureSkillAsset failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        obsLogger.error("skill.handleCreate.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: r.skill_id, phase: "ensureSkillAsset" }, err instanceof Error ? err : undefined);
        return mapCoreError(err, requestId, deps, { skill_id: r.skill_id });
      }
    }

    obsLogger.info("skill.handleCreate.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) { obsLogger.error("skill.handleCreate.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleUpdate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(updateRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleUpdate.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleUpdate.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.update(pre.data);
    try { trace.report("skill.update", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    obsLogger.info("skill.handleUpdate.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleUpdate.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handlePatch(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(patchRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handlePatch.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handlePatch.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.patch(pre.data);
    try { trace.report("skill.patch", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    obsLogger.info("skill.handlePatch.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handlePatch.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleDelete(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(deleteRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleDelete.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.delete(pre.data);

    // -- Asset physical deletion fallback: DELETE meta_assets + cascade clearing of agent bindings / ACL --
    //
    // Why do it again here:
    //   - service mode: the onSkillArchived hook in buildSkillCore has already been called once; calling it again here
    //     is idempotent convergence (deleteAssets treats an already-nonexistent asset as success, with no side effects).
    //   - standalone mode: SkillCore is constructed globally by TdaiCore without injected hooks (to avoid coupling the
    //     MetadataService startup order). This call at the handler layer is the only linkage entry.
    //
    // Failure policy: fire-and-forget, warn without rolling back the delete. A second delete re-triggers the core hook
    // and this fallback, eventually converging. See the symmetrical approach of ensureSkillAsset in handleCreate
    // (only the failure policy is the opposite: create fails strictly, delete is lenient so the skill side always succeeds).
    let assetSynced = false;
    if (r.archived && deps.getMetadataService && pre.data.team_id) {
      try {
        const metaSvc = await deps.getMetadataService(_auth.serviceId);
        await metaSvc.deleteAssets([r.skill_id]);
        assetSynced = true;
      } catch (err) {
        deps.logger.warn(
          `${TAG} [skill-asset-sync] deleteAssets(archive) failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    try {
      trace.report("skill.delete", {
        skill_id: r.skill_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        asset_synced: assetSynced,
      });
    } catch { /* noop */ }
    obsLogger.info("skill.handleDelete.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, archived: r.archived, asset_synced: assetSynced });
    return successEnvelope(r, requestId);
  } catch (e) {
    obsLogger.error("skill.handleDelete.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

/**
 * `POST /v3/skill/get-by-name` -- (team_id, agent_id, skill_name) -> skill details.
 *
 * See the motivation comment of `getByNameRequestSchema` in skill-schemas.ts. Implementation path:
 *   1) the schema already enforces team_id + agent_id + skill_name as required
 *   2) go through `SkillCore.list` to get candidates (1-2 items) for (team, agent, name_prefix=name)
 *   3) exact-match one by name, and hand it to `SkillCore.get(skill_id)` to reuse the include_content /
 *      include_manifest / version branches, ensuring the output body is consistent with /v3/skill/get
 *
 * Not found -> 40401 SKILL_NOT_FOUND (aligned with get; from the agent's view one cannot tell "no such name
 * or no such id", so a single error code is used).
 */
export async function handleGetByName(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(getByNameRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleGetByName.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // Use name as a prefix to fetch 1-2 candidates (prefix LIKE hits neighbors with the same prefix,
    // so exact-match explicitly once more; limit=1 is not used so that the exact hit is stable).
    const listed = await pre.core.list({
      team_id: pre.data.team_id,
      agent_id: pre.data.agent_id,
      filters: { name_prefix: pre.data.skill_name },
      pagination: { limit: 10 },
    });
    const hit = listed.items.find((s) => s.name === pre.data.skill_name);
    if (!hit) {
      obsLogger.info("skill.handleGetByName.done", {
        req_id: requestId, code: 40401, dur_ms: Date.now() - t0,
        team_id: pre.data.team_id, agent_id: pre.data.agent_id, skill_name: pre.data.skill_name,
        reason: "not_found",
      });
      // Same path as handleGet SKILL_NOT_FOUND: errorEnvelope(40401, ...)
      return errorEnvelope(40401, `SKILL_NOT_FOUND: no skill named "${pre.data.skill_name}" for agent ${pre.data.agent_id}`, requestId);
    }

    // Reuse the body of handleGet: build the get input and go through core.get, ensuring exactly consistent behavior
    // (including the version branch and include_content / include_manifest semantics).
    const row = await pre.core.get({
      user_id: pre.data.user_id,
      team_id: pre.data.team_id,
      agent_id: pre.data.agent_id,
      task_id: pre.data.task_id,
      skill_id: hit.skill_id,
      version: pre.data.version,
      include_content: pre.data.include_content,
      include_manifest: pre.data.include_manifest,
    });
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    obsLogger.info("skill.handleGetByName.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      skill_id: row.skill_id, version: row.version,
      content_len: row.content?.length ?? 0,
      manifest_n: row.manifest?.length ?? 0,
    });
    return successEnvelope(data, requestId);
  } catch (e) {
    obsLogger.error("skill.handleGetByName.done", {
      req_id: requestId, dur_ms: Date.now() - t0,
      skill_name: pre.data.skill_name,
    }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId);
  }
}

export async function handleGet(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(getRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleGet.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const row = await pre.core.get(pre.data);
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    // Detail view additionally attaches content_hash / storage_dir (summary does not output these).
    // See docs/design/2026-06-17-skill-redesign-v2.md §3.4 SkillDetail fields.
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    obsLogger.info("skill.handleGet.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: row.skill_id,
      version: row.version,
      content_len: row.content?.length ?? 0,
      manifest_n: row.manifest?.length ?? 0, });
    return successEnvelope(data, requestId);
  } catch (e) { obsLogger.error("skill.handleGet.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleList(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(listRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleList.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // Archive semantics note: `filters.status` allows explicitly passing `['archived']` / `['active','archived']`,
    // only for the console's "recycle bin" view. When status is not passed, only active is returned by default (see the defaults in
    // SqliteSkillStore.listSkills / TcvdbSkillStore.listSkills).
    // Ordinary business callers **should not** explicitly request archived -- it is already invisible to the read/write APIs.
    const r = await pre.core.list(pre.data);
    obsLogger.info("skill.handleList.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, items: r.items.length, total: r.total });
    return successEnvelope({ items: r.items.map(toSummary), total: r.total }, requestId);
  } catch (e) { obsLogger.error("skill.handleList.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleSearch(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(searchRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleSearch.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // scope="team" → strip agent_id so store does team-wide search (no owner filter).
    // The v3 isolation middleware already verified team_id + agent_id + user_id are present.
    const { scope, ...data } = pre.data;
    const searchInput = scope === "team"
      ? { ...data, agent_id: undefined }
      : data;
    const hits = await pre.core.search(searchInput);
    const items = hits.map((h) => ({
      ...toSummary(h.skill),
      score: h.score,
      // The FTS5 snippet may be empty (content too short); fall back to description.
      snippet: h.snippet && h.snippet.length > 0 ? h.snippet : h.skill.description,
    }));
    obsLogger.info("skill.handleSearch.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, items: items.length, scope: pre.data.scope ?? "agent" });
    return successEnvelope({ items }, requestId);
  } catch (e) { obsLogger.error("skill.handleSearch.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleVersions(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(versionsRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleVersions.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.listVersions(pre.data);
    if (r.total === 0) {
      obsLogger.warn("skill.handleVersions.done", { req_id: requestId, code: 40401, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, reason: "not_found" });
      return errorEnvelope(40401, "skill not found", requestId);
    }
    const items = r.items.map((s) => ({
      ...toSummary(s),
      is_expired: (s as Skill & { is_expired: boolean }).is_expired ?? false,
    }));
    obsLogger.info("skill.handleVersions.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, items: items.length, total: r.total });
    return successEnvelope({ items, total: r.total }, requestId);
  } catch (e) { obsLogger.error("skill.handleVersions.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleFilesWrite(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(filesWriteRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesWrite.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleFilesWrite.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.writeFiles(pre.data);
    obsLogger.info("skill.handleFilesWrite.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, version: r.version, files: pre.data.files.length });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleFilesWrite.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRemove(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(filesRemoveRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesRemove.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleFilesRemove.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.removeFiles(pre.data);
    obsLogger.info("skill.handleFilesRemove.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, version: r.version, paths: pre.data.paths.length });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleFilesRemove.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRead(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(filesReadRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesRead.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.readFile(pre.data);
    obsLogger.info("skill.handleFilesRead.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id,
      version: r.version,
      size_bytes: r.size_bytes,
      encoding: r.encoding, });
    return successEnvelope(r, requestId);
  } catch (e) { obsLogger.error("skill.handleFilesRead.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleExport(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(exportRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) {
    obsLogger.warn("skill.handleExport.done", {
      req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck",
    });
    return pre.envelope;
  }
  try {
    const r = await pre.core.exportSkill(pre.data);
    obsLogger.info("skill.handleExport.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      skill_id: pre.data.skill_id, version: r.version,
      file_count: r.file_count, total_bytes: r.total_bytes,
    });
    return successEnvelope(r, requestId);
  } catch (e) {
    obsLogger.error("skill.handleExport.done", {
      req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id,
    }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId);
  }
}

/**
 * Implementation of the `mode='activity'` branch of `handleListing` -- default-task activity recall.
 *
 * Flow (3 stages, design: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md):
 *   1. Query skill_usage_logs in CH for view/search counts over the past 30 days + the top 60 by last active time
 *      (a superset of `WINDOW_DAYS x CANDIDATE_MULTIPLIER x top_k`, ensuring a strong version
 *       signal can overturn the ranking and squeeze into the final top_k)
 *   2. Batch-fetch the head of those skills (name/description/version/updated_at_ms)
 *   3. 4-dimension equal-weight MRR scoring -> take top_k by score DESC
 *
 * **Never throws**: returning null indicates a "degradation signal" (CH unavailable / query failed / missing required dep),
 * and handleListing falls to the auto branch. An empty array means "0 active skills within the data window" (cold start),
 * which likewise falls to the auto branch in handleListing.
 *
 * @returns
 *   - `null`: cannot execute (unavailable/exception); semantics = "please take the fallback"
 *   - `[]`  : executed but no active skills in the data window; semantics = "please take the fallback (cold start)"
 *   - `Item[]`: there are N active skills (at most top_k)
 */
async function resolveActivityHits(args: {
  deps: SkillRouterDeps;
  core: SkillCore;
  team_id: string;
  agent_id: string;
  top_k: number;
}): Promise<Array<{ skill_id: string; name: string; description: string; version: number }> | null> {
  const { deps, core, team_id, agent_id, top_k } = args;

  // No CH client dep -> not wired, degrade directly (backward compatible: old deployments are completely unaffected)
  if (!deps.getAnalyticsChClient) return null;

  const ch = await deps.getAnalyticsChClient().catch(() => null);
  if (!ch) return null;                              // CH not configured

  const WINDOW_DAYS = 30;
  const CANDIDATE_MULTIPLIER = 3;                    // superset: 20 * 3 = 60
  const candidateK = Math.max(top_k, top_k * CANDIDATE_MULTIPLIER);

  // Step 1: query view/search count + last_active_ts in CH
  type ActivityRow = {
    skill_id: string;
    view_cnt: string | number;
    search_cnt: string | number;
    last_active_ts: string;             // CH DateTime64 → ISO string in JSONEachRow
  };
  let candidates: ActivityRow[];
  try {
    candidates = await ch.query<ActivityRow>({
      query: `
        SELECT
          skill_id,
          countIf(event_type = 'view')       AS view_cnt,
          countIf(event_type = 'search_hit') AS search_cnt,
          max(timestamp)                     AS last_active_ts
        FROM skill_usage_logs
        WHERE team_id = {team_id:String}
          AND agent_id = {agent_id:String}
          AND timestamp >= now() - INTERVAL {window_days:UInt16} DAY
        GROUP BY skill_id
        ORDER BY view_cnt DESC, search_cnt DESC, last_active_ts DESC
        LIMIT {candidate_k:UInt16}
      `,
      query_params: {
        team_id,
        agent_id,
        window_days: WINDOW_DAYS,
        candidate_k: candidateK,
      },
    });
  } catch (err) {
    deps.logger.warn?.(`${TAG} activity: CH query failed`, err instanceof Error ? err.message : String(err));
    return null;                                     // CH query failed -> degrade
  }
  if (!candidates || candidates.length === 0) return [];   // cold start -> degrade

  // Step 2: batch getHead to get name/description/version/updated_at_ms
  // SkillCore.get is not used (it has permission checks + audit, unsuitable for batch queries); go through the store directly.
  // Internal errors are swallowed and not thrown; a single skill failing does not affect the others.
  type Enriched = {
    skill_id: string;
    name: string;
    description: string;
    version: number;
    view_cnt: number;                 // passed through from candidates, force Number() to guard against CH JSONEachRow strings
    search_cnt: number;               // same as above
    version_cnt: number;              // version count approximated = head.version (incremented on each patch/update)
    last_active: number;              // max(events last_active, head.updated_at_ms)
  };
  const enriched: Enriched[] = [];
  await Promise.all(candidates.map(async (c) => {
    try {
      const head = await core.get({ skill_id: c.skill_id, team_id });
      const eventTs = Date.parse(String(c.last_active_ts));    // ISO -> ms; NaN on failure
      const eventTsSafe = Number.isFinite(eventTs) ? eventTs : 0;
      // CH JSONEachRow returns UInt64 counts as strings by default (output_format_json_quote_64bit_integers=1);
      // passing them to rankBy without coercion -> keyFn gets undefined or a string, either of which breaks sorting.
      // Number(undefined) = NaN, Number("16") = 16, both are safe fallbacks.
      const viewCnt = Number(c.view_cnt) || 0;
      const searchCnt = Number(c.search_cnt) || 0;
      enriched.push({
        skill_id: head.skill_id,
        name: head.name,
        description: head.description,
        version: head.version,
        view_cnt: viewCnt,
        search_cnt: searchCnt,
        version_cnt: head.version,                              // = approximation of countVersions
        last_active: Math.max(eventTsSafe, head.updated_at_ms),
      });
    } catch {
      // The skill may have been deleted / is inaccessible -> skip, without affecting other candidates
    }
  }));
  if (enriched.length === 0) return [];

  // Step 3: 4-dimension MRR scoring + top_k slice
  // Weights are all equal for now (0.25); adjust after looking at dashboard data after launch
  const W = { view: 0.25, search: 0.25, recency: 0.25, version: 0.25 };

  // Competition-style ranking (ties share the same rank, the next rank is skipped); tiebreaker: last_active DESC
  function rankBy<K>(list: Enriched[], keyFn: (s: Enriched) => number): Map<string, number> {
    const sorted = [...list].sort((a, b) => {
      const dk = keyFn(b) - keyFn(a);
      if (dk !== 0) return dk;
      return b.last_active - a.last_active;
    });
    const ranks = new Map<string, number>();
    let currentRank = 0;
    let lastKey: number | null = null;
    for (let i = 0; i < sorted.length; i++) {
      const key = keyFn(sorted[i]);
      if (lastKey === null || key !== lastKey) {
        currentRank = i + 1;
        lastKey = key;
      }
      ranks.set(sorted[i].skill_id, currentRank);
    }
    return ranks;
  }

  const rView    = rankBy(enriched, (s) => s.view_cnt);
  const rSearch  = rankBy(enriched, (s) => s.search_cnt);
  const rRecency = rankBy(enriched, (s) => s.last_active);
  const rVersion = rankBy(enriched, (s) => s.version_cnt);

  const scored = enriched.map((s) => ({
    ...s,
    score:
        W.view    * (1 / (rView.get(s.skill_id)    ?? enriched.length))
      + W.search  * (1 / (rSearch.get(s.skill_id)  ?? enriched.length))
      + W.recency * (1 / (rRecency.get(s.skill_id) ?? enriched.length))
      + W.version * (1 / (rVersion.get(s.skill_id) ?? enriched.length)),
  }));

  // Tie tiebreaker: skill_id ASC -- enriched is assembled by Promise.all + push,
  // so its order is naturally unstable; without a tiebreaker, skills with strictly equal MRR such as "view=4 search=6" and "view=3 search=6
  // last_active_newer" would return in a different order each time.
  // Falling back to skill_id lexicographic order guarantees idempotency.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill_id < b.skill_id ? -1 : (a.skill_id > b.skill_id ? 1 : 0);
  });

  return scored.slice(0, top_k).map((s) => ({
    skill_id: s.skill_id,
    name: s.name,
    description: s.description,
    version: s.version,
  }));
}

export async function handleListing(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(listingRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleListing.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const charBudget = pre.data.char_budget ?? 8000;
    const query = (pre.data.query ?? "").trim();
    const useSearch = query.length > 0;

    // Read routing from config: searchTopK (the max number of listing entries injected) + mode (bm25/embedding/hybrid).
    const routing = deps.getResolvedSkillConfig?.()?.routing;
    const topK = routing?.searchTopK ?? 20;

    type Item = { skill_id: string; name: string; description: string; version: number };
    let items: Item[] = [];
    let mode: "full" | "search" | "activity" = "full";

    // Activity-recall priority path (only when the caller explicitly specifies mode='activity').
    // If any stage fails / is empty -> fall to the old logic below, with no impact on the main path.
    // Design: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md
    const wantActivity = pre.data.mode === "activity";
    let activityAttempted = false;
    let activityFallbackReason: string | undefined;
    if (wantActivity) {
      activityAttempted = true;
      try {
        const activityItems = await resolveActivityHits({
          deps,
          core: pre.core,
          team_id: pre.data.team_id!,
          agent_id: pre.data.agent_id!,
          top_k: topK,
        });
        if (activityItems && activityItems.length > 0) {
          items = activityItems;
          mode = "activity";
        } else {
          activityFallbackReason = activityItems === null ? "unavailable" : "empty";
        }
      } catch (err) {
        // resolveActivityHits has already swallowed most exceptions internally; reaching here means an extreme case.
        activityFallbackReason = "exception";
        deps.logger.warn?.(
          `${TAG} activity recall failed, falling back to auto`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Old auto logic -- this path is taken when activity was not used or activity was empty/failed.
    // search mode: pick the retrieval algorithm by routing.mode; fall back to list head (when query is empty).
    if (mode !== "activity") {
      if (useSearch) {
        const hits = await pre.core.search({
          user_id: pre.data.user_id,
          team_id: pre.data.team_id,
          agent_id: pre.data.agent_id,
          query,
          top_k: topK,
          mode: routing?.mode,
        });
        items = hits.map((h) => ({
          skill_id: h.skill.skill_id,
          name: h.skill.name,
          description: h.skill.description,
          version: h.skill.version,
        }));
        mode = "search";
      } else {
        const r = await pre.core.list({
          user_id: pre.data.user_id,
          team_id: pre.data.team_id,
          agent_id: pre.data.agent_id,
          pagination: { limit: topK },
        });
        items = r.items.map((s) => ({
          skill_id: s.skill_id,
          name: s.name,
          description: s.description,
          version: s.version,
        }));
        mode = items.length < topK ? "full" : "search";
      }
    }

    // Render the listing; truncate by char_budget (keep the head + an explicit truncation marker).
    // Default id mode: each line is structured `- id=<skill_id>, name=<name>, desc=<description>`,
    //   and a format-description line is added at the top of the block so the agent clearly knows which field is the skill_id to use when calling skill_view.
    // With SKILL_VIEW_MODE=name, fall back to the old format `- name: description` (not exposing the id).
    // See the skill_eval v9(name) vs v10(id) comparison experiment.
    const exposeSkillId = (process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() !== "name";
    // Newlines in description would break the "one skill per line" structure, so fold them into spaces.
    const flat = (s: string) => (s ?? "").replace(/\s*\n\s*/g, " ").trim();
    const lines = items.map((s) =>
      exposeSkillId
        ? `- id=${s.skill_id}, name=${s.name}, desc=${flat(s.description)}`
        : `- ${s.name}: ${s.description}`,
    );
    const formatHint = exposeSkillId
      ? "# One skill per line, fields separated by commas: id=<skill_id>, name=<name>, desc=<description>.\n" +
        "# When calling skill_view, pass the value of the id field (of the form skl-xxxxxx).\n"
      : "";
    let listing = lines.length === 0
      ? "<available_skills>\n(none)\n</available_skills>"
      : `<available_skills>\n${formatHint}${lines.join("\n")}\n</available_skills>`;

    if (listing.length > charBudget) {
      const truncated = listing.slice(0, Math.max(0, charBudget - 32));
      listing = `${truncated}\n... [truncated]\n</available_skills>`;
    }

    obsLogger.info("skill.handleListing.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, mode,
      hits: items.length,
      listing_len: listing.length,
      truncated: listing.length >= charBudget,
      activity_attempted: activityAttempted,
      activity_fallback_reason: activityFallbackReason, });
    return successEnvelope({
      mode,
      listing,
      hits: items.map((s) => ({ skill_id: s.skill_id, version: s.version, name: s.name })),
    }, requestId);
  } catch (e) { obsLogger.error("skill.handleListing.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

/**
 * `POST /v3/skill/extract` -- direct-trigger archive of one conversation slice.
 *
 * Before the rework it was "enqueue a Redis job + poll /result"; after the rework it goes through the exact same downstream as conversation/add
 * (`SkillTriggerService.archive()` -> agent queue -> reuses
 * `SkillConversationExtractWorker`), just without writing data-current/meta, and one call
 * produces one independent archive + one SkillTaskEntry.
 *
 * See `docs/design/2026-07-17-skill-extract-direct-trigger-plan.md` for details.
 */
export async function handleExtract(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  // [obs] The handler logs in segments via obsLogger: one info event per segment, with structured fields
  // (req_id / dur_ms / ...), all correlatable by req_id; obsLogger has try/catch inside,
  // so even if the logger backend is down the business is unaffected.
  const t0 = Date.now();

  const t0Parse = Date.now();
  const parsed = extractRequestSchema.safeParse(body);
  obsLogger.info("skill.handleExtract.schema_parse", {
    req_id: requestId, dur_ms: Date.now() - t0Parse, ok: parsed.success,
  });
  if (!parsed.success) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(50301, "skill extract not wired (resolveConversationAdd missing)", requestId);
  }
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  obsLogger.info("skill.handleExtract.resolve_wired", {
    req_id: requestId, dur_ms: Date.now() - t0Wire, service_id: auth.serviceId, hit: !!wired,
  });
  if (!wired) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(50301, "skill extract not wired for this instance", requestId);
  }

  // direct-trigger always generates a one-time session id (prefix sx-) -- because it has no cross-turn buffer,
  // session_id only determines the COS archive path segment, and each call can be independent; accepted if the caller passes one.
  const sessionId = input.session_id ?? `sx-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // Compression + fallback policy (redesigned 2026-08-10):
  //   (1) total < chunkMax -> archive everything in full, no compression or truncation
  //   (2) total >= chunkMax -> compress tool messages (truncate head/tail of tool_call/tool_result > threshold)
  //   (3) still >= chunkMax after compression -> go through the oversize fallback truncation (keep head + tail, cut the middle)
  // Parameters are taken from resolvedSkillConfig; DEFAULT_* is only a fallback (standalone unconfigured scenario).
  const skillCfg = deps.getResolvedSkillConfig?.();
  const compressOpts = skillCfg
    ? {
        toolContentThresholdBytes: skillCfg.compress.toolContentThresholdBytes,
        headBytes: skillCfg.compress.headBytes,
        tailBytes: skillCfg.compress.tailBytes,
      }
    : DEFAULT_COMPRESS_OPTIONS;
  const oversizeOpts = skillCfg
    ? {
        chunkMaxBytes: skillCfg.extraction.chunkMaxBytes,
        headKeepBytes: skillCfg.extraction.headKeepBytes,
        tailKeepBytes: skillCfg.extraction.tailKeepBytes,
      }
    : DEFAULT_OVERSIZE_OPTIONS;
  const chunkMax = oversizeOpts.chunkMaxBytes ?? DEFAULT_OVERSIZE_OPTIONS.chunkMaxBytes;

  const t0Prep = Date.now();
  const incoming: CompressibleMessage[] = input.messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_name: m.tool_name,
    tool_call_id: m.tool_call_id,
  }));

  // Compute the raw bytes first; only go through compression + fallback when it exceeds chunkMax
  const rawBytes = incoming.reduce(
    (sum, m) => sum + Buffer.byteLength(JSON.stringify(m), "utf8"), 0,
  );
  const needCompress = rawBytes >= chunkMax;

  const prepared = prepareArchivePayload(
    /* existing */ [],
    incoming,
    {
      compress: compressOpts,
      oversize: oversizeOpts,
      forceCompress: needCompress,
    },
  );
  obsLogger.info("skill.handleExtract.prepare_archive", {
    req_id: requestId, dur_ms: Date.now() - t0Prep,
    msg_in: input.messages.length, msg_out: prepared.messages.length,
    raw_bytes: rawBytes, need_compress: needCompress,
    used_compress: prepared.usedCompress, used_oversize: prepared.usedOversize,
  });

  // space_id is taken from the body first (backward compatible with early callers), defaulting back to auth.serviceId --
  // the two values should be equal by design (both are "the currently logged-in instance"). If unequal, log a warning to help catch early
  // the bug of a caller passing the wrong instance; isolation/authentication/routing all rely on auth.serviceId, independent of the body.
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/extract space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Archive = Date.now();
    const res = await wired.trigger.archive({
      session: {
        // 2026-07-30 instance_id is put into the tuple; after the worker pool pops from the queue it routes by this
        // to the corresponding instance's resources (CoS bucket / VDB collection / LLM key).
        instance_id: auth.serviceId,
        space_id: spaceId,
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
      },
      bufferAtTrigger: { messages: prepared.messages as Array<Record<string, unknown>> },
      taskRefId: input.task_id,
      reason: input.reason,
      maxIterations: input.options?.max_iterations,
      // When strict_mode:true, SkillTaskEntry.mode='strict' is written, and the Worker passes it through at consumption
      // to SkillExtractor to use the STRICT prompt. Old clients do not pass it -> always go default (v2 lenient).
      ...(input.strict_mode === true ? { mode: 'strict' as const } : {}),
      // Pass requestId through to the trigger's internal segmented obsLogger events as an anchor
      perfRequestId: requestId,
    });
    obsLogger.info("skill.handleExtract.trigger_archive", {
      req_id: requestId, dur_ms: Date.now() - t0Archive,
      task_id: res.taskId, archive_key: res.archiveKey,
    });

    try {
      metricProducer.send({ metric: "skill.extract.request", instanceId: input.team_id, value: 1 });
    } catch { /* noop */ }

    // trace.report backend span: aligned with create/update/patch/delete; task_id is the anchor,
    // and in clickhouse / langfuse the worker-side skill.worker.task_done can be pulled by task_id.
    try {
      trace.report("skill.extract", {
        task_id: res.taskId,
        task_ref_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
        msg_count: prepared.messages.length,
        success: true,
      });
    } catch { /* noop */ }

    obsLogger.info("skill.handleExtract.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, task_id: res.taskId, msg_count: prepared.messages.length, });
    return successEnvelope({
      ok: true,
      task_id: res.taskId,
      archived_at_ms: res.archivedAtMs,
      archive_key: res.archiveKey,
    }, requestId);
  } catch (e) {
    deps.logger.warn(`${TAG} /v3/skill/extract archive failed: ${(e as Error).message} req_id=${requestId}`);
    obsLogger.error("skill.handleExtract.done", { req_id: requestId, dur_ms: Date.now() - t0, reason: "archive_failed" }, e instanceof Error ? e : undefined);
    return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  /v3/skill/conversation/add  --  new chain: per-turn conversation incremental entry
// ═════════════════════════════════════════════════════════════════════

/**
 * `POST /v3/skill/conversation/add`
 *
 * The Client (proxy) calls this synchronously after each conversation turn ends. The Handler internally completes
 * concatenation + threshold judgment + archive segment (register first, then write the archive). Returns { status, archived? }.
 *
 * See `docs/design/2026-07-15-skill-trigger-in-core-design.md` §11.1.
 */
export async function handleConversationAdd(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  // [obs] The proxy fires this at the end of every turn, making it the highest-frequency skill endpoint. Segmented events:
  //   skill.handleConversationAdd.schema_parse / resolve_wired / handler_handle / done
  // handler.handle also splits internally into read_buffer / prepare_archive / trigger.archive /
  // write_back four segments (done by SkillConversationAddHandler internally via obsLogger, correlated with the trigger
  // via the same req_id).
  const t0 = Date.now();

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 404, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(404, "Skill conversation-add module not enabled", requestId);
  }
  const t0Parse = Date.now();
  const parsed = conversationAddRequestSchema.safeParse(body);
  obsLogger.info("skill.handleConversationAdd.schema_parse", {
    req_id: requestId, dur_ms: Date.now() - t0Parse, ok: parsed.success,
  });
  if (!parsed.success) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  // In service mode resolve the tenant-level wired via auth.serviceId; standalone ignores serviceId
  // and the wiring returns a singleton.
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  obsLogger.info("skill.handleConversationAdd.resolve_wired", {
    req_id: requestId, dur_ms: Date.now() - t0Wire, service_id: auth.serviceId, hit: !!wired,
  });
  if (!wired) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 404, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(404, "Skill conversation-add module not enabled for this instance", requestId);
  }

  // space_id is taken from the body first, defaulting back to auth.serviceId (handled the same as handleExtract).
  // The two values should be equal by design; warn if unequal.
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/conversation/add space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Handle = Date.now();
    const out = await wired.handler.handle({
      // 2026-07-30 instance_id is put into the tuple; after the worker pool pops from the queue it routes by this.
      instance_id: auth.serviceId,
      session_id: input.session_id,
      space_id: spaceId,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      // The schema guarantees a valid role; tool_name/tool_call_id are validated inside the handler
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_name: m.tool_name,
        tool_call_id: m.tool_call_id,
        timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      })),
      // When strict_mode:true, the archive segment is written with SkillTaskEntry.mode='strict', and the Worker uses
      // the STRICT prompt (SKILL_REVIEW_PROMPT_STRICT) at consumption. Old clients that do not pass it go default.
      ...(input.strict_mode === true ? { mode: 'strict' as const } : {}),
      // Pass requestId through to the handler's internal segmented obsLogger; trigger.archive passes it through one more layer
      perfRequestId: requestId,
    });
    obsLogger.info("skill.handleConversationAdd.handler_handle", {
      req_id: requestId, dur_ms: Date.now() - t0Handle,
      status: out.status, reason: out.archived?.reason,
    });

    try {
      trace.report("skill.conversation_add", {
        session_id: input.session_id,
        task_ref_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        status: out.status,
        archived_task_id: out.archived?.task_id,
        reason: out.archived?.reason,
        msg_count: input.messages.length,
        success: true,
      });
    } catch { /* noop */ }

    obsLogger.info("skill.handleConversationAdd.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, status: out.status,
      reason: out.archived?.reason,
      task_id: out.archived?.task_id,
      msg_count: input.messages.length, });
    return successEnvelope(out, requestId);
  } catch (err) {
    // HandlerValidationError -> 400; others -> 500
    const isValidation = err instanceof Error && err.name === "HandlerValidationError";
    if (isValidation) {
      obsLogger.error("skill.handleConversationAdd.done", { req_id: requestId, dur_ms: Date.now() - t0, field: (err as { field?: string }).field }, err instanceof Error ? err : undefined);
      return errorEnvelope(40001, err.message, requestId);
    }
    deps.logger.warn(`${TAG} /v3/skill/conversation/add failed: ${(err as Error).message}`);
    obsLogger.error("skill.handleConversationAdd.done", { req_id: requestId, dur_ms: Date.now() - t0 }, err instanceof Error ? err : undefined);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  POST /v3/skill/conversation/force-archive
//  Manually force-archive the current session buffer (third trigger condition: skip the threshold)
// ═════════════════════════════════════════════════════════════════════

export async function handleForceArchive(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(50301, "skill force-archive not wired (resolveConversationAdd missing)", requestId);
  }

  const parsed = forceArchiveRequestSchema.safeParse(body);
  if (!parsed.success) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  const wired = await deps.resolveConversationAdd(auth.serviceId);
  if (!wired) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(50301, "skill force-archive not wired for this instance", requestId);
  }

  const sess = {
    // 2026-08-04 fix: a missing instance_id would make trigger.archive -> serializeAgentTuple
    // throw `instance_id must be a non-empty string`, which the handler wraps into an envelope
    // 50001 returned to the proxy, so the panel / mem:create-skill "force archive" failed 100% of the time.
    // Kept consistent with handleExtract / handleConversationAdd, falling back to auth.serviceId.
    instance_id: auth.serviceId,
    space_id: input.space_id,
    user_id: input.user_id,
    team_id: input.team_id,
    agent_id: input.agent_id,
    session_id: input.session_id,
  };

  try {
    // Read the current buffer
    const [current, meta] = await Promise.all([
      wired.buffer.readCurrent(sess),
      wired.buffer.readMeta(sess),
    ]);

    // Buffer empty: no need to archive
    if (!current.messages || current.messages.length === 0) {
      obsLogger.info("skill.handleForceArchive.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, status: "empty" });
      return successEnvelope({ status: "empty", message: "No messages in buffer to archive" }, requestId);
    }

    // Call trigger.archive unconditionally (skip the threshold check)
    const archiveRes = await wired.trigger.archive({
      session: sess,
      bufferAtTrigger: { messages: current.messages },
      taskRefId: input.task_id,
      reason: input.reason,
      perfRequestId: requestId,
    });

    // After archiving, clear the buffer + reset meta (consistent with the behavior after archiving in add-handler)
    const nowMs = Date.now();
    await Promise.all([
      wired.buffer.writeCurrent(sess, { messages: [] }),
      wired.buffer.writeMeta(sess, {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: 0,
        byte_count: 0,
        last_appended_at_ms: nowMs,
        last_archived_at_ms: archiveRes.archivedAtMs,
      }),
    ]);

    obsLogger.info("skill.handleForceArchive.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      status: "archived", task_id: archiveRes.taskId,
    });
    return successEnvelope({
      status: "archived",
      task_id: archiveRes.taskId,
      archived_at_ms: archiveRes.archivedAtMs,
      archive_key: archiveRes.archiveKey,
    }, requestId);
  } catch (err) {
    deps.logger.warn(`${TAG} /v3/skill/conversation/force-archive failed: ${(err as Error).message} req_id=${requestId}`);
    obsLogger.error("skill.handleForceArchive.done", { req_id: requestId, dur_ms: Date.now() - t0 }, err instanceof Error ? err : undefined);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Route table
// ═════════════════════════════════════════════════════════════════════

export type SkillHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
) => Promise<ApiResponseEnvelope>;

export function makeSkillRouteTable(): Record<string, SkillHandler> {
  return {
    "/v3/skill/create": handleCreate,
    "/v3/skill/update": handleUpdate,
    "/v3/skill/patch": handlePatch,
    "/v3/skill/delete": handleDelete,
    "/v3/skill/get": handleGet,
    "/v3/skill/get-by-name": handleGetByName,
    "/v3/skill/list": handleList,
    "/v3/skill/search": handleSearch,
    "/v3/skill/versions": handleVersions,
    "/v3/skill/files/write": handleFilesWrite,
    "/v3/skill/files/remove": handleFilesRemove,
    "/v3/skill/files/read": handleFilesRead,
    "/v3/skill/export": handleExport,
    "/v3/skill/listing": handleListing,
    "/v3/skill/extract": handleExtract,
    "/v3/skill/conversation/add": handleConversationAdd,
    "/v3/skill/conversation/force-archive": handleForceArchive,
  };
}
