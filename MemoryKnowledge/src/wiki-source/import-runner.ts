/**
 * wiki import runner — fetch remote documents → write to disk (does not trigger ingest).
 *
 * Doc §3.1 step ⑤ spec:
 *   - Batched fetching: 20 per batch (fetchPages batch preferred; fall back to one by one if unsupported)
 *   - On-disk filename `<title>.md`: readability first; on duplicate/empty titles, dedupe or fall back to the external id (see buildFilename)
 *   - Batched writes: ≤10 files / ≤5MB (constrained by wikiService.rawWriteMany)
 *   - Delay between documents: WIKI_IMPORT_PAGE_DELAY_MS (default 200ms, to guard against external API rate limits)
 */

import type { WikiSourceRegistry } from "./registry.js";
import type { RemotePageContent, SourceContext, WikiSourceProvider } from "./types.js";
import type { RawWriteManyItem, WriteOutcome } from "../store/wiki-service.js";

/**
 * Minimal interface of the wiki service that writes to disk (easy to substitute in tests).
 *
 * The real implementation WikiService.rawWriteMany returns WriteOutcome<RawWriteManyItem[]>:
 *   - success → array of written items (length = number of files written)
 *   - wiki does not exist → null
 *   - currently processing → "processing"
 */
/**
 * Reuse the real WriteOutcome to avoid a local enum missing failure states
 * (the real definition includes null / "processing" / "invalid_path" / "forbidden_path" / "too_large").
 */
export type RawWriteOutcome = WriteOutcome<RawWriteManyItem[]>;

export interface WikiServiceLike {
  rawWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: Array<{ filename: string; content: string }>,
  ): RawWriteOutcome | Promise<RawWriteOutcome>;

  /**
   * Stable filename mapping (optional). Implemented by WikiService: persists externalId → filename
   * to the wiki directory so that **cross-round imports** reuse the same filename.
   *
   * Why needed: the on-disk filename is taken from the title, and titles change. Scheduled sync re-pulls everything each round,
   * and usedNames dedupe is only valid within a single round, so a remote rename leads to:
   *   new title → new file; another doc still using the old title → reuses the old name and overwrites → content mix-up + leftovers.
   *
   * Not implemented (test stubs / old implementations) → degrades to the old behavior of generating by title.
   */
  readImportNameMap?(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
  ): Record<string, string>;
  writeImportNameMap?(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
    map: Record<string, string>,
  ): void;
}

const BATCH_SIZE = 20;
const WRITE_BATCH_FILES = 10;
const WRITE_BATCH_BYTES = 5 * 1024 * 1024;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export interface ImportParams {
  registry: WikiSourceRegistry;
  wikiService: WikiServiceLike;
  providerId: string;
  secret: string;
  username?: string;
  serviceId: string;
  teamId: string;
  wikiId: string;
  sourceUrl: string;
  /** Pages to import; omitted → all non-directory nodes. */
  pageIds?: string[];
}

export interface ImportResult {
  imported: number;
  skippedDirs: number;
  failed: Array<{ id: string; error: string }>;
  warnings: string[];
}

export async function runImport(p: ImportParams): Promise<ImportResult> {
  const { provider, ctx } = p.registry.contextFor(p.providerId, p.secret, p.username);

  const root = await provider.resolveRoot(ctx, p.sourceUrl);
  const all = await provider.listPages(ctx, root);

  // Directory nodes cannot be downloaded
  const targets = p.pageIds?.length
    ? all.filter((n) => !n.isDir && p.pageIds!.includes(n.externalId))
    : all.filter((n) => !n.isDir);
  const skippedDirs = all.length - targets.length;

  const pageDelayMs = Number(process.env.WIKI_IMPORT_PAGE_DELAY_MS ?? 200) || 0;

  const failed: Array<{ id: string; error: string }> = [];
  const warnings: string[] = [];
  let imported = 0;
  // Kept across the whole import round, to avoid different batches producing same-named files that overwrite each other
  const usedNames = new Set<string>();
  // Titles from the listing stage (listPages) are reliable, whereas content from fetchPage often has no title
  // (many platforms' content APIs return only the body, without a title), so on-disk naming prefers the title here as a fallback.
  const titleById = new Map(targets.map((t) => [t.externalId, t.title]));

  // ── Stable filename: externalId → filename (reused across rounds) ──
  // Titles change and can't serve as identity; documents already imported always reuse their historical filename.
  const canUseMap =
    typeof p.wikiService.readImportNameMap === "function" &&
    typeof p.wikiService.writeImportNameMap === "function";
  const nameByExternalId: Record<string, string> | null = canUseMap
    ? p.wikiService.readImportNameMap!(p.serviceId, p.teamId, p.wikiId, p.providerId)
    : null;
  if (nameByExternalId) {
    // Historical filenames claim their seats first: prevent new documents from generating same-named files that displace the old document's slot
    for (const fn of Object.values(nameByExternalId)) {
      if (fn) usedNames.add(fn);
    }
  }

  for (const batch of chunk(targets, BATCH_SIZE)) {
    const ids = batch.map((t) => t.externalId);

    let contents: RemotePageContent[];
    if (provider.fetchPages) {
      try {
        contents = await provider.fetchPages(ctx, ids);
      } catch (err) {
        // Batch failed → fall back to one by one
        warnings.push(
          `batch fetch failed, falling back to per-page: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        contents = await fetchOneByOne(provider, ctx, ids, failed, pageDelayMs);
      }
    } else {
      contents = await fetchOneByOne(provider, ctx, ids, failed, pageDelayMs);
    }

    for (const c of contents) {
      if (c.fidelity === "lossy") warnings.push(`${c.externalId}: content lossy`);
    }

    // Write to disk: filename uses the title (readable); the external id is only used as a fallback for name collisions
    const files = contents
      .filter((c) => c.markdown)
      .map((c) => {
        // c.title may be empty (the provider returns only the body); fall back to the listing-stage title
        const title = c.title || titleById.get(c.externalId);
        // Already imported → reuse the historical filename: a remote rename neither mixes up files nor creates junk files
        const known = nameByExternalId?.[c.externalId];
        const filename = known || buildFilename(title, c.externalId, usedNames);
        if (nameByExternalId) nameByExternalId[c.externalId] = filename;
        return { filename, content: c.markdown };
      });

    for (const writeBatch of packByLimit(files, WRITE_BATCH_FILES, WRITE_BATCH_BYTES)) {
      const res = await p.wikiService.rawWriteMany(
        p.serviceId,
        p.teamId,
        p.wikiId,
        writeBatch,
      );
      // WriteOutcome: array = success; the rest are failure states (null / processing / invalid_path / forbidden_path / too_large)
      if (!Array.isArray(res)) {
        if (res === "processing") {
          warnings.push(`wiki ${p.wikiId} is processing, batch skipped`);
          continue;
        }
        throw new Error(`rawWriteMany failed for wiki ${p.wikiId}: ${String(res)}`);
      }
      imported += res.length;
    }
  }

  // Mapping persistence: the file is already written; a save failure does not block this round's result (only affects next-round reuse)
  if (canUseMap && nameByExternalId) {
    p.wikiService.writeImportNameMap!(
      p.serviceId,
      p.teamId,
      p.wikiId,
      p.providerId,
      nameByExternalId,
    );
  }

  return { imported, skippedDirs, failed, warnings };
}

async function fetchOneByOne(
  provider: WikiSourceProvider,
  ctx: SourceContext,
  ids: string[],
  failed: Array<{ id: string; error: string }>,
  delayMs: number,
): Promise<RemotePageContent[]> {
  const out: RemotePageContent[] = [];
  for (const id of ids) {
    try {
      out.push(await provider.fetchPage(ctx, id));
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
    await delay(delayMs);
  }
  return out;
}

/**
 * Generate the on-disk filename: `<title>.md` (readable, so users can recognize it in the raw list).
 *
 * Compared with the readability advantage of "naming by external id", the cost is that a title change produces a new filename.
 * Three layers of protection here, to avoid renames/duplicate names causing lost files or mutual overwrites:
 *   1. Sanitize: strip path separators and control characters, guarding against directory traversal and illegal filenames
 *   2. Truncate: cut overly long titles to 120 characters (filesystems commonly cap at 255 bytes; leave ample margin for CJK)
 *   3. Dedupe: append -2 / -3… on same names; if the title is empty, fall back to the page's external id
 *
 * `usedNames` is held across batches by the caller, ensuring uniqueness within the whole import round.
 */
function buildFilename(
  title: string | undefined,
  externalId: string,
  usedNames: Set<string>,
): string {
  const cleaned = (title ?? "")
    // Strip path separators and Windows reserved characters, guarding against directory traversal
    .replace(/[/\\:*?"<>|]/g, "")
    // Strip control characters (newlines/tabs etc.), to avoid invisible characters in filenames
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^\.+/, "") // avoid special names like . / ..
    .slice(0, 120) // filesystems commonly cap at 255 bytes; leave ample margin for CJK
    .trim();

  const base = cleaned || externalId;
  let name = `${base}.md`;
  let n = 2;
  while (usedNames.has(name)) {
    name = `${base}-${n}.md`;
    n += 1;
  }
  usedNames.add(name);
  return name;
}

/** Split into packages by dual limits of "file count + byte count". */
function packByLimit(
  files: Array<{ filename: string; content: string }>,
  maxFiles: number,
  maxBytes: number,
): Array<Array<{ filename: string; content: string }>> {
  const out: Array<Array<{ filename: string; content: string }>> = [];
  let cur: Array<{ filename: string; content: string }> = [];
  let curBytes = 0;

  for (const f of files) {
    const size = Buffer.byteLength(f.content, "utf-8");
    if (
      cur.length > 0 &&
      (cur.length + 1 > maxFiles || curBytes + size > maxBytes)
    ) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
