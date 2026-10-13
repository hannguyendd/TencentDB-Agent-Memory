/**
 * Knowledge HTTP client -- calls core's /v3/wiki/* and /v3/code-graph/*.
 *
 * Paths and request bodies are strictly aligned with docs/knowledge/knowledge-api.yaml (finalized in 07/08/11).
 * Note: the core router actually listens on `/v3/wiki/*` and `/v3/code-graph/*`,
 * so baseUrl here does not include /v3, and paths carry the /v3 prefix.
 *
 * Same pattern as HttpSkillClient: Bearer + service-id + envelope parsing.
 */
import { CoreUpstreamError } from '../../domain/errors.js';
import type {
  KnowledgeClientPort,
  WikiDetail,
  WikiListResult,
  WikiIngestResult,
  WikiGraphData,
  WikiSearchResult,
  BatchDeleteResult,
  RawFileEntry,
  PageEntry,
  WikiRawReadItem,
  WikiRawWriteFile,
  WikiRawWriteItem,
  WikiRawRmResult,
  WikiPageReadItem,
  WikiPageWriteItem,
  WikiPageWriteResultItem,
  WikiPageRmResult,
  CodeGraphDetail,
  CodeGraphListResult,
  CodeGraphSyncResult,
  CodeGraphToolResult,
  SourceProviderList,
  WikiSourceListResult,
  WikiSourceImportResult,
  SourceCredentialStatus,
  ResourceType,
} from '../ports/knowledge-client-port.js';

export interface KnowledgeClientConfig {
  baseUrl: string;
  authToken: string;
  serviceId?: string;
  timeoutMs?: number;
}

interface CoreEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

export class HttpKnowledgeClient implements KnowledgeClientPort {
  constructor(private readonly cfg: KnowledgeClientConfig) {}

  /**
   * Unified request entry. KS's external-source endpoints (source-provider / source-credential)
   * use GET/DELETE + query, so it cannot support POST only.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts?: { body?: unknown; query?: Record<string, string>; userId?: string; teamId?: string },
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.cfg.authToken) headers.Authorization = `Bearer ${this.cfg.authToken}`;
      if (this.cfg.serviceId) headers['x-tdai-service-id'] = this.cfg.serviceId;
      // Resource-level credential endpoints need team_id (used by KS for authorization gating) + user_id (audit)
      if (opts?.teamId) headers['x-tdai-team-id'] = opts.teamId;
      if (opts?.userId) headers['x-tdai-user-id'] = opts.userId;

      const qs = opts?.query
        ? '?' + new URLSearchParams(
            Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== ''),
          ).toString()
        : '';
      const resp = await fetch(`${this.cfg.baseUrl}${path}${qs}`, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(opts?.body ?? {}),
        signal: ctrl.signal,
      });
      const json = (await resp.json()) as CoreEnvelope<T>;
      if (json.code !== undefined && json.code !== 0) {
        throw new CoreUpstreamError(
          'CORE_UPSTREAM_ERROR',
          resp.status >= 400 ? resp.status : 502,
          json.message || `core error code ${json.code}`,
          json.code,
        );
      }
      if (!resp.ok) {
        throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', resp.status, json.message || `HTTP ${resp.status}`, 0);
      }
      return json.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST convenience wrapper (the vast majority of KS endpoints are POST + JSON body). */
  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  // ═══════════════ External sources (Gongfeng / GitHub / GitLab) ═══════════════
  //
  // All are thin forwards to KS: the single source of truth for the source list and credential storage is KS, and Panel only attaches
  // instance credentials and caller identity. Credentials attach to the **resource** (resource_type + resource_id),
  // decoupled from user/access-key; the team gate is verified by KS using x-tdai-team-id.

  /** List of enabled codegraph sources (data source for the frontend dropdown). */
  async sourceProviderListCode(): Promise<SourceProviderList> {
    return this.request<SourceProviderList>('GET', '/v3/source-provider/code');
  }

  /** List of enabled wiki sources (data source for the frontend dropdown). */
  async sourceProviderListWiki(): Promise<SourceProviderList> {
    return this.request<SourceProviderList>('GET', '/v3/source-provider/wiki');
  }

  /**
   * List the remote document tree (resolveRoot + listPages).
   * Credentials are injected by KS from the credential table by wiki_id; Panel never touches plaintext.
   */
  async wikiSourceList(params: {
    wikiId: string;
    sourceUrl: string;
    providerId: string;
    crawl?: { mode?: 'tree' | 'links'; maxDepth?: number };
    actor: { teamId: string; userId: string };
  }): Promise<WikiSourceListResult> {
    return this.request<WikiSourceListResult>('POST', '/v3/wiki-source/list', {
      body: {
        wiki_id: params.wikiId,
        source_url: params.sourceUrl,
        provider_id: params.providerId,
        ...(params.crawl ? { crawl: params.crawl } : {}),
      },
      ...params.actor,
    });
  }

  /** Import remote documents (fetch + write to disk, without triggering ingest). pageIds omitted -> all non-directory nodes. */
  async wikiSourceImport(params: {
    wikiId: string;
    sourceUrl: string;
    providerId: string;
    pageIds?: string[];
    actor: { teamId: string; userId: string };
  }): Promise<WikiSourceImportResult> {
    return this.request<WikiSourceImportResult>('POST', '/v3/wiki-source/import', {
      body: {
        wiki_id: params.wikiId,
        source_url: params.sourceUrl,
        provider_id: params.providerId,
        ...(params.pageIds ? { page_ids: params.pageIds } : {}),
      },
      ...params.actor,
    });
  }

  /** Current credential status of a resource (metadata only). Not configured -> data.credential is null, passed through directly by the Panel layer. */
  async sourceCredentialStatus(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
  ): Promise<SourceCredentialStatus | null> {
    const res = await this.request<{ configured: boolean; credential: SourceCredentialStatus | null }>(
      'GET',
      '/v3/source-credential/status',
      { query: { resource_type: resourceType, resource_id: resourceId }, ...actor },
    );
    return res.credential;
  }

  /** Write / update a resource's token. The plaintext is forwarded to KS by Panel only within this body and is not logged. */
  async sourceCredentialPut(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
    input: { provider_id: string; cred_kind: string; secret: string; username?: string },
  ): Promise<SourceCredentialStatus> {
    const res = await this.request<{ credential: SourceCredentialStatus }>(
      'PUT',
      '/v3/source-credential/put',
      {
        body: {
          resource_type: resourceType,
          resource_id: resourceId,
          ...input,
        },
        ...actor,
      },
    );
    return res.credential;
  }

  /** Delete a resource's token. */
  async sourceCredentialDelete(
    resourceType: ResourceType,
    resourceId: string,
    actor: { teamId: string; userId: string },
  ): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>('DELETE', '/v3/source-credential/delete', {
      query: { resource_type: resourceType, resource_id: resourceId },
      ...actor,
    });
  }

  // ═══════════════ Wiki · asset layer ═══════════════

  async wikiCreate(
    teamId: string,
    name: string,
    userId?: string,
    sourceUrl?: string,
    sourceType?: string,
  ): Promise<WikiDetail> {
    // source_type / source_url must be sent as a pair: the KS side rejects requests giving only one of them.
    return this.post('/v3/wiki/create', {
      team_id: teamId,
      name,
      user_id: userId,
      ...(sourceUrl && sourceType ? { source_url: sourceUrl, source_type: sourceType } : {}),
    });
  }

  async wikiGet(wikiId: string): Promise<WikiDetail> {
    return this.post('/v3/wiki/get', { wiki_id: wikiId });
  }

  async wikiIngest(wikiId: string, opts?: { onBusy?: 'reject' | 'replace' }): Promise<WikiIngestResult> {
    return this.post('/v3/wiki/ingest', { wiki_id: wikiId, on_busy: opts?.onBusy });
  }

  async wikiDelete(wikiIds: string[]): Promise<BatchDeleteResult> {
    return this.post('/v3/wiki/delete', { wiki_ids: wikiIds });
  }

  async wikiList(teamId: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<WikiListResult> {
    return this.post('/v3/wiki/list', { team_id: teamId, ...opts });
  }

  // ═══════════════ Wiki · raw file layer ═══════════════

  async wikiRawLs(wikiId: string): Promise<{ items: RawFileEntry[] }> {
    return this.post('/v3/wiki/raw/ls', { wiki_id: wikiId });
  }

  async wikiRawRead(wikiId: string, filenames: string[]): Promise<{ items: WikiRawReadItem[] }> {
    return this.post('/v3/wiki/raw/read', { wiki_id: wikiId, filenames });
  }

  async wikiRawWrite(teamId: string, wikiId: string, files: WikiRawWriteFile[], userId?: string): Promise<{ items: WikiRawWriteItem[] }> {
    return this.post('/v3/wiki/raw/write', { team_id: teamId, user_id: userId, wiki_id: wikiId, files });
  }

  async wikiRawRm(teamId: string, wikiId: string, filenames: string[], userId?: string): Promise<WikiRawRmResult> {
    return this.post('/v3/wiki/raw/rm', { team_id: teamId, user_id: userId, wiki_id: wikiId, filenames });
  }

  // ═══════════════ Wiki · page file layer ═══════════════

  async wikiPageLs(wikiId: string): Promise<{ items: PageEntry[] }> {
    return this.post('/v3/wiki/page/ls', { wiki_id: wikiId });
  }

  async wikiPageRead(wikiId: string, refs: string[]): Promise<{ items: WikiPageReadItem[] }> {
    return this.post('/v3/wiki/page/read', { wiki_id: wikiId, refs });
  }

  async wikiPageWrite(teamId: string, wikiId: string, pages: WikiPageWriteItem[], userId?: string): Promise<{ items: WikiPageWriteResultItem[] }> {
    return this.post('/v3/wiki/page/write', { team_id: teamId, user_id: userId, wiki_id: wikiId, pages });
  }

  async wikiPageRm(teamId: string, wikiId: string, refs: string[], userId?: string): Promise<WikiPageRmResult> {
    return this.post('/v3/wiki/page/rm', { team_id: teamId, user_id: userId, wiki_id: wikiId, refs });
  }

  // ═══════════════ Wiki · derived views ═══════════════

  async wikiGraph(wikiId: string): Promise<WikiGraphData> {
    return this.post('/v3/wiki/graph', { wiki_id: wikiId });
  }

  async wikiSearch(wikiId: string, query: string, limit?: number, graph?: { hop?: number; decay?: number; minScore?: number }): Promise<WikiSearchResult> {
    return this.post('/v3/wiki/search', { wiki_id: wikiId, query, limit: limit ?? 20, ...(graph && Object.keys(graph).length > 0 ? { graph } : {}) });
  }

  async wikiUpdateMeta(wikiId: string, patch: { name?: string; summary?: string | null }): Promise<WikiDetail> {
    return this.post('/v3/wiki/update-meta', { wiki_id: wikiId, ...patch });
  }

  // ═══════════════ Code-Graph ═══════════════

  async codeGraphCreate(
    teamId: string,
    repoUrl: string,
    branch?: string,
    userId?: string,
    repoName?: string,
    opts?: { providerId?: string; secret?: string; username?: string },
  ): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/create', {
      team_id: teamId,
      user_id: userId,
      repo_url: repoUrl,
      branch: branch ?? 'main',
      repo_name: repoName,
      ...(opts?.providerId && opts.secret
        ? {
            provider_id: opts.providerId,
            secret: opts.secret,
            ...(opts.username ? { username: opts.username } : {}),
          }
        : {}),
    });
  }

  async codeGraphList(teamId: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<CodeGraphListResult> {
    return this.post('/v3/code-graph/list', { team_id: teamId, ...opts });
  }

  async codeGraphGet(codeGraphId: string): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/get', { code_graph_id: codeGraphId });
  }

  async codeGraphSync(codeGraphId: string): Promise<CodeGraphSyncResult> {
    return this.post('/v3/code-graph/sync', { code_graph_id: codeGraphId });
  }

  async codeGraphDelete(codeGraphIds: string[]): Promise<BatchDeleteResult> {
    return this.post('/v3/code-graph/delete', { code_graph_ids: codeGraphIds });
  }

  async codeGraphUpdateMeta(codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/update-meta', { code_graph_id: codeGraphId, ...patch });
  }

  async codeGraphQuery(codeGraphId: string, tool: string, params: Record<string, unknown>): Promise<CodeGraphToolResult> {
    return this.post(`/v3/code-graph/${tool}`, { code_graph_id: codeGraphId, ...params });
  }
}
