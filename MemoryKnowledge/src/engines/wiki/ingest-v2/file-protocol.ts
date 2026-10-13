/**
 * file-protocol.ts — parse the FILE block protocol output by the LLM and validate the destination path.
 *
 * The LLM cannot write files freely; it outputs a text protocol with boundary markers, which we parse and then write to disk:
 *
 *   <<<FILE path="wiki/sources/redis.md">>>
 *   ---
 *   type: source
 *   ...
 *   ---
 *   body...
 *   <<<END>>>
 *
 * One response may contain multiple FILE blocks. Parsing must be fault-tolerant (INTERFACE §5.1 / §7):
 *   - Discard unclosed blocks (common on truncation / token overrun).
 *   - Illegal path (outside wiki/, contains .., absolute path) is skipped and recorded, without throwing.
 */

export interface ParsedFile {
  /** Normalized relative path, guaranteed to be inside wiki/ (e.g. "wiki/entities/redis.md"). */
  path: string;
  /** Full file content (including frontmatter). */
  content: string;
}

export interface ParseResult {
  files: ParsedFile[];
  /** Reason a block was skipped/discarded, for logging and debugging. */
  warnings: string[];
}

/**
 * Opening tag: the standard is >>>; the model occasionally drops one > and writes >>.
 * Accept >= 2 trailing >, avoiding "long output but files=0".
 */
const OPEN_RE = /<<<FILE\s+path\s*=\s*"([^"]*)"\s*>>+/g;
/**
 * Closing tag: the standard is <<<END>>>; the model occasionally splits it into <<<\nEND>>>.
 * Only relax the whitespace (including newlines) on both sides of END; the literal END is still required.
 */
const CLOSE_RE = /<<<\s*END\s*>>>/g;

/**
 * Validate and normalize the path declared by a FILE block.
 * Returns the normalized path (POSIX style, wiki/ prefix) or null (illegal, should be skipped).
 *
 * Rules:
 *   - Must be a relative path (reject absolute paths / drive letters).
 *   - After splitting, no segment may be ".." or "." (anti-traversal).
 *   - After normalization it must start with "wiki/" (only wiki/** may be written).
 */
export function normalizeWikiPath(raw: string): string | null {
  if (!raw) return null;
  // Unify the separator to /
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return null;
  // Reject absolute paths and Windows drive letters
  if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) return null;
  // Strip redundant ./ prefix
  p = p.replace(/^(\.\/)+/, "");
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  // Anti-traversal: reject if any segment is .. or .
  for (const seg of segments) {
    if (seg === ".." || seg === ".") return null;
  }
  const normalized = segments.join("/");
  // Whitelist: only wiki/** may be written (and it cannot be the "wiki" directory itself)
  if (normalized !== "wiki" && !normalized.startsWith("wiki/")) return null;
  if (normalized === "wiki") return null;
  return normalized;
}

/**
 * Parse a piece of LLM output text and extract all legal FILE blocks.
 *
 * @param text raw LLM response text
 * @returns list of legal files + warnings (skipped blocks)
 */
export function parseFileBlocks(text: string): ParseResult {
  const files: ParsedFile[] = [];
  const warnings: string[] = [];
  if (!text) return { files, warnings };

  OPEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = OPEN_RE.exec(text)) !== null) {
    const rawPath = match[1];
    const bodyStart = OPEN_RE.lastIndex;
    CLOSE_RE.lastIndex = bodyStart;
    const closeMatch = CLOSE_RE.exec(text);

    if (!closeMatch) {
      // Unclosed block -> discard (usually the output was truncated)
      warnings.push(`Unclosed FILE block discarded: path="${rawPath}"`);
      break;
    }

    // Prevent the next match from crossing this block's END
    const closeIdx = closeMatch.index;
    const rawContent = text.slice(bodyStart, closeIdx);
    OPEN_RE.lastIndex = closeIdx + closeMatch[0].length;

    const normPath = normalizeWikiPath(rawPath);
    if (!normPath) {
      warnings.push(`Illegal path skipped: "${rawPath}"`);
      continue;
    }

    // Strip extra blank lines at the start and end of the block content, but keep the frontmatter structure.
    const content = stripBlockEdges(rawContent);
    if (!content.trim()) {
      warnings.push(`Empty FILE block skipped: "${normPath}"`);
      continue;
    }

    files.push({ path: normPath, content });
  }

  return { files, warnings };
}

/** Strip the leading newline and trailing extra whitespace of the block, and ensure it ends with a single newline. */
function stripBlockEdges(raw: string): string {
  // Strip the first newline right after >>>
  let s = raw.replace(/^\r?\n/, "");
  // Strip trailing whitespace
  s = s.replace(/\s+$/, "");
  if (!s) return "";
  return s + "\n";
}
