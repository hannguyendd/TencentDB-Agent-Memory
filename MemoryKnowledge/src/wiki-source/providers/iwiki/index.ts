/**
 * iWiki provider — one of the external wiki sources, using the MCP protocol.
 *
 * Authentication: personal token (Bearer), injected by the caller; the token application page address comes from deployment config
 * (see sitePaths.tokenDoc, in full URL form), **no concrete domain is written in the code**.
 *
 * Supports two traversal strategies (see CrawlMode), default tree (see defaultCrawlMode below):
 *   - tree: expand level by level via the hierarchy API (complete structure, but recursion in large spaces takes long)
 *   - links: parse body hyperlinks to discover documents (does not depend on the hierarchy API, more general and cheaper,
 *     but can only discover linked pages)
 */

import { bearerAuthMethod } from "../../../code-source/auth-methods/bearer.js";
import type {
  CrawlOptions,
  RemotePageContent,
  RemotePageRef,
  ResolvedRoot,
  SourceContext,
  WikiSourceProvider,
} from "../../types.js";
import { DEFAULT_LINKS_MAX_DEPTH } from "../../types.js";
import { getDocument, getMetadata, getSpaceRoot } from "./mcp-client.js";
import { crawlTree } from "./crawlers/tree.js";
import { crawlLinks } from "./crawlers/links.js";

/** A single-document URL looks like <site>/p/<id> or /pages/<id> */
const DOC_URL_RE = /(?:\/(?:p|pages?)\/)([^/?#]+)/i;
/** A space URL looks like <site>/spaces/<spaceKey> */
const SPACE_URL_RE = /\/spaces?\/([^/?#]+)/i;

export const iwikiProvider: WikiSourceProvider = {
  id: "iwiki",
  authMethod: bearerAuthMethod,
  sitePaths: {
    // The token is issued by **another system** (Taihu PAT, a different domain from iwiki), and that token page is shared by multiple sources
    // (TAPD's Taihu token method uses it too) — so it points to the **globally shared** TAI_PAT_URL:
    // that env holds a full URL, which the code uses as is, without concatenating paths or embedding a domain.
    tokenDoc: { tokenUrlEnv: "TAI_PAT_URL" },
  },

  /**
   * Default to tree: consistent with the platform's directory structure with full coverage, matching the default expectation of "import the whole space/directory".
   *
   * Cost: the hierarchy API is level by level, so recursion in large spaces takes long (measured: 5748 nodes take about 3–4 minutes).
   * If you only want to "grab a batch of related documents from an entry page", the caller can explicitly pass `{ mode: "links", maxDepth: 1 }`
   * to use the hyperlink approach (faster, independent of the hierarchy API, but only covers linked pages).
   */
  defaultCrawlMode: "tree",

  async resolveRoot(ctx: SourceContext, inputUrl: string): Promise<ResolvedRoot> {
    const docMatch = DOC_URL_RE.exec(inputUrl);
    const spaceMatch = SPACE_URL_RE.exec(inputUrl);

    // /p/<docid>: may be a normal document, or a **directory page** (in iWiki a directory also has a /p/ link).
    // Measured: metadata.content_type === "FOLDER" means a directory.
    // Early versions treated everything as a single document → a directory page returned only itself and all child documents were lost, showing up as "child documents not displayed".
    if (docMatch?.[1]) {
      const docId = docMatch[1];
      // Fetch metadata first to get the title (the getDocument body may be large)
      let title = docId;
      let isFolder = false;
      try {
        const meta = await getMetadata(ctx, docId);
        if (meta.title) title = meta.title;
        isFolder = meta.contentType === "FOLDER";
      } catch {
        /* metadata failure does not block; fall back to treating it as a normal document */
      }

      if (!isFolder) {
        return { rootType: "doc", rootId: docId, displayName: title, estimatedCount: 1 };
      }

      // Directory root: the root itself is a top-level node, expanded level by level beneath it
      return {
        rootType: "dir",
        rootId: docId,
        displayName: title,
        estimatedCount: -1, // actual count is known only after expansion
        rootDocId: docId,
      };
    }

    // Space: /spaces/<spaceKey>
    if (spaceMatch?.[1]) {
      const spaceKey = spaceMatch[1];
      const roots = await getSpaceRoot(ctx, spaceKey);
      return {
        rootType: "dir",
        rootId: spaceKey,
        displayName: spaceKey,
        estimatedCount: roots.length,
      };
    }

    throw new Error(
      // Do not hard-code the site domain (an intranet address) in the hint: only describe the path shape
      `Unable to parse an iWiki space or document from the URL (expected a path like /spaces/<spaceKey> or /p/<docid>)`,
    );
  },

  async listPages(
    ctx: SourceContext,
    root: ResolvedRoot,
    opts?: CrawlOptions,
  ): Promise<RemotePageRef[]> {
    const mode = opts?.mode ?? iwikiProvider.defaultCrawlMode ?? "tree";

    // Single-document root: under any strategy there is only itself (links mode will continue to expand its links below)
    if (root.rootType === "doc" && mode === "tree") {
      return [
        {
          externalId: root.rootId,
          title: root.displayName,
          path: root.displayName,
          parentId: null,
          isDir: false,
        },
      ];
    }

    if (mode === "links") {
      // Entry pages: single-document root = itself; directory root (including space root) = the entry pages under that root
      // A space root has no single entry page, so degrade to taking the space's root-level pages as entries
      const entries =
        root.rootType === "doc"
          ? [root.rootId]
          : root.rootDocId
            ? [root.rootDocId]
            : (await getSpaceRoot(ctx, root.rootId)).map((n) => String(n.docid));

      const maxDepth = Math.max(1, opts?.maxDepth ?? DEFAULT_LINKS_MAX_DEPTH);
      return crawlLinks(ctx, entries, maxDepth);
    }

    // tree strategy: the directory root itself is a document (/p/<docid> and is a FOLDER) → make it a top-level node
    if (root.rootDocId) {
      const self = {
        docid: Number(root.rootDocId),
        title: root.displayName,
        has_children: true,
      };
      return crawlTree(ctx, [self]);
    }

    // Space: first take the root level, then expand level by level
    const roots = await getSpaceRoot(ctx, root.rootId);
    return crawlTree(ctx, roots);
  },

  async fetchPage(ctx: SourceContext, pageId: string): Promise<RemotePageContent> {
    const doc = await getDocument(ctx, pageId);
    // Note: getDocument returns only the body, without title (confirmed by measurement).
    // Here we **must not** fall back title to pageId — otherwise the upper layer would treat it as the real title,
    // and the on-disk filename would degrade to <docid>.md. Leave it empty for the upper layer to fill in with the listing-stage title.
    return {
      externalId: pageId,
      title: doc.title,
      path: doc.title,
      isDir: false,
      markdown: doc.markdown,
      fidelity: doc.markdown ? "lossless" : "lossy",
    };
  },
};
