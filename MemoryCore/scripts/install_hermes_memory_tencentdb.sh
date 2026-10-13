#!/bin/bash
#
# install_memory_tencentdb.sh
#
# Run after install_hermes_ubuntu.sh, to:
#   1. Download @tencentdb-agent-memory/memory-tencentdb@latest via npm into
#      $MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin (default ~/.memory-tencentdb/tdai-memory-openclaw-plugin)
#   2. Install the Gateway's Node.js dependencies (npm install)
#   3. Configure hermes config.yaml to use the memory_tencentdb memory provider
#   4. Set the Gateway auto-start environment variables
#
# Path conventions (all under ~/.memory-tencentdb/, overridable via environment variables):
#   $MEMORY_TENCENTDB_ROOT     default ~/.memory-tencentdb
#   $TDAI_INSTALL_DIR          default $MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin
#   $TDAI_DATA_DIR             default $MEMORY_TENCENTDB_ROOT/memory-tdai
#
# Older versions (<= 0.3.x) used ~/tdai-memory-openclaw-plugin and ~/memory-tdai;
# this script automatically migrates those two old directories to the new location before running (see Step 0).
#
# Usage:
#   Run as the target user (recommended):
#     su - <username> -c "bash ~/install_memory_tencentdb.sh"
#     # or log in as that user directly and run
#     bash ~/install_memory_tencentdb.sh
#
#   Run as root (image-build scenario):
#     bash ~/install_memory_tencentdb.sh
#     # root automatically switches to the target user via su to run, and fixes permissions afterwards
#
# Prerequisites:
#   - install_hermes_ubuntu.sh has completed (hermes-agent is installed)
#   - Node.js >= 22 is installed

set -e

# Dynamically determine the target install user and its HOME directory.
# Priority:
#   1. An explicit ``INSTALL_AS_USER`` environment variable (admin-script scenario: root runs the install but
#      wants to configure it for another user)
#   2. ``SUDO_USER`` (when invoked via ``sudo``, switch back to the original user instead of root)
#   3. ``whoami`` -- the user corresponding to the current EUID
#
# Note: when root runs it directly over ssh login (not sudo), neither of the first two is set and
# ``whoami`` returns ``root``. The ``id -u`` == 0 branch below recognizes this "target
# is root" case and skips the ``su - root`` recursion.
USERNAME="${INSTALL_AS_USER:-${SUDO_USER:-$(whoami)}}"
USER_HOME=$(eval echo ~$USERNAME)

# npm package name
NPM_PACKAGE="@tencentdb-agent-memory/memory-tencentdb@latest"

# Hermes path
HERMES_HOME="$USER_HOME/.hermes"
# HERMES_AGENT_DIR (fix: issue #18)
# Whatever the user passes via environment variables is used; when unset, fall back to the traditional path.
# If the directory does not exist, the later prerequisite check reports an error uniformly.
HERMES_AGENT_DIR="${HERMES_AGENT_DIR:-$HERMES_HOME/hermes-agent}"
HERMES_CONFIG="$HERMES_HOME/config.yaml"

# memory-tencentdb unified root directory (all tdai-related data/code is collected here)
# Overridable via the environment variable MEMORY_TENCENTDB_ROOT
MEMORY_TENCENTDB_ROOT="${MEMORY_TENCENTDB_ROOT:-$USER_HOME/.memory-tencentdb}"

# tdai extraction target directory (under the unified root directory)
# Overridable via the environment variable TDAI_INSTALL_DIR
TDAI_INSTALL_DIR="${TDAI_INSTALL_DIR:-$MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin}"

# tdai data directory (Gateway baseDir, under the unified root directory)
# Overridable via the environment variable TDAI_DATA_DIR
TDAI_DATA_DIR="${TDAI_DATA_DIR:-$MEMORY_TENCENTDB_ROOT/memory-tdai}"

# Old paths (only used for automatic migration)
LEGACY_INSTALL_DIR="$USER_HOME/tdai-memory-openclaw-plugin"
LEGACY_DATA_DIR="$USER_HOME/memory-tdai"

# ==================== root -> automatically switch to the target user ====================
# Consistent with install_hermes_ubuntu.sh: if run as root and the target user is not
# root, automatically su to the target user to run the actual install logic.
#
# If the current user is root and the target user is also root (``USERNAME=root``, e.g. logging in directly over ssh
# as root to run the install), skip ``su - root`` -- otherwise it recurses infinitely (``su - root``
# still lands in root, which hits this branch again, su again, never stopping). See issue #20.

if [ "$(id -u)" -eq 0 ] && [ "$USERNAME" != "root" ]; then
    echo "[memory-tencentdb] Running as root, switching to $USERNAME for installation..."

    # Validate prerequisites
    if [ ! -d "$HERMES_AGENT_DIR" ]; then
        echo "[ERROR] Hermes agent not found at $HERMES_AGENT_DIR"
        echo "[ERROR] Please run install_hermes_ubuntu.sh first."
        exit 1
    fi

    # Switch to the target user to run
    TEMP_SCRIPT=$(mktemp /tmp/memory-tencentdb-install-XXXXXX.sh)
    cp "${BASH_SOURCE[0]}" "$TEMP_SCRIPT"
    chmod 755 "$TEMP_SCRIPT"
    su - $USERNAME -c "bash $TEMP_SCRIPT" </dev/null

    # Fix permissions
    echo "[memory-tencentdb] Fixing permissions..."
    chown -R $USERNAME:$USERNAME "$USER_HOME"

    rm -f "$TEMP_SCRIPT"
    echo "[memory-tencentdb] Installation completed successfully"
    exit 0
elif [ "$(id -u)" -eq 0 ]; then
    # The current user is root and the target user is also root: run the subsequent install logic directly as root,
    # without ``su -`` switching (avoiding the recursion of #20).
    echo "[memory-tencentdb] Running as root; target user is also root — installing in place."
fi

# ==================== User phase (core install logic) ====================

echo "[memory-tencentdb] Installing memory-tencentdb plugin (user: $(whoami))..."

# Validate prerequisites
if [ ! -d "$HERMES_AGENT_DIR" ]; then
    echo "[ERROR] Hermes agent not found at $HERMES_AGENT_DIR"
    echo "[ERROR] Please run install_hermes_ubuntu.sh first."
    exit 1
fi

# Load the hermes environment (node/npm are needed in PATH)
if [ -f /etc/profile.d/hermes-env.sh ]; then
    source /etc/profile.d/hermes-env.sh
fi

# Ensure the unified root directory exists
mkdir -p "$MEMORY_TENCENTDB_ROOT"

# ---------- Step 0: automatically migrate old paths (backward compatibility) ----------
#
# Historical versions extracted tdai to ~/tdai-memory-openclaw-plugin and put data in ~/memory-tdai.
# Now everything is collected under ~/.memory-tencentdb/, and a one-time automatic migration is done here.
# Skip when already at the new location; when both old and new exist, print a warning and leave the new location untouched.

migrate_legacy_dir() {
    local legacy="$1"
    local target="$2"
    local label="$3"
    if [ ! -e "$legacy" ]; then
        return 0
    fi
    if [ -L "$legacy" ]; then
        # The old location is a symlink; just remove it
        echo "[memory-tencentdb] Removing legacy symlink: $legacy"
        rm -f "$legacy"
        return 0
    fi
    if [ -e "$target" ]; then
        echo "[memory-tencentdb] WARN: legacy $label dir exists at $legacy but new location $target also exists." >&2
        echo "[memory-tencentdb] WARN: keeping new location; please review and remove $legacy manually if obsolete." >&2
        return 0
    fi
    echo "[memory-tencentdb] Migrating legacy $label dir: $legacy -> $target"
    mkdir -p "$(dirname "$target")"
    mv "$legacy" "$target"
}

migrate_legacy_dir "$LEGACY_INSTALL_DIR" "$TDAI_INSTALL_DIR" "install"
migrate_legacy_dir "$LEGACY_DATA_DIR"    "$TDAI_DATA_DIR"    "data"

# ---------- Step 1: download the package via npm and extract it to $TDAI_INSTALL_DIR ----------

echo "[memory-tencentdb] Step 1: Downloading $NPM_PACKAGE via npm..."

# Clean up the old installation
rm -rf "$TDAI_INSTALL_DIR"

# Use a temporary directory to download the package via npm install
TEMP_DOWNLOAD=$(mktemp -d /tmp/memory-tencentdb-download-XXXXXX)
cd "$TEMP_DOWNLOAD"
npm init -y --silent > /dev/null 2>&1
npm install "$NPM_PACKAGE" --omit=dev 2>&1 | tail -5

# After the package is installed it lives in node_modules/@tencentdb-agent-memory/memory-tencentdb
PACK_DIR="$TEMP_DOWNLOAD/node_modules/@tencentdb-agent-memory/memory-tencentdb"

if [ ! -d "$PACK_DIR" ]; then
    echo "[ERROR] Downloaded package directory not found at $PACK_DIR"
    rm -rf "$TEMP_DOWNLOAD"
    exit 1
fi

# Move the package contents to the target install directory
mkdir -p "$(dirname "$TDAI_INSTALL_DIR")"
cp -r "$PACK_DIR" "$TDAI_INSTALL_DIR"

echo "[memory-tencentdb] Package downloaded and extracted to $TDAI_INSTALL_DIR"

# ---------- Step 2: install the Gateway Node.js dependencies ----------

echo "[memory-tencentdb] Step 2: Installing Gateway dependencies..."

cd "$TDAI_INSTALL_DIR"

echo "[memory-tencentdb] Running npm install (this may take a while)..."
npm install --omit=dev 2>&1 | tail -5

# Install tsx (needed to start the Gateway), preferring a local install
if ! npx tsx --version &>/dev/null; then
    npm install tsx 2>&1 | tail -2
fi

echo "[memory-tencentdb] Gateway dependencies installed"

# ---------- Step 2.5: link the plugin into the hermes plugin directory ----------

echo "[memory-tencentdb] Step 2.5: Linking plugin into hermes plugins directory..."

HERMES_PLUGIN_DIR="$HERMES_AGENT_DIR/plugins/memory/memory_tencentdb"
PLUGIN_SRC_DIR="$TDAI_INSTALL_DIR/hermes-plugin/memory/memory_tencentdb"

# Remove the old link/directory
rm -rf "$HERMES_PLUGIN_DIR"

# Create a symlink so hermes can discover the plugin
ln -sf "$PLUGIN_SRC_DIR" "$HERMES_PLUGIN_DIR"

echo "[memory-tencentdb] Plugin linked: $HERMES_PLUGIN_DIR -> $PLUGIN_SRC_DIR"

# ---------- Step 3: prompt the user to enable memory_tencentdb manually (config is not modified automatically) ----------

echo "[memory-tencentdb] Step 3: Checking hermes config..."

# The plugin is linked into the hermes plugin directory but is not enabled automatically by default; only a prompt is shown
if [ -f "$HERMES_CONFIG" ]; then
    if sed -n '/^memory:/,/^[a-zA-Z]/p' "$HERMES_CONFIG" | grep -q "provider: memory_tencentdb"; then
        echo "[memory-tencentdb] memory.provider already set to memory_tencentdb"
    else
        echo "[memory-tencentdb] Plugin installed but NOT enabled by default."
        echo "[memory-tencentdb] To enable tdai memory, add/edit in $HERMES_CONFIG:"
        echo ""
        echo "    memory:"
        echo "      provider: memory_tencentdb"
        echo ""
    fi
else
    echo "[memory-tencentdb] WARN: $HERMES_CONFIG not found, please run install_hermes_ubuntu.sh first"
fi

# ---------- Step 4: configure the Gateway environment variables ----------

echo "[memory-tencentdb] Step 4: Setting up Gateway environment..."

# Build the Gateway start command
# Wrapped with sh -c, cd to the plugin directory first and then start the Gateway (needed for ESM resolution)
#
# Resolve the absolute node path into GATEWAY_CMD (fix: issue #19)
# When Hermes or a standalone Gateway runs as a systemd service, systemd does not
# source any user shell rc file, so the PATH injected by nvm/asdf does not exist.
# Use `command -v node` to resolve the absolute path at install time, and use Node's native
# `--import tsx/esm` (Node >= 20.6 stable) instead of `npx tsx`,
# so the final command does not depend on the runtime PATH at all.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "[ERROR] 'node' not found in PATH; cannot generate Gateway start command." >&2
    echo "[ERROR] If you installed Node via nvm/asdf, source the loader script first:" >&2
    echo "[ERROR]   source ~/.bashrc   # or 'nvm use <version>'" >&2
    exit 1
fi
echo "[memory-tencentdb] Resolved node: $NODE_BIN"

GATEWAY_CMD="sh -c 'cd $TDAI_INSTALL_DIR && exec \"$NODE_BIN\" --import tsx/esm src/gateway/server.ts'"

# -- 4a: /etc/profile.d (SSH interactive login scenario) --
# Write persistent environment variables to /etc/profile.d, for when `hermes` is run manually over SSH.
# Note: LLM-related variables (API key, model, etc.) must be configured manually by the user afterwards
ENVFILE="/etc/profile.d/memory-tencentdb-env.sh"
cat << ENVEOF | sudo tee "$ENVFILE" > /dev/null
# memory-tencentdb Gateway environment variables
export MEMORY_TENCENTDB_GATEWAY_CMD="$GATEWAY_CMD"
export MEMORY_TENCENTDB_GATEWAY_HOST="127.0.0.1"
export MEMORY_TENCENTDB_GATEWAY_PORT="8420"
# LLM config (modify as needed)
# export MEMORY_TENCENTDB_LLM_API_KEY="sk-..."
# export MEMORY_TENCENTDB_LLM_BASE_URL="https://api.openai.com/v1"
# export MEMORY_TENCENTDB_LLM_MODEL="gpt-4o"
ENVEOF

echo "[memory-tencentdb] Environment variables written to $ENVFILE"

# -- 4b: ~/.hermes/.env (systemd service scenario) --
# When hermes-gateway is started via a systemd user service it does not source /etc/profile.d/*.sh,
# but hermes's run.py does load_dotenv("~/.hermes/.env") at startup.
# So the key variables must also be written into .env, otherwise the Gateway cannot start automatically in the systemd scenario.
HERMES_ENV="$HERMES_HOME/.env"

_append_or_update_env() {
    local key="$1"
    local value="$2"
    local file="$3"
    if [ ! -f "$file" ]; then
        touch "$file"
    fi
    # Remove existing lines of the same variable name (including commented-out and quoted ones), then append
    sed -i "/^${key}=/d" "$file"
    sed -i "/^# *${key}=/d" "$file"
    # python-dotenv requires values containing spaces/quotes/special characters to be wrapped in double quotes
    echo "${key}=\"${value}\"" >> "$file"
}

_append_or_update_env "MEMORY_TENCENTDB_GATEWAY_CMD" "$GATEWAY_CMD" "$HERMES_ENV"
_append_or_update_env "MEMORY_TENCENTDB_GATEWAY_HOST" "127.0.0.1"   "$HERMES_ENV"
_append_or_update_env "MEMORY_TENCENTDB_GATEWAY_PORT" "8420"         "$HERMES_ENV"

echo "[memory-tencentdb] Gateway env vars also written to $HERMES_ENV (for systemd service)"

# ---------- Cleanup ----------

rm -rf "$TEMP_DOWNLOAD"

# ---------- Verify the installation ----------

echo ""
echo "=========================================="
echo "[memory-tencentdb] Installation Summary"
echo "=========================================="
echo "  Root dir:       $MEMORY_TENCENTDB_ROOT"
echo "  tdai source:    $TDAI_INSTALL_DIR"
echo "  tdai data dir:  $TDAI_DATA_DIR"
echo "  Hermes config:  $HERMES_CONFIG"
echo "  Env file:       $ENVFILE"
echo ""
echo "  Installed files in tdai dir:"
ls -la "$TDAI_INSTALL_DIR"/ 2>/dev/null | head -20 || echo "  (none)"
echo ""

# Verify the hermes plugin files exist (in the extraction directory)
PLUGIN_SRC="$TDAI_INSTALL_DIR/hermes-plugin/memory/memory_tencentdb"
MISSING=0
for f in __init__.py plugin.yaml client.py supervisor.py; do
    if [ ! -f "$PLUGIN_SRC/$f" ]; then
        echo "  [WARN] Missing: $PLUGIN_SRC/$f"
        MISSING=1
    fi
done

if [ "$MISSING" -eq 0 ]; then
    echo "  [OK] All hermes plugin files present"
fi

# Verify the Gateway entry exists
if [ -f "$TDAI_INSTALL_DIR/src/gateway/server.ts" ]; then
    echo "  [OK] Gateway entry point found"
else
    echo "  [WARN] Gateway server.ts not found at $TDAI_INSTALL_DIR/src/gateway/server.ts"
fi

# Verify node_modules has been installed
if [ -d "$TDAI_INSTALL_DIR/node_modules" ]; then
    echo "  [OK] Gateway node_modules installed"
else
    echo "  [WARN] Gateway node_modules not found"
fi

echo ""
echo "[memory-tencentdb] Done!"
echo ""
echo "  NOTE: Before using the memory plugin, configure LLM credentials in ~/.hermes/.env:"
echo "    MEMORY_TENCENTDB_LLM_API_KEY=your-api-key"
echo "    MEMORY_TENCENTDB_LLM_BASE_URL=https://api.openai.com/v1"
echo "    MEMORY_TENCENTDB_LLM_MODEL=gpt-4o"
echo ""
echo "  (For systemd-managed hermes-gateway, ~/.hermes/.env is the authoritative config."
echo "   /etc/profile.d/ is only used for interactive SSH sessions.)"
echo ""
