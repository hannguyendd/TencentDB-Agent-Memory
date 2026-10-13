/**
 * cascade.ts — deletion cascade (downstream cleanup for raw/rm and page/rm).
 *
 * Behavior contract: see PRD §3.7-3 and the call signatures in wiki-service.ts.
 *
 *  - deleteSourceFiles: deletes raw source files and cascades by each page's frontmatter `sources` --
 *      pages that exclusively depend on the source -> deleted; shared pages -> rewritten with the source removed.
 *  - cascadeDeleteWikiPagesWithRefs: deletes wiki page files and cleans up the [[wikilink]]s in other
 *      pages' bodies that point to the deleted pages (dangling links).
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { slugify } from "./slug.js";

export interface DeleteSourceFilesResult {
  /** Absolute paths of wiki pages deleted by the cascade. */
  deletedWikiPaths: string[];
  /** Number of wiki pages rewritten (with a source removed). */
  rewrittenSourcePages: number;
}

export interface DeleteSourceFilesOptions {
  /** For log labeling only, to ease auditing. */
  logReason?: string;
}

/** Recursively collect the absolute paths of all .md pages under wiki/ (skipping the media directory). */
function collectWikiPages(wikiDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry !== "media") walk(full);
      } else if (entry.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

/** Structural files do not take part in cascade deletion/rewriting. */
function isStructural(relFromWiki: string): boolean {
  return relFromWiki === "index.md" || relFromWiki === "schema.md" || relFromWiki === "purpose.md";
}

/**
 * Delete raw source files and cascade-clean the wiki pages that reference them.
 *
 * @param projectPath wiki project root
 * @param sourceFullPaths list of absolute paths of raw source files to delete
 */
export async function deleteSourceFiles(
  projectPath: string,
  sourceFullPaths: string[],
  _opts: DeleteSourceFilesOptions = {},
): Promise<DeleteSourceFilesResult> {
  // Set of file names of the sources to delete (a page's sources records file names).
  const deletedNames = new Set<string>();
  for (const p of sourceFullPaths) {
    deletedNames.add(basename(p));
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {
      /* ignore deletion failure: may already be deleted */
    }
  }

  const wikiDir = join(projectPath, "wiki");
  const deletedWikiPaths: string[] = [];
  let rewrittenSourcePages = 0;

  for (const pagePath of collectWikiPages(wikiDir)) {
    const relFromWiki = relative(wikiDir, pagePath).replace(/\\/g, "/");
    if (isStructural(relFromWiki)) continue;

    let content: string;
    try {
      content = readFileSync(pagePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(content);
    const sources = Array.isArray(parsed.frontmatter.sources)
      ? parsed.frontmatter.sources.filter((x): x is string => typeof x === "string")
      : [];
    if (sources.length === 0) continue;

    const remaining = sources.filter((s) => !deletedNames.has(s));
    if (remaining.length === sources.length) continue; // this page does not reference the deleted sources

    if (remaining.length === 0) {
      // exclusive to the deleted sources -> delete the page
      try {
        rmSync(pagePath, { force: true });
        deletedWikiPaths.push(pagePath);
      } catch {
        /* ignore */
      }
    } else {
      // shared -> rewrite with the deleted sources removed
      try {
        const rewritten = buildPage({ ...parsed.frontmatter, sources: remaining }, parsed.body);
        writeFileSync(pagePath, rewritten, "utf-8");
        rewrittenSourcePages++;
      } catch {
        /* ignore */
      }
    }
  }

  return { deletedWikiPaths, rewrittenSourcePages };
}

export interface CascadeDeletePagesResult {
  /** Absolute paths of wiki pages actually deleted. */
  deletedPaths: string[];
  /** Number of pages rewritten (dangling wikilinks cleaned). */
  rewrittenFiles: number;
}

/** From a page path and content, derive the identifiers by which it may be referenced via [[wikilink]] (lowercase-normalized). */
function linkAliasesFor(pagePath: string, content: string): Set<string> {
  const aliases = new Set<string>();
  const base = basename(pagePath, ".md");
  aliases.add(base.toLowerCase());
  aliases.add(slugify(base).toLowerCase());
  const { frontmatter } = parseFrontmatter(content);
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    aliases.add(frontmatter.title.trim().toLowerCase());
    aliases.add(slugify(frontmatter.title).toLowerCase());
  }
  return aliases;
}

/** Normalize a wikilink target (strip |label, trim, lowercase). */
function normalizeLinkTarget(raw: string): string {
  const target = raw.split("|")[0].trim();
  return target.toLowerCase();
}

/**
 * Delete wiki page files and clean up the [[wikilink]]s in other pages' bodies that point to the deleted pages.
 *
 * @param projectPath wiki project root
 * @param pageFullPaths list of absolute paths of wiki pages to delete
 */
export async function cascadeDeleteWikiPagesWithRefs(
  projectPath: string,
  pageFullPaths: string[],
): Promise<CascadeDeletePagesResult> {
  const wikiDir = join(projectPath, "wiki");

  // Before deleting, collect the wikilink aliases of the deleted pages for the later dangling link cleanup.
  const deletedAliases = new Set<string>();
  const toDelete = new Set(pageFullPaths.map((p) => p));
  for (const p of pageFullPaths) {
    let content = "";
    try {
      content = readFileSync(p, "utf-8");
    } catch {
      /* may not exist */
    }
    for (const a of linkAliasesFor(p, content)) deletedAliases.add(a);
  }

  // Perform the deletion.
  const deletedPaths: string[] = [];
  for (const p of pageFullPaths) {
    try {
      if (existsSync(p)) {
        rmSync(p, { force: true });
        deletedPaths.push(p);
      }
    } catch {
      /* ignore */
    }
  }

  // Clean up [[wikilink]]s in the remaining pages pointing to deleted pages: replace [[X]] / [[X|label]] with their display text.
  let rewrittenFiles = 0;
  const linkRe = /\[\[([^\]]+?)\]\]/g;
  for (const pagePath of collectWikiPages(wikiDir)) {
    if (toDelete.has(pagePath)) continue;
    let content: string;
    try {
      content = readFileSync(pagePath, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(linkRe, (whole, inner: string) => {
      const target = normalizeLinkTarget(inner);
      if (deletedAliases.has(target)) {
        changed = true;
        // Keep readable text: use label if there is a |label, otherwise the original target name.
        const parts = String(inner).split("|");
        return (parts[1] ?? parts[0]).trim();
      }
      return whole;
    });
    if (changed) {
      try {
        writeFileSync(pagePath, next, "utf-8");
        rewrittenFiles++;
      } catch {
        /* ignore */
      }
    }
  }

  return { deletedPaths, rewrittenFiles };
}
