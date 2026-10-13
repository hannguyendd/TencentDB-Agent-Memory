/**
 * DDL constants — Skill data layer v2 refactor
 *
 * See `docs/design/2026-06-17-skill-redesign-v2.md` §2.1 / §2.2 for details.
 *
 * The three physical objects owned by this module:
 *   - skills      — main table, each row = an immutable snapshot of (skill_id, version)
 *   - skill_fts   — fts5 virtual table (based on the name/description/content of head rows)
 *   - skill_vec   — vec0 virtual table (created only when dimensions>0)
 *
 * Deliberately not created in this DDL:
 *   - skill_bindings / task_skill_drafts / task_floating_skills / task_fixed_skills (the binding/draft/floating concepts have moved down to the control plane)
 *   - skill_resources (the manifest is consolidated into the skills.manifest_json column)
 *   - assets / task_asset_bindings (the global asset system is not persisted on the data plane)
 */

// ═════════════════════════════════════════════════════════════════════
//  skills main table — single table, multiple rows, multiple versions
// ═════════════════════════════════════════════════════════════════════

export const SKILLS_DDL = `
  CREATE TABLE IF NOT EXISTS skills (
    row_id          TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL,
    version         INTEGER NOT NULL,
    is_head         INTEGER NOT NULL DEFAULT 1,

    user_id         TEXT NOT NULL,
    owner_agent_id  TEXT NOT NULL,
    team_id         TEXT NOT NULL,
    task_id         TEXT NOT NULL DEFAULT '',

    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    manifest_json   TEXT NOT NULL DEFAULT '[]',
    storage_dir     TEXT NOT NULL,

    status          TEXT NOT NULL DEFAULT 'active',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at_ms   INTEGER NOT NULL,
    updated_at_ms   INTEGER NOT NULL,

    UNIQUE(skill_id, version)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_skills_team_agent_name_head
    ON skills(team_id, owner_agent_id, name) WHERE is_head=1 AND status='active';

  CREATE INDEX IF NOT EXISTS idx_skills_team_head
    ON skills(team_id, is_head, status);

  CREATE INDEX IF NOT EXISTS idx_skills_owner_head
    ON skills(owner_agent_id, is_head, status);

  CREATE INDEX IF NOT EXISTS idx_skills_user
    ON skills(user_id, is_head);

  CREATE INDEX IF NOT EXISTS idx_skills_skill_version
    ON skills(skill_id, version DESC);

  CREATE INDEX IF NOT EXISTS idx_skills_task_audit
    ON skills(task_id, created_at_ms DESC);
`;

// ═════════════════════════════════════════════════════════════════════
//  skill_fts — FTS5 virtual table (indexes head rows only)
// ═════════════════════════════════════════════════════════════════════

export const SKILL_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(
    name,
    description,
    content,
    skill_id UNINDEXED,
    team_id UNINDEXED,
    owner_agent_id UNINDEXED,
    task_id UNINDEXED,
    user_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 1'
  );
`;

// ═════════════════════════════════════════════════════════════════════
//  skill_vec — vec0 virtual table (the caller is responsible for exec when dimensions>0)
// ═════════════════════════════════════════════════════════════════════

/**
 * `__DIM__` is replaced with the actual dimension (e.g. 1536) at init.
 */
export const SKILL_VEC_DDL_TEMPLATE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS skill_vec USING vec0(
    skill_id TEXT PRIMARY KEY,
    embedding float[__DIM__] distance_metric=cosine
  );
`;

// ═════════════════════════════════════════════════════════════════════
//  Constants
// ═════════════════════════════════════════════════════════════════════

/** Maximum number of characters of content in the FTS index (to prevent a huge SKILL.md from blowing up fts5). */
export const FTS_CONTENT_MAX = 4000;
