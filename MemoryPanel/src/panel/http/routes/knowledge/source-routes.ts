/**
 * /api/v1/knowledge/source/* -- thin wrapper for external sources (Gongfeng / GitHub / GitLab).
 *
 * Design constraint: Panel contains no business logic; the single source of truth for the source list and credential storage is KS.
 * Panel only does three things:
 *   1. Verify the caller's identity (team gate + user_id)
 *   2. Forward to KS with instance credentials, x-tdai-team-id and x-tdai-user-id
 *   3. Return KS's envelope as-is
 *
 * Credentials are attached to the **resource** (resource_type + resource_id), decoupled from users.
 * The team gate is done by KS (verifying resource_id belongs to x-tdai-team-id); Panel only passes through
 * gate.userId + gate.teamId after requireTeamMember passes.
 *
 * Security boundary:
 *   - The plaintext token goes **only** through the PUT request body, forwarded to KS by Panel; it is not written to Panel logs and not echoed back.
 *   - Panel does not accept user_id / team_id in the body, to prevent A from modifying B's resources.
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import type { ResourceType } from '../../../kernel/ports/knowledge-client-port.js';
import {
  buildCtx,
  readJson,
  str,
  requireTeamMember,
  runKs,
} from './common.js';

const VALID_TYPES: readonly ResourceType[] = ['code-graph', 'wiki'];

/** Parse and validate resource_type + resource_id from body / query. */
function parseRef(body: Record<string, unknown>): { type: ResourceType; id: string } | string {
  const type = str(body, 'resource_type');
  const id = str(body, 'resource_id');
  if (!type || !VALID_TYPES.includes(type as ResourceType)) return 'INVALID_RESOURCE_TYPE';
  if (!id) return 'MISSING_RESOURCE_ID';
  return { type: type as ResourceType, id };
}

export function registerKnowledgeSourceRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // List of enabled codegraph sources (data source for the frontend dropdown)
  api.post('/knowledge/source/providers', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.sourceProviderListCode());
  });

  // List of enabled wiki sources (data source for the frontend dropdown)
  api.post('/knowledge/source/wiki-providers', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.sourceProviderListWiki());
  });

  // List the remote document tree (selected when registering a wiki)
  // body: { team_id, wiki_id, source_url, provider_id }
  api.post('/knowledge/source/wiki/list', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const wikiId = str(body, 'wiki_id');
    const sourceUrl = str(body, 'source_url');
    const providerId = str(body, 'provider_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!sourceUrl) return respondControlError(c, 400, 'MISSING_SOURCE_URL');
    if (!providerId) return respondControlError(c, 400, 'MISSING_PROVIDER_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () =>
      kc.wikiSourceList({
        wikiId,
        sourceUrl,
        providerId,
        actor: { teamId, userId: gate.userId },
      }),
    );
  });

  // Import remote documents (fetch + write to disk, without triggering ingest)
  // body: { team_id, wiki_id, source_url, provider_id, page_ids? }
  api.post('/knowledge/source/wiki/import', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const wikiId = str(body, 'wiki_id');
    const sourceUrl = str(body, 'source_url');
    const providerId = str(body, 'provider_id');
    const pageIds = Array.isArray(body['page_ids'])
      ? (body['page_ids'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!sourceUrl) return respondControlError(c, 400, 'MISSING_SOURCE_URL');
    if (!providerId) return respondControlError(c, 400, 'MISSING_PROVIDER_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () =>
      kc.wikiSourceImport({
        wikiId,
        sourceUrl,
        providerId,
        pageIds,
        actor: { teamId, userId: gate.userId },
      }),
    );
  });

  // Credential status of a resource (metadata only)
  // body: { team_id, resource_type, resource_id }
  api.post('/knowledge/source/credential/status', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const ref = parseRef(body);
    if (typeof ref === 'string') return respondControlError(c, 400, ref);
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () =>
      kc
        .sourceCredentialStatus(ref.type, ref.id, { teamId, userId: gate.userId })
        .then((credential) => ({ configured: !!credential, credential })),
    );
  });

  // Write / update the token
  // body: { team_id, resource_type, resource_id, provider_id, secret, cred_kind?, username? }
  // WARNING: the secret is only forwarded to KS within this request body; not logged, not echoed back, not persisted in any Panel storage.
  api.post('/knowledge/source/credential', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const ref = parseRef(body);
    if (typeof ref === 'string') return respondControlError(c, 400, ref);
    const providerId = str(body, 'provider_id');
    const secret = str(body, 'secret');
    const kind = str(body, 'cred_kind') ?? 'bearer';
    if (!providerId) return respondControlError(c, 400, 'MISSING_PROVIDER_ID');
    if (!secret) return respondControlError(c, 400, 'MISSING_SECRET');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const username = str(body, 'username') ?? undefined;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    // Only return the metadata given by KS (KS guarantees it contains no secret); do not echo the request body.
    return runKs(c, () =>
      kc.sourceCredentialPut(ref.type, ref.id, { teamId, userId: gate.userId }, {
        provider_id: providerId,
        cred_kind: kind,
        secret,
        username,
      }),
    );
  });

  // Delete the token
  // body: { team_id, resource_type, resource_id }
  api.post('/knowledge/source/credential/delete', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const ref = parseRef(body);
    if (typeof ref === 'string') return respondControlError(c, 400, ref);
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () =>
      kc.sourceCredentialDelete(ref.type, ref.id, { teamId, userId: gate.userId }),
    );
  });
}
