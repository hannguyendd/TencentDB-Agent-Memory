/**
 * ISkillStore — Skill storage-layer abstract interface
 *
 * Used to decouple SkillCore / SkillVersioning from concrete storage implementations (SQLite / TCVDB).
 * SqliteSkillStore (Standalone mode) and TcvdbSkillStore (Service mode)
 * each implement this interface, and consumers depend only on the interface.
 *
 * Design doc:
 *   - docs/design/2026-06-25-skill-service-mode-design.md §6.1
 *   - docs/design/2026-06-17-skill-redesign-v2.md
 */

import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  Skill,
  SkillStatus,
} from "./types.js";

// ─── Errors (contract-level, backend-neutral) ──────────────────────────────

export type SkillErrorCode =
  | "SKILL_NAME_DUPLICATE"
  | "SKILL_NOT_FOUND"
  // Concurrent appendVersion calls losing the head-flip CAS (see tcvdb/skill-store.ts);
  // aligned with the same-named code at the skill-core layer, toCoreError passes it through directly.
  | "SKILL_VERSION_STALE";

export class SkillStoreError extends Error {
  constructor(public readonly code: SkillErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillStoreError";
  }
}

/**
 * Thrown when an appendVersion's content_hash is exactly identical to the current head.
 * The caller decides how to handle it (generally an idempotent return of head). The store layer does not silently swallow it.
 */
export class IdempotentNoOpError extends Error {
  constructor(public readonly head: Skill) {
    super("IDEMPOTENT_NO_OP: content_hash unchanged");
    this.name = "IdempotentNoOpError";
  }
}

// ─── Capabilities ──────────────────────────────────────────────────────────

/** Store capability declaration, used for retrieval-degradation decisions */
export interface SkillStoreCapabilities {
  /** Dense vector search available */
  vectorSearch: boolean;
  /** BM25 sparse vector search available */
  ftsSearch: boolean;
  /** TCVDB native hybridSearch available (false in local mode) */
  nativeHybridSearch: boolean;
  /** Sparse vector support */
  sparseVectors: boolean;
}

// ─── Search Result ─────────────────────────────────────────────────────────

export interface SkillSearchResult {
  skill: Skill;
  score: number;
  snippet?: string;
}

// ─── TTL Cleanup Meta ──────────────────────────────────────────────────────

/** Expired-version metadata for TTL cleanup (lightweight, does not read content/manifest). */
export interface ExpiredVersionMeta {
  skill_id: string;
  version: number;
  is_head: boolean;
  status: SkillStatus;
  storage_dir: string;
  created_at_ms: number;
}

// ─── Store Interface ───────────────────────────────────────────────────────

export interface ISkillStore {
  // ── Lifecycle ──
  /** Initialize storage (create tables / create Collection, etc.). */
  init(): void;
  /** Whether in degraded mode (unavailable) */
  isDegraded(): boolean;
  /** Get the store capability declaration */
  getCapabilities(): SkillStoreCapabilities;
  /** Close storage (release connections, etc.) */
  close(): void;

  // ── CRUD ──
  /** Append a version row. The store is not responsible for idempotency checks (handled by the upper-level SkillVersioning). */
  appendVersion(input: AppendVersionInput): Promise<Skill>;
  /**
   * Get the current head version (is_head=1 and status='active').
   *
   * Semantics: `archived` is treated as "logically deleted" and is invisible to any ordinary read interface — this method always returns null.
   * To see an archived head use {@link getHeadIncludingArchived} (only for internal paths such as `SkillCore.delete`
   * idempotent readback, the TTL cleaner, and the admin console).
   */
  getHead(skillId: string, teamId?: string): Promise<Skill | null>;
  /**
   * Get the current head version, including archived.
   *
   * For internal use only:
   *   - `SkillCore.delete` needs the archived head to implement the idempotent `{ archived: true }`
   *   - background compensation tasks scan archived skills vs asset drift
   *   - the admin console "recycle bin" view
   *
   * Ordinary read/write paths **should not** call this method — use `getHead`.
   */
  getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null>;
  /** Get the row of the specified version */
  getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null>;
  /** Mark the head as archived (soft delete) */
  archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }>;

  // ── Queries ──
  /** List head rows, supporting 5-tuple filtering + pagination */
  listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }>;
  /** Search skills (BM25 / embedding / hybrid, decided by the implementation) */
  searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]>;
  /** List all versions of a skill (DESC) */
  listVersions(skillId: string, teamId?: string, pagination?: { limit?: number; offset?: number }): Promise<Skill[]>;
  /** Total number of versions of a skill */
  countVersions(skillId: string, teamId?: string): Promise<number>;

  // ── TTL Cleanup ──
  /** Query expired non-head versions with created_at_ms < cutoffMs (full cross-team scan). */
  findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]>;
  /** Physically delete the specified version row (is_head=0 only). Returns whether a row was actually deleted. */
  deleteVersion(skillId: string, version: number): Promise<boolean>;
  /**
   * Physically delete **all version rows** under the same skill_id (including head + archived).
   * Returns the number of rows actually deleted (may be 0: skill does not exist / team mismatch).
   *
   * Used for the true-delete path of `SkillCore.delete`, the opposite of `deleteVersion`'s head protection:
   * this carries the semantics of "clear everything at once, with the skill as a whole unit", and permission checks are done first by the caller
   * (SkillCore).
   *
   * Semantics:
   *   - `teamId` passed → WHERE forces filtering; no effect across teams (returns 0)
   *   - `teamId` omitted → cross-team delete (for the admin console / background compensation tasks; business paths should not call it)
   */
  deleteAllVersions(skillId: string, teamId?: string): Promise<number>;
}
