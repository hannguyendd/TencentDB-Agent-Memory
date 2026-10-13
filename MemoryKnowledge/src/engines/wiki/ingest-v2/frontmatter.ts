/**
 * frontmatter.ts — parsing and construction of YAML frontmatter.
 *
 * Output pages must carry legal YAML frontmatter (relied upon by the existing manager scanWikiDir/BM25/graph):
 *   type (required) / title / sources (our extension) / description / tags / timestamp (OKF recommended)
 *
 * This provides:
 *   - parseFrontmatter: split a page's content into a frontmatter object + body (used for merging / reading locked).
 *   - buildPage: assemble frontmatter fields + body into compliant page content (used when producing/rewriting).
 *   - isLocked / readSources: convenience readers used by the merge logic.
 *
 * Parsed with the repo's existing `yaml` dependency, consumed leniently (bad frontmatter does not throw; it is treated as empty).
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface PageFrontmatter {
  type: string;
  title?: string;
  description?: string;
  sources?: string[];
  tags?: string[];
  timestamp?: string;
  locked?: boolean;
  /** Keep any extra fields so they are not lost on round-trip (OKF lenient-consumption spirit). */
  [key: string]: unknown;
}

export interface ParsedPage {
  frontmatter: PageFrontmatter;
  body: string;
  /** Whether a frontmatter block was parsed successfully. */
  hasFrontmatter: boolean;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split page content into frontmatter + body. When there is no frontmatter, returns a `{type:"other"}` placeholder.
 * On parse failure (bad YAML), degrades leniently and does not throw.
 */
export function parseFrontmatter(content: string): ParsedPage {
  const text = content ?? "";
  const m = text.match(FM_RE);
  if (!m) {
    return { frontmatter: { type: "other" }, body: text, hasFrontmatter: false };
  }
  const yamlText = m[1];
  const body = text.slice(m[0].length);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  if (!parsed || typeof parsed !== "object") {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  const fm = parsed as Record<string, unknown>;
  const type = typeof fm.type === "string" && fm.type.trim() ? fm.type : "other";
  return { frontmatter: { ...fm, type } as PageFrontmatter, body, hasFrontmatter: true };
}

/** Whether the target page is manually locked by the user (page/write injects locked:true). Locked pages must be skipped by ingest. */
export function isLocked(content: string): boolean {
  const { frontmatter } = parseFrontmatter(content);
  return frontmatter.locked === true;
}

/** Read the sources list declared by the page (raw/rm cascade depends on it). */
export function readSources(content: string): string[] {
  const { frontmatter } = parseFrontmatter(content);
  const s = frontmatter.sources;
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Assemble frontmatter + body into compliant page content.
 *
 * - `type` is required; when missing, "other" is filled in (OKF: consumers tolerate unknown types).
 * - Never writes the `locked` field (injected only by page/write; self-produced pages do not carry locked).
 * - Field order is fixed (type->title->description->sources->tags->timestamp->others) for more stable readability.
 */
export function buildPage(frontmatter: PageFrontmatter, body: string): string {
  const fm: Record<string, unknown> = {};
  fm.type = (frontmatter.type ?? "other").toString();
  if (frontmatter.title != null) fm.title = frontmatter.title;
  if (frontmatter.description != null) fm.description = frontmatter.description;
  if (frontmatter.sources != null) fm.sources = frontmatter.sources;
  if (frontmatter.tags != null) fm.tags = frontmatter.tags;
  if (frontmatter.timestamp != null) fm.timestamp = frontmatter.timestamp;
  // Pass through other custom fields (excluding locked / already-handled fields)
  for (const [k, v] of Object.entries(frontmatter)) {
    if (["type", "title", "description", "sources", "tags", "timestamp", "locked"].includes(k)) continue;
    if (v != null) fm[k] = v;
  }

  const yamlText = stringifyYaml(fm).trimEnd();
  const cleanBody = (body ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${yamlText}\n---\n\n${cleanBody}\n`;
}
