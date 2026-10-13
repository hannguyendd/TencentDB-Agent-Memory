/**
 * /api/v1/knowledge/wiki/* -- Panel Wiki business routes (stateless).
 *
 * Implements the frozen contract docs/api/knowledge-panel-api.md §2.0 minimal Wiki endpoint set, passing through to
 * HttpKnowledgeClient -> KS /v3/wiki/*. Style is consistent with chat-memory.ts:
 * validatePanelMetaHeaders → auth/verify(+team-member) → KS → envelope。
 *
 * Gating:
 *   - endpoints with team_id (list/create/raw/write) -> require team membership;
 *   - id-only endpoints (get/ingest/delete/graph/page/search/raw/ls) -> require a valid caller,
 *     and KS isolates logically by x-tdai-service-id + team.
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import type { WikiRawWriteFile } from '../../../kernel/ports/knowledge-client-port.js';
import { respondEnvelope } from '../../envelope.js';
import {
  buildCtx,
  readJson,
  str,
  strArray,
  okEnvelope,
  requireTeamMember,
  requireKnowledgeRead,
  requireWikiWritable,
  runKs,
  ensureKnowledgeAsset,
  deleteKnowledgeCascade,
  ASSET_TYPE_WIKI,
} from './common.js';

// Upload size limits (shared by W9 raw/write and import-and-ingest, so the composite endpoint cannot bypass the W9 limits)
const MAX_FILE_SIZE = 512 * 1024;        // 512KB per file
const MAX_FILES_PER_REQUEST = 10;        // at most 10 files per request
const MAX_TOTAL_SIZE = 5 * 1024 * 1024;  // 5MB total per request

/** Check whether a batch of files to write meets the size limits; returns an error code on violation, otherwise null. */
function checkFileSizes(files: WikiRawWriteFile[]): string | null {
  if (files.length > MAX_FILES_PER_REQUEST) {
    return `TOO_MANY_FILES (max ${MAX_FILES_PER_REQUEST})`;
  }
  let totalSize = 0;
  for (const f of files) {
    const size = Buffer.byteLength(f?.content ?? '', 'utf-8');
    if (size > MAX_FILE_SIZE) {
      return `FILE_TOO_LARGE (max ${MAX_FILE_SIZE} bytes, got ${size})`;
    }
    totalSize += size;
  }
  if (totalSize > MAX_TOTAL_SIZE) {
    return `TOTAL_TOO_LARGE (max ${MAX_TOTAL_SIZE} bytes, got ${totalSize})`;
  }
  return null;
}

export function registerKnowledgeWikiRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // W2 list -- @deprecated the panel UI now uses team-assets / my-assets
  api.post('/knowledge/wiki/list', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const opts = {
      status: str(body, 'status') ?? undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      offset: typeof body.offset === 'number' ? body.offset : undefined,
    };
    return runKs(c, () => kc.wikiList(teamId, opts));
  });

  // W1 create -- team gated; KS create -> get wiki_id -> idempotently register meta_asset (asset_id=wiki_id)
  api.post('/knowledge/wiki/create', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const name = str(body, 'name');
    const sourceUrl = str(body, 'source_url') ?? undefined;
    const sourceType = str(body, 'source_type') ?? undefined;
    // Paired validation: giving only one is a frontend/caller bug; failing early beats silently dropping the source.
    if (!!sourceUrl !== !!sourceType) {
      return respondControlError(c, 400, 'SOURCE_TYPE_AND_URL_MUST_BE_PAIRED');
    }
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!name) return respondControlError(c, 400, 'MISSING_NAME');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    let detail;
    try {
      detail = await kc.wikiCreate(teamId, name, gate.userId, sourceUrl, sourceType);
    } catch (err) {
      return runKs(c, () => Promise.reject(err));
    }
    // Register meta_asset (permission authority); asset_id == wiki_id (foreign-key join constraint)
    // Registered at creation so the frontend can immediately see the wiki being extracted; not registered again when the callback returns.
    const reg = await ensureKnowledgeAsset(deps, ctx, {
      assetId: detail.wiki_id,
      teamId,
      assetType: ASSET_TYPE_WIKI,
      name: detail.name,
      ownerUserId: gate.userId,
      serviceUrl: detail.service_url,
    });
    if (!reg.ok) return respondEnvelope(c, reg.env); // user retries; KS self-heals idempotently
    return respondEnvelope(c, okEnvelope(c, detail));
  });

  // W4 ingest -- id-only (any team member) + empty wiki check
  //
  // The gate uses requireWikiWritable rather than action:'write': a wiki is a team-shared asset,
  // extraction is a content contribution, and any member of the same team should be able to trigger it (otherwise "a library created by A can be seen by B but not extracted").
  api.post('/knowledge/wiki/ingest', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireWikiWritable(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    // Forbid ingest on an empty wiki: first query raw/ls, and reject if there are no source files
    try {
      const listing = await kc.wikiRawLs(wikiId);
      if (!listing.items || listing.items.length === 0) {
        return respondControlError(c, 400, 'WIKI_EMPTY_NO_SOURCES');
      }
    } catch {
      // A raw/ls query failure does not block ingest (KS also has defenses)
    }
    return runKs(c, () => kc.wikiIngest(wikiId));
  });

  // W3 get -- id-only (read permission required); aggregates Panel in-memory ingest progress (no new endpoint)
  api.post('/knowledge/wiki/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, async () => {
      const detail = await kc.wikiGet(wikiId);
      const status = (detail as { status?: string } | null)?.status;
      const stored =
        status === 'processing' ? deps.ingestProgressStore.get(wikiId) : null;
      return {
        ...(detail as unknown as Record<string, unknown>),
        progress: stored,
      };
    });
  });

  // W5 delete -- delete in three places: KS + entity_knowledge detail + meta_asset (see §0.6)
  api.post('/knowledge/wiki/delete', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiIds = strArray(body, 'wiki_ids');
    if (wikiIds.length === 0) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    for (const wikiId of wikiIds) {
      const gate = await requireKnowledgeRead(deps, c, ctx, wikiId, { action: 'write' });
      if ('error' in gate) return gate.error;
    }
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, async () => {
      const result = await kc.wikiDelete(wikiIds);
      await deleteKnowledgeCascade(deps, ctx, wikiIds);
      return result;
    });
  });

  // W15 graph — id-only
  api.post('/knowledge/wiki/graph', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiGraph(wikiId));
  });

  // W11 page/ls — id-only
  api.post('/knowledge/wiki/page/ls', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageLs(wikiId));
  });

  // W12 page/read — id-only
  api.post('/knowledge/wiki/page/read', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const refs = strArray(body, 'refs');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (refs.length === 0) return respondControlError(c, 400, 'MISSING_REFS');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageRead(wikiId, refs));
  });

  // W14 page/rm -- id-only + write permission; KS needs team_id, taken from meta_asset.team_id
  api.post('/knowledge/wiki/page/rm', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const refs = strArray(body, 'refs');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (refs.length === 0) return respondControlError(c, 400, 'MISSING_REFS');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId, { action: 'write' });
    if ('error' in gate) return gate.error;
    const teamId = gate.asset?.team_id;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageRm(teamId, wikiId, refs, gate.userId));
  });

  // W16 search — id-only
  api.post('/knowledge/wiki/search', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const query = str(body, 'query');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!query) return respondControlError(c, 400, 'MISSING_QUERY');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiSearch(wikiId, query, limit));
  });

  // W7 raw/ls — id-only
  api.post('/knowledge/wiki/raw/ls', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawLs(wikiId));
  });

  // W8 raw/read — id-only
  api.post('/knowledge/wiki/raw/read', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const filenames = Array.isArray(body.filenames) ? (body.filenames as string[]) : [];
    if (filenames.length === 0) return respondControlError(c, 400, 'MISSING_FILENAMES');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawRead(wikiId, filenames));
  });

  // W10 raw/rm -- id-only + any team member; KS needs team_id, taken from meta_asset.team_id
  //
  // Keeps the same standard as raw/write (requireTeamMember): whoever can write materials can delete them.
  api.post('/knowledge/wiki/raw/rm', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const filenames = Array.isArray(body.filenames) ? (body.filenames as string[]) : [];
    if (filenames.length === 0) return respondControlError(c, 400, 'MISSING_FILENAMES');
    const gate = await requireWikiWritable(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const teamId = gate.asset?.team_id;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawRm(teamId, wikiId, filenames, gate.userId));
  });

  // W9 raw/write -- team gate + upload size limits
  api.post('/knowledge/wiki/raw/write', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const wikiId = str(body, 'wiki_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const files = Array.isArray(body.files) ? (body.files as WikiRawWriteFile[]) : [];
    if (files.length === 0) return respondControlError(c, 400, 'MISSING_FILES');
    // Size validation reuses the module-level checkFileSizes, same source as import-and-ingest:
    // thresholds and error codes are defined in only one place, avoiding the two being maintained separately and the composite endpoint bypassing the W9 limits.
    const sizeErr = checkFileSizes(files);
    if (sizeErr) return respondControlError(c, 413, sizeErr);
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawWrite(teamId, wikiId, files, gate.userId));
  });

  // W17 import-and-ingest -- design 2026-09-21: the single entry point after merging the detail page's "Add" + "Ingest".
  //
  // One call does: write raw (optional) -> trigger ingest (onBusy:'replace'; KS atomically completes
  // "cancel the old task + enqueue the new task"). Panel does no separate cancel step and no bounded retry.
  //
  // mode maps one-to-one to the Modal's three tabs:
  //   files | markdown -> wikiRawWrite; external -> wikiSourceImport; reingest -> skip writing raw.
  api.post('/knowledge/wiki/import-and-ingest', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const mode = str(body, 'mode');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!mode || !['files', 'markdown', 'external', 'reingest'].includes(mode)) {
      return respondControlError(c, 400, 'INVALID_MODE');
    }
    // Gate: any team member (requireWikiWritable) -- any member of the same team can import documents
    // into the shared wiki, no longer required to be the wiki's owner.
    const gate = await requireWikiWritable(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    // teamId comes from meta_asset (same pattern as page/rm, raw/rm); the body is not trusted.
    const teamId = gate.asset?.team_id;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const kc = deps.knowledgeClientFactory(ctx.instanceId);

    const startedAt = Date.now();
    let rawPersisted = false;
    let writeMs = 0;
    let yieldMs = 0;

    try {
      // (0) No wait-and-yield: KS rawWrite/rawWriteMany already allow writes in the processing state
      //    (design 2026-09-21 "new import overwrites old import"), so there is no longer polling here to wait for
      //    the old task to settle. Cancelling the old task is done by the subsequent ingest(onBusy:'replace').
      // (1) Write raw (skipped in reingest mode)
      // (1) Write raw (skipped in reingest mode)
      if (mode === 'files' || mode === 'markdown') {
        const files = Array.isArray(body.files)
          ? (body.files as WikiRawWriteFile[])
          : Array.isArray(body.markdown)
            ? (body.markdown as WikiRawWriteFile[])
            : [];
        if (files.length === 0) return respondControlError(c, 400, 'MISSING_FILES');
        // Field validation: KS requires { filename, content }; a missing filename would be reported on the KS side as
        // "filename is required for each file". Intercept it early at the Panel layer with a clear error,
        // to avoid this kind of contract mismatch silently passing through to KS.
        const badFile = files.find(
          (f) => !f || typeof f.filename !== 'string' || f.filename.trim() === '' || typeof f.content !== 'string',
        );
        if (badFile) return respondControlError(c, 400, 'INVALID_FILE_ITEM');
        const sizeErr = checkFileSizes(files);
        if (sizeErr) return respondControlError(c, 413, sizeErr);

        const w0 = Date.now();
        await kc.wikiRawWrite(teamId, wikiId, files, gate.userId);
        writeMs = Date.now() - w0;
        rawPersisted = true;
      } else if (mode === 'external') {
        const sourceUrl = str(body, 'source_url');
        const providerId = str(body, 'provider_id');
        if (!sourceUrl) return respondControlError(c, 400, 'MISSING_SOURCE_URL');
        if (!providerId) return respondControlError(c, 400, 'MISSING_PROVIDER_ID');
        const pageIds = Array.isArray(body.page_ids)
          ? (body.page_ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined;

        const w0 = Date.now();
        await kc.wikiSourceImport({
          wikiId,
          sourceUrl,
          providerId,
          pageIds,
          actor: { teamId, userId: gate.userId },
        });
        writeMs = Date.now() - w0;
        rawPersisted = true;
      }

      // (2) Trigger ingest: onBusy='replace' lets KS atomically complete "cancel the old task + enqueue the new task"
      const i0 = Date.now();
      const task = await kc.wikiIngest(wikiId, { onBusy: 'replace' });
      const ingestMs = Date.now() - i0;

      deps.logger.info('[wiki.import_and_ingest] ok', {
        wiki_id: wikiId,
        mode,
        write_ms: writeMs,
        ingest_ms: ingestMs,
        total_ms: Date.now() - startedAt,
        is_replace: task.queued === true,
        yield_ms: yieldMs,
        raw_persisted: rawPersisted,
      });

      return respondEnvelope(
        c,
        okEnvelope(c, {
          ok: true,
          wiki_id: wikiId,
          ingest_task_id: task.wiki_id,
          status: task.status,
          queued: task.queued === true,
        }),
      );
    } catch (err) {
      const failedAt = rawPersisted ? 'ingest' : 'write';
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error('[wiki.import_and_ingest] failed', {
        wiki_id: wikiId,
        mode,
        write_ms: writeMs,
        yield_ms: yieldMs,
        total_ms: Date.now() - startedAt,
        failed_at: failedAt,
        raw_persisted: rawPersisted,
        error: message,
      });
      return respondEnvelope(
        c,
        okEnvelope(c, {
          ok: false,
          wiki_id: wikiId,
          failed_at: failedAt,
          error_code: 'IMPORT_AND_INGEST_FAILED',
          error_message: message,
          raw_persisted: rawPersisted,
        }),
      );
    }
  });
}
