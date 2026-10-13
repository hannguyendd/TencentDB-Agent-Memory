/**
 * slug.ts — entity name → stable filename slug
 *
 * The basis of dedup (merge): ingesting the same entity name twice must yield the same slug,
 * so the second ingest hits the existing `wiki/<type>/<slug>.md` and merges instead of creating a new one.
 *
 * Rules (PRD FR-4 / INTERFACE §2, source mixes Chinese and English):
 *   - English/digits: lowercase, spaces and punctuation become hyphens, strip leading/trailing/duplicate hyphens.
 *   - Chinese (CJK): keep the Han characters themselves, only strip spaces (no pinyin conversion, nothing dropped).
 *   - Mixed: process each by the rules above then concatenate (`Redis 主从` → `redis-主从`).
 */

// CJK unified ideographs (including Extension A); common Chinese punctuation is not in this range (punctuation is treated as a separator).
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

function isAlnumChar(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

/**
 * Normalize an entity name/title into a stable slug.
 *
 * Implementation strategy: scan character by character, splitting into alternating tokens of "CJK segments" and "Latin/digit segments",
 * joining segments with hyphens; Latin segments are lowercased; other characters (spaces, punctuation) are all treated as segment boundaries.
 */
export function slugify(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";

  const tokens: string[] = [];
  let buf = "";
  let bufKind: "cjk" | "latin" | null = null;

  const flush = () => {
    if (buf) {
      tokens.push(bufKind === "latin" ? buf.toLowerCase() : buf);
      buf = "";
    }
    bufKind = null;
  };

  for (const ch of trimmed) {
    if (isCjkChar(ch)) {
      if (bufKind !== "cjk") flush();
      bufKind = "cjk";
      buf += ch;
    } else if (isAlnumChar(ch)) {
      if (bufKind !== "latin") flush();
      bufKind = "latin";
      buf += ch;
    } else {
      // space / punctuation / other → segment boundary
      flush();
    }
  }
  flush();

  // Join with hyphens, dedupe duplicate/leading/trailing hyphens.
  return tokens.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Given a page type and title, return the relative path within the wiki (without the leading `wiki/`).
 * e.g. type="entity", title="Redis Cluster" → "entities/redis-cluster.md"
 *
 * The type → directory mapping aligns with the existing manager's directory conventions (entities/concepts/sources/...).
 */
const TYPE_DIR: Record<string, string> = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  comparison: "comparisons",
  synthesis: "synthesis",
  thesis: "synthesis",
  methodology: "concepts",
  finding: "synthesis",
};

/**
 * Value domain of a valid type: type is an OKF classification label, not a path, so it can only be an identifier.
 * Any value containing `/`, `.` (including `..`) or other characters is not a valid classification and is always put into the other directory.
 */
const SAFE_TYPE_RE = /^[a-z0-9_-]+$/;

/** Map a type to a directory name; an unknown but valid type uses itself as a generic directory; invalid values go to other. */
export function dirForType(type: string): string {
  const key = (type ?? "").trim().toLowerCase();
  // hasOwn instead of indexed lookup: avoids "__proto__"/"constructor" hitting members on Object's prototype chain.
  if (Object.hasOwn(TYPE_DIR, key)) return TYPE_DIR[key];
  if (!SAFE_TYPE_RE.test(key)) return "other";
  return key;
}

/**
 * Compute a page's wiki-relative path (with the `wiki/` prefix), used for on-disk writes and dedup hits.
 * @param type page type (source/entity/concept/...)
 * @param title entity name/title
 */
export function pageRelPath(type: string, title: string): string {
  const slug = slugify(title);
  const dir = dirForType(type);
  return `wiki/${dir}/${slug}.md`;
}
