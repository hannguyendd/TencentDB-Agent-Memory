/**
 * One of the traversal strategies: parse the **hyperlinks in page bodies** to discover documents (similar to a crawler).
 *
 * Applicable: does not depend on the platform hierarchy API — usable on any platform where the body can be obtained.
 * Characteristics:
 *   - Can only discover pages "linked to by the entry page" (full coverage of the space is not guaranteed)
 *   - Needs to fetch bodies to parse links (extra request overhead)
 *   - Goes only one level by default (direct links of the entry page), to avoid an explosion of requests
 */

import type { RemotePageRef, SourceContext } from "../../../types.js";
import { getDocument, getMetadata } from "../mcp-client.js";

/**
 * Extract document ids from the body (deduplicated, order-preserving).
 *
 * Regexes are **created inside the function**: a regex object with the `g` flag holds lastIndex state,
 * and sharing at module level would contaminate each other across multiple calls / alternating matches of multiple regexes (once produced dirty ids like "2)").
 */
export function extractDocIds(markdown: string): string[] {
  // markdown link syntax: `[title](https://.../p/123)` — the id contains no `/?#)` or whitespace
  const mdLinkRe = /\((?:https?:\/\/[^)\s]*?)?\/(?:p|pages?)\/([^/?#)\s]+)\)/gi;
  // Bare URL: `.../p/123` at any position
  const bareUrlRe = /\/(?:p|pages?)\/([^/?#)\s]+)/gi;

  const out: string[] = [];
  const seen = new Set<string>();

  const collect = (re: RegExp) => {
    for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
      const id = m[1];
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  };

  collect(mdLinkRe);
  collect(bareUrlRe);
  return out;
}

/**
 * Starting from the entry pages, discover documents level by level via body hyperlinks.
 *
 * @param rootIds   list of entry page ids
 * @param maxDepth  maximum number of levels; 1 = only the documents directly linked from the entry pages (default)
 */
export async function crawlLinks(
  ctx: SourceContext,
  rootIds: string[],
  maxDepth: number,
): Promise<RemotePageRef[]> {
  const out: RemotePageRef[] = [];
  const visited = new Set<string>(rootIds);

  // First take the entry page itself
  let frontier: Array<{ id: string; parentId: string | null; depth: number }> = rootIds.map(
    (id) => ({ id, parentId: null, depth: 0 }),
  );

  while (frontier.length > 0) {
    const next: typeof frontier = [];

    for (const item of frontier) {
      // Prefer taking the title from metadata (getDocument returns only the body, without title)
      let title = item.id;
      let markdown = "";
      try {
        const [meta, doc] = await Promise.all([
          getMetadata(ctx, item.id).catch(() => undefined),
          getDocument(ctx, item.id),
        ]);
        if (meta?.title) title = meta.title;
        markdown = doc.markdown ?? "";
      } catch {
        // Failure to fetch a single page should not interrupt the whole traversal
        continue;
      }

      out.push({
        externalId: item.id,
        title,
        path: title,
        parentId: item.parentId,
        isDir: false,
      });

      // Stop expanding once the depth limit is reached
      if (item.depth >= maxDepth) continue;

      for (const childId of extractDocIds(markdown)) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        next.push({ id: childId, parentId: item.id, depth: item.depth + 1 });
      }
    }

    frontier = next;
  }

  return out;
}
