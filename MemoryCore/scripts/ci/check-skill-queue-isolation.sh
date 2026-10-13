#!/usr/bin/env bash
# scripts/ci/check-skill-queue-isolation.sh
#
# Skill async queue red-line guard script
#
# Purpose: block in CI any diff that would pollute the "memory module", and block the Skill module
#       from importing node:fs directly (must go through StorageAdapter).
#
# Checks:
#   1) Forbid changes to the following memory-related red-line files / directories:
#        - src/core/state/types.ts
#        - src/core/state/local-backend.ts
#        - src/services/pipeline-worker.ts
#        - src/integrations/redis/**          (future memory Redis backend; note this is not redis-skill)
#   2) Forbid src/core/skill/** from adding `from "node:fs"` / `from "fs"` / `from "fs/promises"` imports.
#
# Usage:
#   - Local (compared with origin/main): bash scripts/ci/check-skill-queue-isolation.sh
#   - In CI with a specified base: BASE_REF=origin/main bash scripts/ci/check-skill-queue-isolation.sh
#   - Skip (not recommended, emergency bypass only): SKIP_SKILL_QUEUE_ISOLATION=1 bash scripts/ci/check-skill-queue-isolation.sh
#
# Exit codes:
#   0: pass
#   1: red line touched
#   2: environment/dependency problem (git unavailable, etc.)

set -euo pipefail

if [[ "${SKIP_SKILL_QUEUE_ISOLATION:-0}" == "1" ]]; then
  echo "[skill-queue-isolation] SKIP_SKILL_QUEUE_ISOLATION=1, skipping red-line check (not recommended)"
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[skill-queue-isolation] ERROR: git is unavailable" >&2
  exit 2
fi

BASE_REF="${BASE_REF:-origin/main}"
MODE="${MODE:-auto}"   # auto | working-tree | base-diff

# If BASE_REF does not exist (e.g. shallow clone), fall back to HEAD~1
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  if git rev-parse --verify --quiet "HEAD~1" >/dev/null; then
    BASE_REF="HEAD~1"
  else
    echo "[skill-queue-isolation] WARN: cannot locate BASE_REF=$BASE_REF and there is no HEAD~1 either, skipping check"
    exit 0
  fi
fi

echo "[skill-queue-isolation] BASE_REF=$BASE_REF MODE=$MODE"

# Get the list of diff files (A/M/D/R all count)
# - base-diff: compared with BASE_REF (used in CI)
# - working-tree: includes staged + unstaged working tree changes (used locally)
# - auto: in CI (GITHUB_ACTIONS=true / CI=true) use base-diff, otherwise working-tree
case "$MODE" in
  base-diff)
    CHANGED=$(git diff --name-only --diff-filter=ACMRT "$BASE_REF"...HEAD || true)
    ;;
  working-tree)
    CHANGED=$(git status --porcelain | awk '$1 ~ /^[AM?RC]/ || $1 ~ /^.[AM]/ {print $NF}' | sort -u || true)
    ;;
  auto|*)
    if [[ "${GITHUB_ACTIONS:-}" == "true" || "${CI:-}" == "true" ]]; then
      CHANGED=$(git diff --name-only --diff-filter=ACMRT "$BASE_REF"...HEAD || true)
    else
      # Local: merge base..HEAD + working tree changes to maximize coverage
      CHANGED=$( { git diff --name-only --diff-filter=ACMRT "$BASE_REF"...HEAD 2>/dev/null || true; \
                   git status --porcelain | awk '$1 ~ /^[AM?RC]/ || $1 ~ /^.[AM]/ {print $NF}'; } | sort -u)
    fi
    ;;
esac

if [[ -z "$CHANGED" ]]; then
  echo "[skill-queue-isolation] no file changes, pass"
  exit 0
fi

VIOLATIONS=()

# -- Red line 1: specific files forbidden to change --
FORBIDDEN_FILES=(
  "src/core/state/types.ts"
  "src/core/state/local-backend.ts"
  "src/services/pipeline-worker.ts"
)

for f in "${FORBIDDEN_FILES[@]}"; do
  if echo "$CHANGED" | grep -qx "$f"; then
    VIOLATIONS+=("Forbidden file change: $f")
  fi
done

# -- Red line 2: forbid changes to the src/integrations/redis/ directory (note: redis-skill is allowed) --
# Use awk to precisely match the `src/integrations/redis/` prefix but exclude `src/integrations/redis-skill/`
while IFS= read -r f; do
  case "$f" in
    src/integrations/redis-skill/*) ;;  # allowed
    src/integrations/redis/*)
      VIOLATIONS+=("Forbidden change to memory Redis directory: $f")
      ;;
  esac
done <<< "$CHANGED"

# -- Red line 3: src/core/skill/** must not import node:fs directly --
# Only check .ts files hit by the diff; test files (*.test.ts / __tests__/) are exempt,
# since tests often need to set up tmpdir scaffolding directly (it never reaches runtime product code).
SKILL_TS_CHANGED=$(echo "$CHANGED" | grep -E '^src/core/skill/.*\.ts$' | grep -vE '\.test\.ts$|/__tests__/' || true)

if [[ -n "$SKILL_TS_CHANGED" ]]; then
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    # Catch fs / node:fs / fs/promises in import statements
    if grep -nE 'from[[:space:]]+["'"'"']?(node:fs|fs|fs/promises)["'"'"']?' "$f" >/dev/null; then
      MATCH=$(grep -nE 'from[[:space:]]+["'"'"']?(node:fs|fs|fs/promises)["'"'"']?' "$f" | head -3)
      VIOLATIONS+=("Skill module must not import fs directly: $f"$'\n'"$MATCH")
    fi
  done <<< "$SKILL_TS_CHANGED"
fi

# -- Summary --
if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
  echo ""
  echo "==================================================================="
  echo "[skill-queue-isolation] FAIL: detected ${#VIOLATIONS[@]} red-line violations"
  echo "==================================================================="
  for v in "${VIOLATIONS[@]}"; do
    echo "  - $v"
  done
  echo ""
  echo "To bypass (emergencies only), set SKIP_SKILL_QUEUE_ISOLATION=1, but a reviewer must +2"
  echo "See ADR: docs/design/2026-06-16-skill-extract-queue.md / 2026-06-16-skill-storage-adapter.md"
  exit 1
fi

echo "[skill-queue-isolation] PASS"
exit 0
