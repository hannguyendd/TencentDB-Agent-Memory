/**
 * index-builder.ts — maintain wiki/index.md (OKF §6 progressive disclosure / llm-wiki "look at the table of contents first, then drill down").
 *
 * Called after ingest writes to disk: scan the frontmatter of all pages under wiki/, group them by page type,
 * generate a `* [title](relPath) - description` list, and overwrite wiki/index.md.
 *
 * Design trade-offs:
 *   - index.md is a structural file (page/write/rm may not modify it), but ingest may maintain it (PRD §3.7-2).
 *   - Uses standard markdown links (OKF recommends bundle-relative `/path`), without affecting the [[wikilink]] graph.
 *   - Fixed group order (sources -> entities -> concepts -> other types), sorted by title within a group, for stable output.
 *   - Lenient: bad pages / missing frontmatter are skipped, no throw.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

/** Structural files are not listed in the index. */
const STRUCTURAL = new Set(["index.md", "schema.md", "purpose.md", "log.md", "overview.md"]);

/** Group display order and section headings. Unknown types fall under "Other". */
const GROUP_ORDER: Array<{ type: string; heading: string }> = [
  { type: "source", heading: "Sources" },
  { type: "entity", heading: "Entities" },
  { type: "concept", heading: "Concepts" },
  { type: "comparison", heading: "Comparisons" },
  { type: "synthesis", heading: "Synthesis" },
];

interface IndexEntry {
  title: string;
  relPath: string; // bundle-relative, starts with / (OKF recommended)
  description: string;
  type: string;
}

/** Scan wiki/ and collect index entries of all non-structural pages. */
function collectEntries(wikiDir: string): IndexEntry[] {
  const out: IndexEntry[] = [];
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
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const rel = relative(wikiDir, full).replace(/\\/g, "/");
      if (STRUCTURAL.has(rel)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const { frontmatter } = parseFrontmatter(content);
      const title =
        typeof frontmatter.title === "string" && frontmatter.title.trim()
          ? frontmatter.title.trim()
          : entry.replace(/\.md$/, "");
      const description =
        typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
      out.push({ title, relPath: `/${rel}`, description, type: frontmatter.type });
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

/**
 * Render the index.md text from the current wiki/ content (OKF progressive-disclosure format, no frontmatter).
 * Exported for unit testing.
 */
export function renderIndex(entries: IndexEntry[]): string {
  const byType = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const arr = byType.get(e.type) ?? [];
    arr.push(e);
    byType.set(e.type, arr);
  }

  const sections: string[] = ["# Index", ""];
  const emitted = new Set<string>();

  const emitGroup = (type: string, heading: string) => {
    const items = byType.get(type);
    if (!items || items.length === 0) return;
    emitted.add(type);
    items.sort((a, b) => a.title.localeCompare(b.title));
    sections.push(`## ${heading}`, "");
    for (const it of items) {
      sections.push(`* [${it.title}](${it.relPath})${it.description ? ` - ${it.description}` : ""}`);
    }
    sections.push("");
  };

  for (const { type, heading } of GROUP_ORDER) emitGroup(type, heading);

  // Other types not listed fall under "Other", so no page is missed (OKF tolerates unknown types).
  const otherTypes = [...byType.keys()].filter((t) => !emitted.has(t)).sort();
  for (const t of otherTypes) emitGroup(t, t.charAt(0).toUpperCase() + t.slice(1));

  return sections.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Rebuild and overwrite wiki/index.md.
 * @returns number of entries written (for logging).
 */
export function rebuildIndexFile(projectPath: string): number {
  const wikiDir = join(projectPath, "wiki");
  if (!existsSync(wikiDir)) return 0;
  const entries = collectEntries(wikiDir);
  const text = renderIndex(entries);
  writeFileSync(join(wikiDir, "index.md"), text, "utf-8");
  return entries.length;
}
