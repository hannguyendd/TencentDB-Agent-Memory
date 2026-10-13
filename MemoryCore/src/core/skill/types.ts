/**
 * Type definitions for the Skill module — v2 redesign (2026-06-17).
 *
 * Host-neutral. No imports from openclaw / hermes / automation projects.
 * Design doc: docs/design/2026-06-17-skill-redesign-v2.md
 */

// ============================
// Configuration types (input from user / openclaw.json)
// ============================

/**
 * User-facing skill configuration. All fields optional; defaults applied
 * by `resolveSkillConfig`.
 */
export interface SkillConfigInput {
  enabled?: boolean;

  /** Override for skill metadata + vector store backend. Falls back to outer storeBackend, then 'sqlite'. */
  storeBackend?: "sqlite" | "tcvdb" | "mongodb";

  /** Override for skill content (SKILL.md + resources) backend. Falls back to env probe → 'local'. */
  contentBackend?: "local" | "cos";

  routing?: {
    mode?: "bm25" | "embedding" | "hybrid";
    hybridAlpha?: number;
    searchTopK?: number;
    charBudgetPercent?: number;
    fastPathMinNameLength?: number;
  };

  extraction?: {
    enabled?: boolean;
    toolCallThreshold?: number;
    model?: string;
    maxIterations?: number;
    /**
     * Single "archive size" knob (bytes). Default 40960 (40KB). Derives 7 internal fields:
     *   • Handler's bytesThreshold / requestCompressThresholdBytes = archiveBytes
     *   • Oversize fallback's chunkMaxBytes = 2 × archiveBytes
     *   • Oversize fallback's headKeepBytes / tailKeepBytes = archiveBytes
     *   • Extractor transcript truncation's headChars / tailChars = archiveBytes
     * Semantics: archive payload target size = archiveBytes, cap = 2 × archiveBytes.
     */
    archiveBytes?: number;
    /** Output token cap for a single Skill review LLM call. If omitted → inherits the top-level llm.maxTokens. */
    maxTokens?: number;
    /**
     * Before handing the transcript to the review LLM, the Extractor first injects a "pre-retrieved"
     * skill list (obtained by the extractor running skill_list itself). This field controls the maximum number of entries in it,
     * and is also the cap shared by relevant retrieval (LLM generates a query + BM25 search) and the recent fallback
     * (paged by updated_at DESC). Default 20; <=0 or a non-integer warns and falls back to 20.
     */
    prefixSkillsLimit?: number;
  };

  /**
   * Head/tail compression rules for a single large tool message. Only affects the head/tail split of a single tool_call / tool_result content
   * when it exceeds the threshold; user/assistant/system are never compressed.
   */
  compress?: {
    /** How many bytes a single tool message's content must exceed before it is compressed. Default 2048 (2KB). */
    toolContentThresholdBytes?: number;
    /** Head bytes kept after compression. Default 1024 (1KB). */
    headBytes?: number;
    /** Tail bytes kept after compression. Default 1024 (1KB). */
    tailBytes?: number;
  };

  resources?: {
    maxResourceSizeBytes?: number;
    downloadDir?: string;
    allowExecutable?: boolean;
  };

  /** TTL in days for old versions. Default 0 (disabled). Set 7 = non-head versions expire 7 days after creation. */
  versionTtlDays?: number;

  /**
   * Max number of **non-head** versions retained per skill. Default 0 (disabled).
   * Set 100 = at most 100 non-head versions, the oldest are deleted when exceeded (the head is never affected).
   * Takes the union with versionTtlDays: when both are enabled, whichever is stricter takes effect.
   */
  maxVersions?: number;

  /**
   * Skill extraction worker pool (introduced 2026-07-30). One pool per process, all instances
   * share one skill agent queue, and N stateless worker loops in the pool take work from the queue.
   * See docs/design/2026-07-30-skill-worker-instance-decoupling.md for details.
   */
  worker?: {
    /** Number of workers in the pool, the process-wide cap on skill extraction concurrency. Default 60. Can be overridden by env TDAI_SKILL_WORKER_CONCURRENCY. */
    concurrency?: number;
    /** dequeueAgent single-spin deadline (ms). Default 5000. */
    brpopBlockMs?: number;
    /** extract-lock TTL (ms), protects serialization of the same (instance, agent). Default 600_000 (10 min). */
    extractLockTtlMs?: number;
    /** extract-lock renewal interval (ms), default ttl / 4. */
    extractLockRenewIntervalMs?: number;
  };
}

// ============================
// Resolved configuration (after defaults + downgrade decisions)
// ============================

export interface ResolvedSkillConfig {
  enabled: true; // when this object exists, skill is enabled
  storeBackend: "sqlite" | "tcvdb" | "mongodb";
  contentBackend: "local" | "cos";

  routing: {
    mode: "bm25" | "embedding" | "hybrid";
    hybridAlpha: number;
    searchTopK: number;
    charBudgetPercent: number;
    fastPathMinNameLength: number;
  };

  extraction: {
    enabled: boolean;
    toolCallThreshold: number;
    model?: string;
    maxIterations: number;
    /** Archive size knob (bytes). The user-visible config source; the 7 fields below are derived from it. */
    archiveBytes: number;
    /** Output token cap for a single Skill review LLM call; if omitted → the runner inherits llm.maxTokens. */
    maxTokens?: number;
    /**
     * Cap on the number of Extractor pre-retrieved skill list entries (shared by relevant BM25 retrieval & the recent fallback).
     * Default 20.
     */
    prefixSkillsLimit: number;
    // ↓↓↓ The following 7 are derived from archiveBytes; users do not configure them directly ↓↓↓
    /** Handler: archiving triggers when buffer cumulative bytes ≥ this. = archiveBytes. */
    bytesThreshold: number;
    /** Handler: a single add request ≥ this is forced onto the compression path. = archiveBytes. */
    requestCompressThresholdBytes: number;
    /** Oversize fallback: splitting triggers when the archive payload > this. = 2 × archiveBytes. */
    chunkMaxBytes: number;
    /** Oversize fallback: head bytes kept after splitting. = archiveBytes. */
    headKeepBytes: number;
    /** Oversize fallback: tail bytes kept after splitting. = archiveBytes. */
    tailKeepBytes: number;
    /** Extractor transcript truncation: head characters kept. = archiveBytes (byte count approximated as character count). */
    headChars: number;
    /** Extractor transcript truncation: tail characters kept. = archiveBytes. */
    tailChars: number;
  };

  /** Head/tail compression of a single large tool message, with parameters aligned with CompressOptions. */
  compress: {
    toolContentThresholdBytes: number;
    headBytes: number;
    tailBytes: number;
  };

  resources: {
    maxResourceSizeBytes: number;
    downloadDir: string;
    allowExecutable: boolean;
  };

  /** TTL in seconds for old versions. 0 = disabled. */
  versionTtlSeconds: number;

  /** Max number of non-head versions retained per skill. 0 = disabled. */
  maxNonHeadVersions: number;

  /** Skill extraction worker pool config (2026-07-30). See the SkillConfigInput.worker comment. */
  worker: {
    concurrency: number;
    brpopBlockMs: number;
    extractLockTtlMs: number;
    extractLockRenewIntervalMs: number;
  };

  /** Records of automatic downgrades made during resolution. */
  degradations: SkillDegradation[];
}

export interface SkillDegradation {
  field: string;
  from: string;
  to: string;
  reason: string;
  level: "info" | "warn";
}

// ============================
// Probe inputs to resolveSkillConfig
// ============================

/**
 * Information about ambient capabilities that resolveSkillConfig uses
 * to make downgrade decisions. Keep this minimal and explicit; no
 * implicit env/process reads inside resolveSkillConfig itself.
 */
export interface SkillEnvProbe {
  /** Outer storeBackend from MemoryTdaiConfig. */
  outerStoreBackend?: "sqlite" | "tcvdb" | "mongodb";

  /** TCVDB credentials present (url + apiKey + database all set). */
  hasTcvdbCredentials: boolean;

  /** COS credentials present (secretId + secretKey + bucket all set). */
  hasCosCredentials: boolean;

  /** Embedding subsystem usable (enabled + provider valid + dimensions > 0). */
  embeddingAvailable: boolean;

  /**
   * Whether the host provides an LLMRunnerFactory. When false and
   * extraction.enabled=true, we mark extraction as degraded (it stays
   * "enabled" but will return [] at runtime).
   */
  llmRunnerAvailable: boolean;
}

// ════════════════════════════════════════════════════════════════════════
//  v2 data-plane contract (2026-06-17 redesign)
// ════════════════════════════════════════════════════════════════════════

/**
 * Business identity 4-tuple. All optional.
 * team_id and agent_id must either both be passed or both omitted (guaranteed by the gateway schema layer's cross-field validation).
 */
export interface IdFields {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
}

/** Skill status. Aligned with interface.yaml: active or archived. */
export type SkillStatus = "active" | "archived";

/** Metadata of a single resource in the manifest_json column. Bytes are not in this type. */
export interface SkillManifestEntry {
  /** Path relative to `files/`, UNIX style; `..` / absolute paths are forbidden. E.g. "scripts/run.sh" */
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

// ============================
// Skill dedup / propose types (M13 — two-step confirmation)
// ============================

export interface SkillSimilarityResult {
  name: string;
  description: string;
  similarity: number;
}

export interface SkillProposeResult {
  propose_id: string;
  proposed: {
    name: string;
    description: string;
  };
  similar_skills: SkillSimilarityResult[];
}

/**
 * A row of the skill main table. Each row = an immutable snapshot of (skill_id, version).
 *
 * - fields correspond to the `skills` table (see SKILLS_DDL in skill-store-ddl.ts)
 * - `manifest` is the structured form of the deserialized `manifest_json` column
 * - `is_head` is a boolean (0/1 INTEGER in the DB)
 */
export interface Skill {
  row_id: string;
  skill_id: string;
  version: number;
  is_head: boolean;

  user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;

  name: string;
  description: string;
  content: string;
  content_hash: string;
  manifest: SkillManifestEntry[];
  storage_dir: string;

  status: SkillStatus;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Input of `appendVersion`. The store derives version+1 internally based on the head. */
export interface AppendVersionInput {
  /** Write identity. If omitted, writes "default". */
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;

  /** Business primary key — generated by the caller on first creation; later versions of the same skill use the same skill_id. */
  skill_id: string;

  name: string;
  description: string;
  content: string;
  content_hash: string;
  manifest: SkillManifestEntry[];
  storage_dir: string;

  /** Specified as owner_agent_id by the caller only on create; later versions are validated by the store and inherited from the head. */
  owner_agent_id?: string;

  metadata_json?: string;
}

/** Query parameters of `listSkills`. Returns only rows that are head + (status satisfied). All four IDs are optional; if passed they filter. */
export interface ListSkillsOptions {
  team_id?: string;
  owner_agent_id?: string;
  user_id?: string;
  task_id?: string;
  name_prefix?: string;
  status?: SkillStatus[];
  limit?: number;
  offset?: number;
}

/** Query parameters of `searchSkills`. Hits only head + active rows. All four IDs are optional; if passed they filter. */
export interface SearchSkillsOptions {
  team_id?: string;
  query: string;
  queryEmbedding?: Float32Array;
  topK?: number;
  /**
   * Retrieval mode (design §3.5.7).
   *   - 'bm25'      : FTS5 BM25 only
   *   - 'embedding' : vec0 KNN only (requires queryEmbedding)
   *   - 'hybrid'    : BM25 + KNN RRF fusion (requires queryEmbedding)
   * When omitted / embedding not configured, degrades to bm25.
   */
  mode?: "bm25" | "embedding" | "hybrid";
  /** Optional: filter search results by owner agent. */
  agent_id?: string;
  /** Optional: filter search results by task. */
  task_id?: string;
  /** Optional: filter search results by user. */
  user_id?: string;
}

/** Structured conversation message of the extraction interface. Aligned with interface.yaml §SkillImportMessage. */
export interface ExtractMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  timestamp?: string;
}

/**
 * Shape of the LLM runner used by the Skill Review Agent. Injected into SkillExtractor after construction at boot.
 * Compatible with StandaloneLLMRunner.run in src/adapters/standalone/llm-runner.ts.
 */
export interface ExtractorLLMRunner {
  run(params: {
    prompt: string;
    systemPrompt?: string;
    /** Tool dict (Vercel AI SDK shape). Drives the tool-call loop when enableTools=true. */
    tools?: Record<string, unknown>;
    enableTools?: boolean;
    maxIterations?: number;
    taskId: string;
    timeoutMs?: number;
    /** The Worker cancels the LLM call via an abort signal when the lock becomes invalid. */
    signal?: AbortSignal;
  }): Promise<string>;
}
