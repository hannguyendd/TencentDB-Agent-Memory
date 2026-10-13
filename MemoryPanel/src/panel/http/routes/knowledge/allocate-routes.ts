/**
 * /api/v1/knowledge/allocate | unbind | agent-fixed | set-visibility | grant
 *
 * req#3 allocation: bind a knowledge meta_asset to an agent / set visibility / grant authorization, all via the meta
 * authoritative system (ForCaller). Modeled after chat-memory allocate/unbind: list -> append/remove -> set
 * (agent-fixed-asset has no incremental endpoint).
 *
 * injection_mode = 'tool' (knowledge is tool-style injection; the Proxy renders <knowledge_tools>).
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaEnvelope } from '../../../kernel/envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import {
  buildCtx,
  readJson,
  str,
  okEnvelope,
  resolveCallerUserId,
  isTeamMember,
  fetchAllMetaListItems,
  ASSET_TYPE_WIKI,
  ASSET_TYPE_CODE_GRAPH,
} from './common.js';

interface AssetRaw {
  asset_id: string;
  team_id: string;
  asset_type: string;
  owner_user_id: string;
  visibility: string;
}
interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
}
interface BindingRaw {
  asset_id: string;
  asset_type: string;
  injection_mode?: string;
  priority?: number;
  created_by?: string;
}

const KNOWLEDGE_ASSET_TYPES = [ASSET_TYPE_WIKI, ASSET_TYPE_CODE_GRAPH];
const VALID_VISIBILITY = ['private', 'team', 'restricted', 'agent', 'task'];

export function registerKnowledgeAllocateRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // Allocate: bind a knowledge asset to an agent
  api.post('/knowledge/allocate', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    const agentId = str(body, 'agent_id');
    const teamId = str(body, 'team_id');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    const caller = await resolveCallerUserId(deps, ctx);
    if (!caller) return respondControlError(c, 401, 'INVALID_USER_KEY');
    if (!(await isTeamMember(deps, ctx, teamId, caller))) {
      return respondControlError(c, 403, 'NOT_TEAM_MEMBER');
    }

    const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: knowledgeId }, ctx);
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, 'KNOWLEDGE_NOT_FOUND');
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (!KNOWLEDGE_ASSET_TYPES.includes(asset.asset_type)) {
      return respondControlError(c, 400, 'NOT_KNOWLEDGE_ASSET');
    }
    if (asset.team_id !== teamId) return respondControlError(c, 400, 'TEAM_MISMATCH');

    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.team_id !== teamId) return respondControlError(c, 400, 'AGENT_NOT_IN_TEAM');

    // Key: all bindings must be fetched via paginated aggregation. The kernel DEFAULT_PAGINATION=20,
    // and without passing a limit, when an agent already has >=21 bound assets the old bindings beyond the first 20 get truncated,
    // and the full-replace set after append would silently overwrite those old bindings.
    // Also: a list error must be passed through rather than treated as an "empty list", otherwise the full-replace set would wipe the existing bindings.
    let bindListError: MetaEnvelope<unknown> | null = null;
    const bindings = await fetchAllMetaListItems<BindingRaw>(
      deps,
      ctx,
      'agent-fixed-asset/list',
      { agent_id: agentId },
      (env) => {
        bindListError = env;
      },
    );
    if (bindListError) return respondEnvelope(c, bindListError);
    if (bindings.some((b) => b.asset_id === knowledgeId)) {
      return respondControlError(c, 409, 'ALREADY_ALLOCATED');
    }

    const newBindings = [
      ...bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'summary',
        priority: b.priority ?? 50,
        created_by: b.created_by,
      })),
      { asset_id: knowledgeId, asset_type: asset.asset_type, injection_mode: 'tool', priority: 50, created_by: caller },
    ];
    const setEnv = await deps.metaKernel.invoke('agent-fixed-asset/set', { agent_id: agentId, bindings: newBindings }, ctx);
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(c, okEnvelope(c, { allocated: true, agent_id: agentId, knowledge_id: knowledgeId }));
  });

  // Unbind
  api.post('/knowledge/unbind', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    const agentId = str(body, 'agent_id');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    const caller = await resolveCallerUserId(deps, ctx);
    if (!caller) return respondControlError(c, 401, 'INVALID_USER_KEY');
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw | null;
    if (!agent) return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    if (agent.owner_user_id !== caller) return respondControlError(c, 403, 'NOT_YOUR_AGENT');

    // Same as allocate: must page through everything, otherwise bindings not on the first page can never be fully unbound;
    // pass list errors through, to avoid being misjudged as BINDING_NOT_FOUND.
    let bindListError: MetaEnvelope<unknown> | null = null;
    const bindings = await fetchAllMetaListItems<BindingRaw>(
      deps,
      ctx,
      'agent-fixed-asset/list',
      { agent_id: agentId },
      (env) => {
        bindListError = env;
      },
    );
    if (bindListError) return respondEnvelope(c, bindListError);
    const remaining = bindings.filter((b) => b.asset_id !== knowledgeId);
    if (remaining.length === bindings.length) return respondControlError(c, 404, 'BINDING_NOT_FOUND');

    const setEnv = await deps.metaKernel.invoke(
      'agent-fixed-asset/set',
      {
        agent_id: agentId,
        bindings: remaining.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? 'summary',
          priority: b.priority ?? 50,
          created_by: b.created_by,
        })),
      },
      ctx,
    );
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(c, okEnvelope(c, { unbound: true, agent_id: agentId, knowledge_id: knowledgeId }));
  });

  // Fixed assets tab: list the wiki / code_graph bound to the agent
  api.post('/knowledge/agent-fixed', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = str(body, 'agent_id');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    const isOwner = agent.owner_user_id === meUserId;
    if (!isOwner) {
      const member = await isTeamMember(deps, ctx, agent.team_id, meUserId);
      if (!member) return respondControlError(c, 403, 'NOT_TEAM_MEMBER');
    }
    const applyVisibility = !isOwner;

    // Type filter pushed down: core `agent-fixed-asset/list-with-detail` supports
    // the `asset_types` parameter (v3-meta-schemas.ts:fixedAssetListWithDetailSchema),
    // filtering by type at the SQL layer -- irrelevant types (skill / chat_memory) do not consume pagination quota.
    // The earlier approach of "fetch everything then filter(KNOWLEDGE_ASSET_TYPES.includes(...)) in memory",
    // on agents with very many skills (e.g. the real online case of 519 skills) would waste 5+
    // kernel calls just to page past skills; and if wiki/code_graph bindings sorted by
    // priority DESC/created_at DESC fall beyond position 500, they would likewise be cut by the hard cap
    // leaving the "fixed assets" tab blank.
    // Pass list errors through, to avoid showing "query failed" as "no bindings".
    let listError: MetaEnvelope<unknown> | null = null;
    const rawItems = await fetchAllMetaListItems<FixedAssetDetailRaw>(
      deps,
      ctx,
      'agent-fixed-asset/list-with-detail',
      {
        agent_id: agentId,
        apply_visibility_filter: applyVisibility,
        touch_usage: false,
        asset_types: KNOWLEDGE_ASSET_TYPES,
      },
      (env) => {
        listError = env;
      },
    );
    if (listError) return respondEnvelope(c, listError);

    interface FixedAssetDetailRaw {
      asset_id: string;
      asset_type: string;
      name: string;
      description?: string | null;
      status: string;
      visibility: string;
      created_at: string;
    }
    let items = rawItems.filter(
      (it) => it.status !== 'archived' && it.status !== 'deprecated' && it.status !== 'failed',
    );

    if (!isOwner) {
      items = items.filter((it) => it.visibility === 'team');
    }

    const out = items.map((it) => ({
      knowledge_id: it.asset_id,
      asset_type: it.asset_type,
      name: it.name,
      description: it.description ?? null,
      status: it.status,
      visibility: it.visibility,
      agent_id: agentId,
    }));
    return respondEnvelope(c, okEnvelope(c, { items: out, total: out.length }));
  });

  // Set visibility (asset/update; ForCaller owner-only is guaranteed by the kernel)
  api.post('/knowledge/set-visibility', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    const visibility = str(body, 'visibility');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!visibility || !VALID_VISIBILITY.includes(visibility)) {
      return respondControlError(c, 400, 'INVALID_VISIBILITY');
    }
    const env = await deps.metaKernel.invoke('asset/update', { asset_id: knowledgeId, visibility }, ctx);
    return respondEnvelope(c, env);
  });

  // Authorization (acl/grant; owner-only is guaranteed by the kernel)
  api.post('/knowledge/grant', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    const subjectType = str(body, 'subject_type');
    const subjectId = str(body, 'subject_id');
    const permission = str(body, 'permission');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!subjectType || !subjectId || !permission) {
      return respondControlError(c, 400, 'MISSING_GRANT_FIELDS');
    }
    const env = await deps.metaKernel.invoke(
      'acl/grant',
      { asset_id: knowledgeId, subject_type: subjectType, subject_id: subjectId, permission },
      ctx,
    );
    return respondEnvelope(c, env);
  });
}
