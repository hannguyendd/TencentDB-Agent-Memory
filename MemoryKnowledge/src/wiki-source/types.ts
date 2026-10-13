/**
 * wiki-source — abstraction of wiki external sources.
 *
 * Symmetric with code-source:
 *   - **Provider (wiki platform)** → `providers/<id>.ts`: platform constants + fetch implementation
 *   - The auth method reuses the AuthMethod of `code-source/auth-methods/` (form metadata + injection convention)
 *
 * Differences (relative to codegraph):
 *   - wiki needs to **list the document tree + fetch content page by page**, which cannot be done with a single URL
 *   - So a provider must implement resolveRoot / listPages / fetchPage
 *   - Contract defined in doc §2.1; implemented on the KS side, Panel only calls the API
 */

import type { AuthMethod } from "../code-source/auth-methods/types.js";

/** Source metadata for frontend dropdown display. */
export interface WikiSourceMeta {
  id: string;
  auth_method: AuthMethod["kind"];
  form_fields: ReadonlyArray<{ name: string; secret: boolean; required: boolean }>;
  token_doc_url?: string;
}

/**
 * Token application page location.
 *
 * **Addresses always come from deployment config**; no intranet domain is hard-coded in code. Two forms:
 *
 * - `{ tokenUrlEnv }` (**preferred**): that env holds the **full URL**, used as is without concatenation.
 *   Applicable when the token page is on a different domain from the source, or is **shared with other sources**
 *   (e.g. iWiki and TAPD both use the Taihu PAT page → both point to the same `TAI_PAT_URL`).
 * - `{ path }`: an in-site relative path, appended to `WIKI_SOURCE_<ID>_SITE_BASE_URL`.
 *
 * With the full URL form, multiple sources can point to the **same env**; changing the address means changing only one place, with nothing missed.
 */
export type TokenDoc =
  | { tokenUrlEnv: string }
  | { path: string };

/**
 * Traversal strategy: decides "starting from the import root, how to discover documents".
 *
 * - `"tree"`: use the platform's **hierarchy API** (parent → child), expanding by directory structure.
 *     Pros: complete structure, consistent with the platform directories;
 *     Cons: depends on the platform having a hierarchy API, and mostly level-by-level APIs (large spaces need many recursions and take long).
 *
 * - `"links"`: parse the **hyperlinks in page bodies** to discover documents (similar to a crawler).
 *     Pros: does not depend on a hierarchy API; usable on any platform where the body can be obtained;
 *     Cons: can only discover linked pages, and needs to fetch bodies (extra request overhead).
 */
export type CrawlMode = "tree" | "links";

/** Default traversal depth of the links strategy (go only one level from the entry page's direct links). */
export const DEFAULT_LINKS_MAX_DEPTH = 1;

/** Traversal options. */
export interface CrawlOptions {
  mode?: CrawlMode;
  /** Maximum traversal depth; 1 = only documents directly linked from the entry page. Only meaningful for the links strategy. */
  maxDepth?: number;
}

/** Import root: directory or single document. */
export interface ResolvedRoot {
  rootType: "dir" | "doc";
  rootId: string;
  displayName: string;
  estimatedCount?: number;
  /**
   * When the directory root itself is also a document id (on some platforms a directory page shares
   * the same URL form as an ordinary document, such as `/p/<id>`), record that id,
   * for listPages to expand level by level starting from it.
   * A space root (rootId is a space key) does not carry this field.
   */
  rootDocId?: string;
}

/** Remote node reference (flat, including directory nodes). */
export interface RemotePageRef {
  externalId: string;
  title: string;
  path: string;
  parentId?: string | null;
  /** true = directory, display only, not downloadable. */
  isDir?: boolean;
  version?: string;
  updatedAt?: string;
}

/**
 * A single fetched piece of content.
 *
 * `title` may be undefined: some providers' content APIs return only the body, not the title
 * (such platforms were confirmed to exist by measurement). In that case the upper layer fills it in with the listing-stage (listPages) title;
 * the provider **must not fall back to the id**, otherwise the on-disk filename degrades to `<id>.md`.
 */
export interface RemotePageContent extends Omit<RemotePageRef, "title" | "path"> {
  title?: string;
  path?: string;
  markdown: string;
  fidelity: "lossless" | "lossy";
  warnings?: string[];
}

/**
 * Fetch execution context.
 *
 * Credentials are **injected here**; the provider does not read the DB itself;
 * this keeps providers purely functional, easy to test and reuse (including scheduled sync).
 */
export interface SourceContext {
  /** Plaintext credential (PAT etc.). */
  secret: string;
  /** Username for basic auth (optional). */
  username?: string;
  /** MCP / API endpoint. */
  endpoint: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

/**
 * wiki source provider contract (doc §2.1).
 *
 * One platform file = one implementation:
 *   - `id` / `authMethod` / `sitePaths`: platform constants
 *   - `resolveRoot` / `listPages` / `fetchPage`: platform fetch capabilities
 *   - `fetchPages`: optional batch; if not implemented, degrade to fetching one by one with fetchPage
 */
export interface WikiSourceProvider {
  readonly id: string;
  readonly authMethod: AuthMethod;
  readonly sitePaths: {
    /** Token application page location (in-site path / cross-site path, see TokenDoc). */
    tokenDoc?: TokenDoc;
  };

  /**
   * **Config name suffix** of the service endpoint address, assembled into `WIKI_SOURCE_<UPPER_ID>_<suffix>`.
   *
   * Default `"MCP_URL"` (MCP protocol type);
   * REST-style platforms can declare `"API_BASE_URL"` etc., avoiding being forced to be named MCP.
   *
   * Addresses always come from deployment config, **with no built-in default** (intranet infrastructure must be configured explicitly).
   */
  readonly endpointEnvSuffix?: string;

  /** Resolve the address into an import root, automatically deciding directory or document. */
  resolveRoot(ctx: SourceContext, inputUrl: string): Promise<ResolvedRoot>;

  /**
   * List nodes, returning a flat list that keeps directory nodes.
   *
   * `opts` optional: the caller may specify a traversal strategy (see CrawlOptions).
   * When omitted → use the provider's default strategy (`defaultCrawlMode`, `"tree"` if not declared).
   */
  listPages(
    ctx: SourceContext,
    root: ResolvedRoot,
    opts?: CrawlOptions,
  ): Promise<RemotePageRef[]>;

  /**
   * The provider's default traversal strategy. **Optional**; `"tree"` if not declared.
   *
   * Trade-offs:
   * - `tree` is consistent with the platform directory structure with full coverage, the natural default for "import the whole space/directory";
   *   but depends on the platform having a hierarchy API, and mostly level-by-level APIs (large spaces recursion takes long).
   * - `links` only needs to read bodies with fewer requests, suitable for "grab a batch of related documents from an entry page";
   *   but can only discover linked pages.
   *
   * The caller can always override with `CrawlOptions.mode`.
   */
  readonly defaultCrawlMode?: CrawlMode;

  fetchPage(ctx: SourceContext, pageId: string): Promise<RemotePageContent>;

  /** Optional batch; if not supported, degrade to fetching one by one with fetchPage. */
  fetchPages?(ctx: SourceContext, ids: string[]): Promise<RemotePageContent[]>;
}
