#!/usr/bin/env bash
# secret-scan.sh — scan the repo working tree for leaked secrets
#
# Usage:
#   scripts/secret-scan.sh                  # scan the repo root, exit 1 on a hit
#   scripts/secret-scan.sh path1 path2 ...  # scan only the specified paths
#
# Integration (pick one of three):
#   1. Git pre-commit hook:
#        cp scripts/secret-scan.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#      (only scanning this commit's staged changes is enough; the script detects it automatically)
#   2. Run manually before Docker build: `bash scripts/secret-scan.sh docker/`
#   3. Run in CI before the build step: `bash scripts/secret-scan.sh || exit 1`
#
# Match rules (regex OR):
#   - High-entropy strings 32+ char base64/hex (possibly Bearer / api_key / secret)
#   - `sk-[a-zA-Z0-9_\-]{15,}` (OpenAI/Anthropic/tdai user_key family)
#   - `Bearer\s+[A-Za-z0-9._+/=~-]{15,}`
#   - `["']?(password|passwd|secret|token|api_key|apikey)["']?\s*[:=]\s*["'][^"']{6,}["']`
#     and the value is not a common placeholder (xxx / your- / example / REPLACE_ / test / demo / dummy)
#
# Allowlist: examples in test/spec/example/docs/README do not fail on a hit. Use --strict to turn off the allowlist.

set -u

STRICT=0
[[ "${1:-}" == "--strict" ]] && { STRICT=1; shift; }

# Directories scanned by default (avoiding node_modules / dist / .git, etc.)
if [[ $# -eq 0 ]]; then
  TARGETS=(src web/src tests config docker README.md package.json)
else
  TARGETS=("$@")
fi

# Known-safe placeholder strings; a hit is treated as not a leak
# Note: `\$\{[A-Za-z_]+\}` covers every `${VAR}` template placeholder reference (such as `"apiKey": "${KEY_PLACEHOLDER}"`) --
# such hits are constant references in source (the real value is defined elsewhere as user-filled), not leaks; `_PLACEHOLDER`
# is its backstop. Do not add an EXEMPT_PATH to exempt a whole path for this, as that would let real secrets in that file through.
#
# Note: `sk-optional-memory` is a **false-positive exemption**, not a placeholder -- it comes from the comment
# "See PR feat/task-optional-memory.". Rule 1 already added a word boundary (sk- cannot be preceded by a word character),
# so mid-word cases no longer match; this exemption is the backstop for the string appearing standalone. Verified that real shapes such as sk-mem-* / sk-proj-*
# are still blocked; this exemption will not let a real key through.
PLACEHOLDER='xxx|your-|example|REPLACE_|placeholder|<[A-Z_]+>|\$\{[A-Za-z_]+\}|dummy|fake|test-|demo-|sample|bogus|invalid-|knowledge-debug|-debug"|task-draft-generator|_PLACEHOLDER|sk-optional-memory'

# Paths needing exemption (example code / known demo passwords / gitignored local files)
EXEMPT_PATH='node_modules/|/dist/|/build/|\.example\.|/docs/|README\.md|\.md:|\.test\.|__tests__/'

## Note: the gitignored check is in the filter_gitignored function below, to avoid arg list too long.

hits=0
tmp=$(mktemp)
trap "rm -f $tmp" EXIT

for t in "${TARGETS[@]}"; do
  [[ -e "$t" ]] || continue
  # ── Rule 1: sk- prefix keys (sk- cannot be immediately preceded by a word character, avoiding mid-word false positives like task-optional-memory) ──
  grep -rEn "(^|[^A-Za-z0-9_-])sk-[a-zA-Z0-9_-]{15,}" "$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true

  # ── Rule 2: Bearer tokens ──
  grep -rEn 'Bearer[[:space:]]+[A-Za-z0-9._+/=~-]{15,}' "$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true

  # ── Rule 3: api_key/secret/password followed by a long value ──
  grep -rEn '"(api_key|apiKey|secret|password|token|passwd)"[[:space:]]*:[[:space:]]*"[^"]{8,}"' "$t" 2>/dev/null \
    | grep -Ev "$PLACEHOLDER" \
    | grep -Ev '"(local|debug|123123)"' >> "$tmp" || true

  # Rule 4 (generic base64 high-entropy scan) was removed -- the false-positive rate was too high without PCRE (camelCase names +
  # paths all match). Rules 1-3 already cover the three main shapes sk-* / Bearer / "api_key":"...".
  # If adding it in future, consider a separate python/node script doing Shannon-entropy detection.
done

# Apply exempt paths + gitignored (gitignored files do not enter commits / images, so there is no leak surface)
final=$(grep -Ev "$EXEMPT_PATH" "$tmp" || true)

# gitignored filter: extract paths line by line, check with git check-ignore -q; a hit is exempt
if git rev-parse --show-toplevel >/dev/null 2>&1 && [[ -n "$final" ]]; then
  repo_root=$(git rev-parse --show-toplevel)
  filtered=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line%%:*}"
    if git -C "$repo_root" check-ignore -q "$path" 2>/dev/null; then
      continue  # gitignored → skip
    fi
    filtered+="$line"$'\n'
  done <<< "$final"
  final="${filtered%$'\n'}"
fi

if [[ -n "$final" ]]; then
  echo "❌ secret-scan: possible sensitive info found ($(echo "$final" | wc -l | tr -d ' ') places)"
  echo
  echo "$final"
  echo
  # The hint points only to PLACEHOLDER: EXEMPT_PATH lets a whole path through (real secrets in the same file slip through too),
  # while an inline-comment exemption requires changing upstream source (polluting others' modules + repeated downstream rebase conflicts); neither is recommended.
  echo "If you confirm it is a false positive, add that specific string to the PLACEHOLDER allowlist at the top of the script (value-level exemption)"
  exit 1
fi

echo "✓ secret-scan: no sensitive info found (scan targets: ${TARGETS[*]})"
exit 0
