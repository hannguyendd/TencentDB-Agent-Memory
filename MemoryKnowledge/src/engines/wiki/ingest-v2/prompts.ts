/**
 * prompts.ts — ingest prompts (analysis / system / generation).
 *
 * Describes the role (wiki maintainer), page types and directory conventions (OKF type), the FILE block output protocol,
 * wikilink conventions, dedup/update strategy, and output language policy. Based on this repo's PRD/INTERFACE.
 *
 * Supports two ingest flows (PRD §4.2):
 *   - Single stage: full source + template + existing page list → directly produce FILE blocks (buildGeneratePrompt).
 *   - Two stage (OQ-4): first "analyze" (buildAnalysisPrompt) to produce a structured extraction plan,
 *     then "generate" (buildGenerateFromAnalysisPrompt) to produce FILE blocks from the analysis.
 *     Benefit: decouples "what to extract" from "on-disk format", for steadier quality and tidier formatting.
 */

import type { WikiTemplate } from "./template.js";

/** Concise info about an existing page, so the LLM is aware of "existing knowledge" and can decide to create/update. */
export interface ExistingPageInfo {
  /** wiki-relative path, e.g. wiki/entities/redis.md */
  relPath: string;
  title: string;
  type: string;
  description?: string;
}

/** Existing page that needs to be updated (hit dedup and not locked); the original text is given to the LLM to merge. */
export interface PageForUpdate {
  relPath: string;
  content: string;
}

/** Format the existing page list as list text (reused by the analysis/generation stages). */
function formatExistingPages(existingPages: ExistingPageInfo[]): string {
  return existingPages.length > 0
    ? existingPages
        .map((p) => `- [${p.type}] ${p.relPath}${p.title ? ` — ${p.title}` : ""}${p.description ? `（${p.description}）` : ""}`)
        .join("\n")
    : "(wiki is empty — this is the first source)";
}

// ─── Stage A: analysis ────────────────────────────────────────────

/** Analysis stage system prompt: plays the "extraction planner", produces only structured analysis, writes no pages. */
export function buildAnalysisSystemPrompt(template: WikiTemplate): string {
  return `You are a knowledge base analyst. Your job is to read a source document and plan how to integrate it into
the existing wiki. You do NOT write final pages — you only produce a structured "extraction plan" for the
next (generation) stage.

## Wiki Purpose
${template.purpose}

## Extraction Schema
${template.schema}

## Your Analysis Output (markdown, structured, concise)
1. **Source Summary**: Summarize this source in 2–4 sentences.
2. **Entities**: Concrete entities (people, products, systems, organizations, etc.) in the source. For each, give a name and a one-sentence key point.
3. **Concepts**: Abstract concepts (theories, methods, mechanisms, etc.) in the source. For each, give a name and a one-sentence key point.
4. **Relationship to Existing Pages**: Which entities/concepts already appear in the existing page list (update/merge rather than create new), and which are brand new.
5. **Suggested Cross-References**: Which entity/concept pairs should be connected via [[wikilink]].

## Granularity

Decide whether a subject deserves its own page by asking:

1. **Independent identity** — can this subject be defined and understood on its own, without relying on its parent context?
2. **Distinct relationships** — does it have meaningful relationships to other entities/concepts beyond just belonging to its parent?
3. **Substantial content** — is there enough to say about it to fill more than a one-sentence stub?

→ If all three are true, create a dedicated page.
→ If the subject is merely a member, sub-operation, or property that has no identity outside its parent, list it as a subsection or list item within the parent's page instead.

Output only the analysis itself — no FILE blocks, no final page content. Match the source document's primary language.`;
}

/** Build the analysis stage user prompt. */
export function buildAnalysisPrompt(args: {
  sourceName: string;
  sourceText: string;
  existingPages: ExistingPageInfo[];
}): string {
  const { sourceName, sourceText, existingPages } = args;
  return `## Source to analyze: ${sourceName}

## Existing wiki pages (for deciding what to update vs. create)
${formatExistingPages(existingPages)}

## Source Document
${sourceText}

---
Produce the structured extraction plan following the rules above.`;
}

// ─── System prompt (shared by the generation stage: format contract + output protocol) ──────────

/** Build the system prompt: role, format contract, output protocol. */
export function buildSystemPrompt(template: WikiTemplate): string {
  return `You are a meticulous knowledge base (wiki) maintainer. Your job is to read source documents
provided by the user and integrate their knowledge into a persistent, cumulative markdown wiki —
extracting entities and concepts, building cross-references, and updating existing pages, rather than
simply paraphrasing the source.

## Wiki Purpose
${template.purpose}

## Extraction Schema
${template.schema}

## Page Format (MUST be followed strictly)
Each wiki page is "YAML frontmatter + markdown body". Frontmatter is wrapped in \`---\` at the top:
- type: REQUIRED. Values: source | entity | concept | comparison | synthesis, etc. Determines the page's directory.
- title: Human-readable title.
- description: One-sentence summary (used for index and search snippets).
- sources: Array of raw source filenames this page draws from (e.g. ["redis.md"]). Must be accurate.
- tags: Optional, short cross-category labels.
- timestamp: Optional, ISO 8601 last-modified time.
- Do NOT output a \`locked\` field.

Body guidelines:
- Link between entities/concepts using [[wikilink]], e.g. [[Redis]], [[Cache]]. Use these liberally.
- **Wikilink consistency**: Inside the brackets, write only the target page's title (e.g. [[Gateway]],
  [[Consistent Hashing]]). Do NOT include \`.md\` suffix, \`wiki/\` or slash paths, or filename slugs.
  When referencing an existing page, use its title.
- Use structured sections where applicable: # Schema / # Examples / # Citations, lists, and tables.
- **Consistent language**: Use the same primary language as the source document throughout (title, body,
  wikilinks, descriptions). Avoid mixing languages.

## Output Protocol (FILE blocks, MUST be followed strictly)
You cannot write files directly. Wrap each page to be written in the following boundary markers:

<<<FILE path="wiki/<dir>/<slug>.md">>>
---
type: ...
title: ...
---

body...
<<<END>>>

Directory conventions (use plural directory names):
- source → wiki/sources/
- entity → wiki/entities/
- concept → wiki/concepts/
- comparison → wiki/comparisons/
- synthesis → wiki/synthesis/

Rules:
- A single reply may contain multiple FILE blocks.
- path must be inside wiki/. Use stable slugs for filenames (lowercase, spaces→hyphens).
- You MUST produce at least one type: source summary page.
- For notable entities/concepts in the source, produce or update corresponding entity/concept pages.
- Do NOT output any explanatory text outside of FILE blocks.`;
}

/** Build the generation prompt (single stage): full source + existing page list + original text of pages to update. */
export function buildGeneratePrompt(args: {
  sourceName: string;
  sourceText: string;
  existingPages: ExistingPageInfo[];
  pagesToUpdate?: PageForUpdate[];
}): string {
  const { sourceName, sourceText, existingPages, pagesToUpdate } = args;

  const existingList =
    existingPages.length > 0
      ? existingPages
          .map((p) => `- [${p.type}] ${p.relPath}${p.title ? ` — ${p.title}` : ""}${p.description ? `（${p.description}）` : ""}`)
          .join("\n")
      : "(wiki is empty — this is the first source)";

  const updateSection =
    pagesToUpdate && pagesToUpdate.length > 0
      ? `\n## Pages to Update (preserve existing facts while merging new information — output the merged full page)\n` +
        pagesToUpdate
          .map((p) => `### ${p.relPath}\n\`\`\`\n${p.content}\n\`\`\``)
          .join("\n\n")
      : "";

  return `## Source to ingest: ${sourceName}

## Existing wiki pages (for deciding what to create vs. update, to avoid duplicates)
${existingList}
${updateSection}

## Source Document
${sourceText}

---
Read the source, follow the format and protocol in the system prompt, and output FILE blocks:
1. MUST include one type: source summary page (path like wiki/sources/<slug>.md).
2. For key entities/concepts in the source, produce or update corresponding entity/concept pages.
3. If an entity already appears in the existing page list, reuse its path for merging — do NOT create a near-duplicate page.
4. Use [[wikilink]] generously between pages.
Output ONLY FILE blocks — no extra commentary.`;
}

// ─── Stage B: analysis-based generation (OQ-4) ──────────────────────────

/**
 * Build the "generation stage" user prompt (two-stage flow): the analysis result is the main input,
 * while still attaching the full source for verifying details. Lets the LLM produce FILE blocks from it.
 */
export function buildGenerateFromAnalysisPrompt(args: {
  sourceName: string;
  sourceText: string;
  analysis: string;
  existingPages: ExistingPageInfo[];
}): string {
  const { sourceName, sourceText, analysis, existingPages } = args;
  return `## Source to ingest: ${sourceName}

## Extraction Plan (from analysis stage — generate pages based on this)
${analysis}

## Existing wiki pages (reuse paths for merging — avoid duplicates)
${formatExistingPages(existingPages)}

## Source Document (for detail verification)
${sourceText}

---
Based on the Extraction Plan above, follow the format and protocol in the system prompt, and output FILE blocks:
1. MUST include one type: source summary page (path like wiki/sources/<slug>.md).
2. For the entities/concepts listed in the extraction plan, produce or update corresponding entity/concept pages.
3. Items marked as "already exist" in the plan should reuse their existing paths for merging — do NOT create near-duplicates.
4. Follow the cross-reference suggestions in the plan — use [[wikilink]] generously.
Output ONLY FILE blocks — no extra commentary.`;
}
