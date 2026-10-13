#!/usr/bin/env bash
# Start the **MongoDB mode** trio (memory-core + memory-hub + proxy) with one command.
# Experimental feature: disabled by default; the default entry point is still ./start-all.sh (sqlite).
#
# Relationship to start-all.sh:
#   - start-all.sh keeps its original logic unchanged -- sqlite by default, data lives in container volumes;
#   - this script reuses the same flow, forces MEMORY_CORE_STORE_MODE=mongodb and writes it to .env:
#       · data plane (L0/L1 memory, profile, skill) uses MongoDB + mongot native BM25;
#       · metadata (meta_* team/user/agent/task) also lands in the same Mongo by default
#         （MEMORY_CORE_METADATA_BACKEND=auto）；
#       · when .env does not set MONGODB_ENDPOINT, automatically start a local
#         mongodb-atlas-local container on the same network (mongod + mongot combined, persisted in mongo-local-* volumes).
#
# Usage (identical to start-all.sh):
#   ./start-all-mongo.sh            # Interactively guide LLM setup, then start everything once checks pass
#   PULL=1 ./start-all-mongo.sh     # docker pull to upgrade images first
#
# To go back to sqlite: comment out MEMORY_CORE_STORE_MODE in .env or set it to sqlite, then run ./start-all.sh.
# Switching backends does not migrate existing data.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# If .env does not exist, copy it from the template first so STORE_MODE can be written back.
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env does not exist, copying it from .env.example"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

# Conflict detection: if .env **explicitly** sets a non-mongodb MEMORY_CORE_STORE_MODE,
# the source of .env in start-all.sh would override the export below and silently run in another mode -- so stop it early.
# (That line is commented out by default in .env.example, so standard users will not trigger this.)
env_mode=$(grep -E '^[[:space:]]*MEMORY_CORE_STORE_MODE=' "$ENV_FILE" \
  | tail -n1 | cut -d= -f2- | tr -d '[:space:]"' || true)
if [[ -n "$env_mode" && "$env_mode" != "mongodb" ]]; then
  echo "[error] MEMORY_CORE_STORE_MODE=$env_mode is explicitly set in .env, which conflicts with this script." >&2
  echo "        Pick one:" >&2
  echo "          (1) To use mongo: comment out that line in .env and rerun this script;" >&2
  echo "          (2) To use $env_mode: just run ./start-all.sh." >&2
  exit 1
fi

set_env_value MEMORY_CORE_STORE_MODE mongodb "$ENV_FILE"
export MEMORY_CORE_STORE_MODE=mongodb
echo "[start-all-mongo] Wrote MEMORY_CORE_STORE_MODE=mongodb to .env (data plane + metadata both land in MongoDB by default)"

exec "$SCRIPT_DIR/start-all.sh" "$@"
