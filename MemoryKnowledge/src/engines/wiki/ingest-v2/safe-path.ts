/**
 * safe-path.ts — boundary validation for on-disk paths.
 *
 * The on-disk path for ingest is derived indirectly from LLM output (FILE block path + frontmatter type);
 * an error at any link in the derivation chain could yield a relative path that escapes the project directory. This provides the last
 * check, independent of the derivation logic: it only accepts "still inside root after resolving to an absolute path".
 */

import { resolve, sep } from "node:path";

/**
 * Whether candidate still falls within root after resolution (root itself counts).
 *
 * Both sides go through resolve before comparison, so `..`, `.`, and duplicate separators are already collapsed;
 * the prefix comparison additionally appends the separator, so `/data/proj-evil` is not judged to be inside `/data/proj`.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}
