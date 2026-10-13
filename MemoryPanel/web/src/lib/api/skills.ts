/**
 * api/skills.ts - Skill data plane (/api/v1/skill/*).
 *
 * Key differences from the meta pipeline:
 *   - skill has independent storage and the primary key skill_id (prefix skl-), readable within the team, writable by the owner agent;
 *   - Identity fields (user_id / team_id / agent_id) go in the body, not in a Header (the auth Header
 *     is still X-Tdai-Service-Id + X-Tdai-User-Key, same as meta);
 *   - Write operations (create/update/patch/delete/files.*) must carry agent_id (= owner),
 *     update/patch/delete/files.* also need expected_version optimistic locking;
 *   - Pagination uses nested pagination.{limit,offset}.
 *
 * Semantics of "mount to Agent": the only mechanism that truly makes a skill belong to an agent is fork - copying an
 * independent copy with owner_agent_id=target agent (see skillApi.forkToAgent). acl/grant only changes the
 * meta authorization layer and has no effect on the "pinned assets" tab and runtime injection (both by owner_agent_id).
 */
import { getPanelSession } from '../panelSession';
import { request, getCurrentUser, ApiError, META_PAGE_SIZE } from './base';
import type { MetaEnvelope } from './types';

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head: boolean;
  status: 'active' | 'archived';
  owner_user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  metadata?: Record<string, unknown>;
}

export interface SkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  manifest: SkillManifestEntry[];
  content_hash?: string;
  storage_dir?: string;
}

export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime_type?: string;
  is_executable?: boolean;
}

export interface SkillFileContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size_bytes: number;
  mime_type: string;
  version: number;
}

const SKILL_PREFIX = '/api/v1/skill';

/** skill data-plane call: inject both Headers, POST body, parse the envelope (code!=0 throws ApiError). */
async function skillCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${SKILL_PREFIX}/${action}`, body, headers);
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty skill response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty skill response',
    });
  }
  return envelope.data;
}

async function skillPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return skillCall<T>(action, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
}

export const skillApi = {
  /** List head skills under a team (page through everything; optionally filter by owner agent / name prefix / status) */
  list: async (
    teamId: string,
    opts?: { ownerAgentId?: string; namePrefix?: string; status?: Array<'active' | 'archived'> }
  ): Promise<SkillSummary[]> => {
    const me = await getCurrentUser();
    const items: SkillSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await skillPost<{ items: SkillSummary[]; total: number }>('list', {
        user_id: me.user_id,
        team_id: teamId,
        filters: {
          owner_agent_id: opts?.ownerAgentId,
          name_prefix: opts?.namePrefix,
          status: opts?.status ?? ['active'],
        },
        pagination: { limit: META_PAGE_SIZE, offset },
      });
      items.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return items;
  },

  /** List the skills owned (owner) by an agent */
  listByAgent: (teamId: string, agentId: string): Promise<SkillSummary[]> =>
    skillApi.list(teamId, { ownerAgentId: agentId }),

  /** Get skill detail (including SKILL.md body + resource manifest) */
  get: async (teamId: string, skillId: string): Promise<SkillDetail> => {
    const me = await getCurrentUser();
    return skillPost<SkillDetail>('get', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      include_content: true,
      include_manifest: true,
    });
  },

  /** Read the content of a single resource file */
  filesRead: async (teamId: string, skillId: string, path: string): Promise<SkillFileContent> => {
    const me = await getCurrentUser();
    return skillPost<SkillFileContent>('files/read', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      path,
    });
  },

  /** Create skill (agentId becomes owner_agent_id) */
  create: async (
    teamId: string,
    agentId: string,
    data: { name: string; content: string; resources?: SkillResourcePayload[]; metadata?: Record<string, unknown> }
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('create', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      name: data.name,
      content: data.content,
      resources: data.resources,
      metadata: data.metadata,
    });
  },

  /** Soft delete (archive); needs the owner agent_id + expected_version optimistic lock */
  delete: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number
  ): Promise<{ skill_id: string; archived: boolean }> => {
    const me = await getCurrentUser();
    return skillPost<{ skill_id: string; archived: boolean }>('delete', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
    });
  },

  /** Full update of SKILL.md content; needs the owner agent_id + expected_version */
  update: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number,
    content: string
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('update', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
      content,
    });
  },

  /** Team-wide skill search */
  search: async (
    teamId: string,
    query: string,
    opts?: { topK?: number; scope?: 'team' }
  ): Promise<Array<SkillSummary & { score: number; snippet: string }>> => {
    const me = await getCurrentUser();
    const res = await skillPost<{ items: Array<SkillSummary & { score: number; snippet: string }> }>('search', {
      user_id: me.user_id,
      team_id: teamId,
      query,
      top_k: opts?.topK ?? 10,
      scope: opts?.scope ?? 'team',
    });
    return res.items;
  },

  /**
   * Fork a skill to an Agent - copy an independent copy with `owner_agent_id` = the target agent.
   *
   * Why fork instead of meta authorization (acl/grant):
   *   - The "pinned assets" tab (SkillsPanel) filters its display by `owner_agent_id`;
   *   - Injection of `<available_skills>` at agent runtime (/skill/listing) likewise filters by
   *     `owner_agent_id`.
   *   Both reads recognize `owner_agent_id`, whereas acl/grant only changes the meta authorization layer and has no effect on either.
   *   So the only mechanism that truly makes a skill belong to an agent is copying a copy with owner = that agent.
   *
   * Naming: the copy keeps the **source skill's original name** with no suffix. The skill uniqueness constraint is
   * (team_id, owner_agent_id, name): the same team allows multiple same-name copies (belonging to different agents),
   * but a duplicate name under the same agent is rejected by the backend (42201) - in which case the error is thrown upward for the caller to report.
   *
   * Implementation: getSkill (source body + manifest) → filesRead (each resource, skipping individual failures) →
   *       create (name=original name, agent_id=target agent i.e. owner).
   */
  forkToAgent: async (
    teamId: string,
    sourceSkillId: string,
    targetAgentId: string
  ): Promise<SkillSummary> => {
    const detail = await skillApi.get(teamId, sourceSkillId);
    const resources: SkillResourcePayload[] = [];
    for (const entry of detail.manifest ?? []) {
      try {
        const f = await skillApi.filesRead(teamId, sourceSkillId, entry.path);
        resources.push({
          path: f.path,
          content: f.content,
          encoding: f.encoding,
          mime_type: f.mime_type || undefined,
          is_executable: entry.is_executable || undefined,
        });
      } catch {
        /* If reading a single resource fails, skip it and do not block the main fork flow */
      }
    }
    return skillApi.create(teamId, targetAgentId, {
      name: detail.name,
      content: detail.content,
      resources: resources.length ? resources : undefined,
      // Lineage: record which source skill this was forked from, so the source can be looked up from the copy and repeated forks avoided.
      metadata: { forked_from: { skill_id: sourceSkillId, name: detail.name } },
    });
  },
};
