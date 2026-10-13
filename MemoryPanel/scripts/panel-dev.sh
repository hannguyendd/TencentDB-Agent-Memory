#!/usr/bin/env bash
# panel-dev.sh — local dev service management for the MemoryPanel frontend and backend
#
# Usage:
#   scripts/panel-dev.sh start            start backend + frontend (already-running ones are not started again)
#   scripts/panel-dev.sh stop             stop backend + frontend
#   scripts/panel-dev.sh restart          restart backend + frontend
#   scripts/panel-dev.sh status           show running status
#   scripts/panel-dev.sh logs [backend|web]  follow logs in real time (default backend)
#
# Ports (overridable via env vars):
#   PANEL_BACKEND_PORT   defaults to PORT from .env, otherwise 8123
#   PANEL_WEB_PORT       defaults to 5173
#
# Artifacts (logs/ is gitignored):
#   logs/dev/backend.log  logs/dev/backend.pid
#   logs/dev/web.log      logs/dev/web.pid
#
# Notes:
#   - Backend: `pnpm dev` in the project root (tsx watch src/index.ts), default http://127.0.0.1:8123
#   - Frontend: `npm run dev -- --port <port> --strictPort` in the web/ directory, default http://localhost:5173
#   - On stop, first kill the process tree recorded in the pid file, then clean up any leftover processes holding the port as a backstop;
#     if the port is held by a process that is not from this project it is skipped with a warning, and never killed by mistake.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
RUN_DIR="$ROOT_DIR/logs/dev"

BE_LOG="$RUN_DIR/backend.log"
WEB_LOG="$RUN_DIR/web.log"
BE_PID_FILE="$RUN_DIR/backend.pid"
WEB_PID_FILE="$RUN_DIR/web.pid"

MAX_LOG_BYTES=$((5 * 1024 * 1024))

# ── Port resolution ────────────────────────────────────────────────
resolve_backend_port() {
  local p="${PANEL_BACKEND_PORT:-}"
  if [ -z "$p" ] && [ -f "$ROOT_DIR/.env" ]; then
    p="$(grep -E '^[[:space:]]*PORT=' "$ROOT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '[:space:]"'"'"'')"
  fi
  printf '%s' "${p:-8123}"
}

BACKEND_PORT="$(resolve_backend_port)"
WEB_PORT="${PANEL_WEB_PORT:-5173}"

# ── Basic utilities ────────────────────────────────────────────────
pid_on_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

is_panel_process() {
  local pid="$1" cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [ -z "$cmd" ] && return 1
  case "$cmd" in
    *"$ROOT_DIR"*) return 0 ;;
    *"$(basename "$ROOT_DIR")"*) return 0 ;;
  esac
  return 1
}

# Kill child processes recursively first, then itself, to avoid leftover orphan processes
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  if command -v pgrep >/dev/null 2>&1; then
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      kill_tree "$child" "$sig"
    done
  fi
  kill "-$sig" "$pid" 2>/dev/null || true
}

wait_port_up() {
  local port="$1" i
  for i in $(seq 1 60); do
    [ -n "$(pid_on_port "$port")" ] && return 0
    sleep 0.5
  done
  return 1
}

wait_port_free() {
  local port="$1" i
  for i in $(seq 1 20); do
    [ -z "$(pid_on_port "$port")" ] && return 0
    sleep 0.5
  done
  return 1
}

rotate_log() {
  local f="$1"
  if [ -f "$f" ]; then
    local size
    size="$(wc -c <"$f" | tr -d ' ')"
    if [ "${size:-0}" -gt "$MAX_LOG_BYTES" ]; then
      mv -f "$f" "$f.1"
    fi
  fi
}

# ── start ──────────────────────────────────────────────────
start_backend() {
  local pid
  pid="$(pid_on_port "$BACKEND_PORT")"
  if [ -n "$pid" ]; then
    echo "[backend] already running: pid $pid  http://127.0.0.1:$BACKEND_PORT"
    return 0
  fi
  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    echo "[backend] missing dependencies, please run first: cd $ROOT_DIR && pnpm install" >&2
    return 1
  fi
  if [ ! -f "$ROOT_DIR/.env" ]; then
    cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
    echo "[backend] .env not found, copied from .env.example"
  fi

  mkdir -p "$RUN_DIR"
  rotate_log "$BE_LOG"

  local runner=""
  if command -v pnpm >/dev/null 2>&1; then
    runner="pnpm dev"
  else
    runner="npx tsx watch src/index.ts"
  fi

  ( cd "$ROOT_DIR" && exec nohup $runner </dev/null >>"$BE_LOG" 2>&1 ) &
  echo "$!" >"$BE_PID_FILE"

  if wait_port_up "$BACKEND_PORT"; then
    echo "[backend] started: http://127.0.0.1:$BACKEND_PORT  (log $BE_LOG)"
  else
    echo "[backend] startup timed out, check the log: $BE_LOG" >&2
    return 1
  fi
}

start_web() {
  local pid
  pid="$(pid_on_port "$WEB_PORT")"
  if [ -n "$pid" ]; then
    echo "[web]     already running: pid $pid  http://localhost:$WEB_PORT"
    return 0
  fi
  if [ ! -d "$WEB_DIR/node_modules" ]; then
    echo "[web]     missing dependencies, please run first: cd $WEB_DIR && npm install" >&2
    return 1
  fi

  mkdir -p "$RUN_DIR"
  rotate_log "$WEB_LOG"

  ( cd "$WEB_DIR" && exec nohup npm run dev -- --port "$WEB_PORT" --strictPort </dev/null >>"$WEB_LOG" 2>&1 ) &
  echo "$!" >"$WEB_PID_FILE"

  if wait_port_up "$WEB_PORT"; then
    echo "[web]     started: http://localhost:$WEB_PORT  (log $WEB_LOG)"
  else
    echo "[web]     startup timed out, check the log: $WEB_LOG" >&2
    return 1
  fi
}

# ── stop ───────────────────────────────────────────────────
stop_target() {
  local name="$1" port="$2" pidfile="$3"
  local candidates="" p lp

  if [ -f "$pidfile" ]; then
    p="$(tr -d '[:space:]' <"$pidfile" 2>/dev/null || true)"
    [ -n "$p" ] && candidates="$p"
  fi

  lp="$(pid_on_port "$port")"
  if [ -n "$lp" ]; then
    case " $candidates " in
      *" $lp "*) ;;
      *) candidates="${candidates:+$candidates }$lp" ;;
    esac
  fi

  if [ -z "$candidates" ]; then
    echo "[$name] not running (port $port is free)"
    rm -f "$pidfile"
    return 0
  fi

  for p in $candidates; do
    if ! kill -0 "$p" 2>/dev/null; then
      continue
    fi
    if ! is_panel_process "$p"; then
      echo "[$name] port $port is held by a process not from this project, skipped: pid $p  $(ps -o command= -p "$p" 2>/dev/null)" >&2
      continue
    fi
    kill_tree "$p" TERM
  done

  if wait_port_free "$port"; then
    echo "[$name] stopped (port $port released)"
    rm -f "$pidfile"
    return 0
  fi

  echo "[$name] process did not respond to TERM, force killing…" >&2
  for p in $candidates; do
    is_panel_process "$p" && kill_tree "$p" KILL
  done
  if wait_port_free "$port"; then
    echo "[$name] force stopped (port $port released)"
    rm -f "$pidfile"
    return 0
  fi
  echo "[$name] stop failed, port $port is still in use" >&2
  return 1
}

# ── status ─────────────────────────────────────────────────
status_one() {
  local name="$1" port="$2" url="$3" pid
  pid="$(pid_on_port "$port")"
  if [ -z "$pid" ]; then
    printf '%-8s not running  (port %s)\n' "$name" "$port"
    return 1
  fi
  if is_panel_process "$pid"; then
    printf '%-8s running  pid %-7s port %-5s %s\n' "$name" "$pid" "$port" "$url"
  else
    printf '%-8s port %s held by another process  pid %s  %s\n' "$name" "$port" "$pid" "$(ps -o command= -p "$pid" 2>/dev/null)"
  fi
}

cmd_status() {
  status_one "backend" "$BACKEND_PORT" "http://127.0.0.1:$BACKEND_PORT/health"
  status_one "web" "$WEB_PORT" "http://localhost:$WEB_PORT"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$BACKEND_PORT/health" 2>/dev/null || true)"
  [ -n "$code" ] && echo "backend /health -> $code"
}

# ── logs ───────────────────────────────────────────────────
cmd_logs() {
  local which="${1:-backend}" f
  case "$which" in
    backend | be) f="$BE_LOG" ;;
    web | frontend | fe) f="$WEB_LOG" ;;
    *)
      echo "Usage: $0 logs [backend|web]" >&2
      return 2
      ;;
  esac
  [ -f "$f" ] || {
    echo "Log file does not exist: $f" >&2
    return 1
  }
  tail -n 100 -f "$f"
}

# ── Entry ───────────────────────────────────────────────────
usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

cmd_start() {
  local rc=0
  start_backend || rc=1
  start_web || rc=1
  echo
  cmd_status
  return "$rc"
}

cmd_stop() {
  local rc=0
  stop_target "backend" "$BACKEND_PORT" "$BE_PID_FILE" || rc=1
  stop_target "web" "$WEB_PORT" "$WEB_PID_FILE" || rc=1
  return "$rc"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart)
    cmd_stop
    echo
    sleep 1
    cmd_start
    ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "${1:-backend}" ;;
  "" | -h | --help | help) usage ;;
  *)
    echo "Unknown command: $1" >&2
    usage
    exit 2
    ;;
esac
