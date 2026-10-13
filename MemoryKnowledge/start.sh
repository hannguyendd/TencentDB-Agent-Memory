#!/usr/bin/env bash
set -euo pipefail

# ─── Knowledge Service startup script ───
# Automatically handles compatibility issues with the Node version, pnpm, better-sqlite3 compilation, etc.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_VERSION="22.19.0"
NODE_PATH="/codev/opt/nodejs/${NODE_VERSION}/bin"
PYTHON_BIN="/usr/bin/python3.8"

echo "========================================"
echo "  Knowledge Service startup script"
echo "========================================"

# ── Step 1: Check/switch Node version ──
echo "[1/5] Checking Node.js version..."
if [ ! -x "${NODE_PATH}/node" ]; then
  echo "  Error: Node.js ${NODE_VERSION} not found (${NODE_PATH})"
  echo "  Please install Node.js ${NODE_VERSION} first"
  exit 1
fi

export PATH="${NODE_PATH}:$PATH"
echo "  Node: $(node -v) ($(which node))"
echo "  npm:  $(npm -v)"

# ── Step 2: Install pnpm (if needed) ──
echo "[2/5] Checking pnpm..."
if ! command -v pnpm &>/dev/null; then
  echo "  Installing pnpm@9.15.0..."
  npm install -g pnpm@9.15.0 2>&1 | tail -1
fi
echo "  pnpm: $(pnpm --version)"

# ── Step 3: Install dependencies ──
echo "[3/5] Installing dependencies..."
if [ ! -d "node_modules" ]; then
  PYTHON="${PYTHON_BIN}" npm_config_python="${PYTHON_BIN}" pnpm install --ignore-scripts
fi

# ── Step 4: Build better-sqlite3 ──
echo "[4/5] Building better-sqlite3..."
BETTER_SQLITE3_DIR="node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3"
BINDING_GYP="${BETTER_SQLITE3_DIR}/binding.gyp"
BUILD_NODE="${BETTER_SQLITE3_DIR}/build/Release/better_sqlite3.node"

if [ ! -f "${BUILD_NODE}" ]; then
  # Patch: GCC 8.5 does not support -std=c++20
  if [ -f "${BINDING_GYP}" ]; then
    sed -i "s/-std=c++20/-std=c++2a/g" "${BINDING_GYP}"
    echo "  Patched binding.gyp: -std=c++20 → -std=c++2a"
  fi

  # Build manually
  cd "${BETTER_SQLITE3_DIR}"
  PYTHON="${PYTHON_BIN}" npm_config_python="${PYTHON_BIN}" \
    npx node-gyp rebuild --python="${PYTHON_BIN}" 2>&1 | grep -E "(gyp info ok|error|Error)" || true
  cd "$SCRIPT_DIR"

  if [ -f "${BUILD_NODE}" ]; then
    echo "  better-sqlite3 built successfully"
  else
    echo "  Error: better-sqlite3 build failed"
    exit 1
  fi
else
  echo "  better-sqlite3 already built, skipping"
fi

# ── Step 5: Start the service ──
echo "[5/5] Starting Knowledge service..."
echo "  Port: ${PORT:-8421}"
echo "  Data directory: ${KNOWLEDGE_DATA_DIR:-~/.memory-tencentdb/knowledge}"
echo "========================================"
echo ""

pnpm run dev
