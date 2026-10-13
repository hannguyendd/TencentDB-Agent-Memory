#!/usr/bin/env bash
# install-git-hooks.sh — enable the secret-scan pre-commit hook in this repo
#
# Usage: bash scripts/install-git-hooks.sh
#
# Effect: runs scripts/secret-scan.sh automatically before every `git commit`, rejecting the commit on a hit.
# Uninstall: rm .git/hooks/pre-commit
set -eu

repo_root=$(git rev-parse --show-toplevel)
hook_path="$repo_root/.git/hooks/pre-commit"

cat > "$hook_path" <<'EOF'
#!/usr/bin/env bash
# Automatically installed pre-commit hook -- see scripts/install-git-hooks.sh
repo_root=$(git rev-parse --show-toplevel)
exec bash "$repo_root/scripts/secret-scan.sh"
EOF

chmod +x "$hook_path"
echo "✓ pre-commit hook installed at $hook_path"
echo "  secret-scan.sh runs before every git commit; the commit is rejected if sensitive info is found."
echo "  To skip temporarily: git commit --no-verify"
