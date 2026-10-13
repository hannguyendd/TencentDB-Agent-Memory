#!/usr/bin/env bash
# context-proxy background management script (starts proxy + daemon by default)
# Usage: ./proxy.sh [start|stop|restart|status|log|daemon|daemon-stop|daemon-status]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Project root (parent of scripts/); src/index.ts and config.yaml are both here
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$SCRIPT_DIR/context-proxy.pid"
DAEMON_PID_FILE="$SCRIPT_DIR/context-proxy-daemon.pid"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"
DAEMON_LOG="$LOG_DIR/daemon.log"
CONFIG_FILE="$PROJECT_ROOT/config.yaml"

# Read the port from config.yaml (default 8096)
PROXY_PORT="$(grep -E '^\s*port:' "$CONFIG_FILE" 2>/dev/null | head -1 | awk '{print $2}')"
PROXY_PORT="${PROXY_PORT:-8096}"

# Daemon configuration (can be overridden via environment variables)
DAEMON_CHECK_INTERVAL="${DAEMON_CHECK_INTERVAL:-5}"       # health check interval (seconds)
DAEMON_MAX_RESTARTS="${DAEMON_MAX_RESTARTS:-10}"           # max restarts within the window
DAEMON_RESTART_WINDOW="${DAEMON_RESTART_WINDOW:-300}"      # restart counting window (seconds)
DAEMON_BACKOFF_BASE="${DAEMON_BACKOFF_BASE:-2}"            # backoff exponent base
DAEMON_BACKOFF_MAX="${DAEMON_BACKOFF_MAX:-60}"             # max backoff interval (seconds)

# If this is the daemon loop entry, skip set -euo strict mode to avoid unexpected exits
if [[ "${1:-}" != "_daemon_entry" ]]; then
  set -euo pipefail
fi

# Ensure logs directory exists
mkdir -p "$LOG_DIR"

# Auto-detect the node path (supports nvm / fnm / system install / custom paths)
_find_node() {
  local p
  # 1. Try NVM first, force-activate it and locate Node v22
  for s in "$HOME/.nvm/nvm.sh" /usr/local/nvm/nvm.sh; do
    if [[ -f "$s" ]]; then
      source "$s" 2>/dev/null
      p="$(nvm which 22 2>/dev/null || nvm which default 2>/dev/null)"
      [[ -n "$p" ]] && { echo "$p"; return; }
    fi
  done
  # 2. Try FNM
  if command -v fnm &>/dev/null; then
    eval "$(fnm env 2>/dev/null)"
    p="$(command -v node 2>/dev/null)"
    [[ -n "$p" ]] && { echo "$p"; return; }
  fi
  # 3. Fall back to the current PATH
  p="$(command -v node 2>/dev/null)" && { echo "$p"; return; }
  # 4. Common custom directories
  for d in "$HOME/.workbuddy/binaries/node/versions" "$HOME/.local/share/fnm/node-versions"; do
    [[ -d "$d" ]] && { p="$(find "$d" -maxdepth 3 -type f -name node -executable 2>/dev/null | sort -V | tail -1)"; [[ -n "$p" ]] && { echo "$p"; return; }; }
  done
  return 1
}

NODE_BIN="$(_find_node)" || { echo "[context-proxy] ERROR: node not found" >&2; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$PATH"

_is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

cmd_start() {
  if _is_running; then
    echo "[context-proxy] already running (pid=$(cat "$PID_FILE"))"
    return 0
  fi

  echo "[context-proxy] starting..."
  cd "$PROJECT_ROOT"
  nohup "$NODE_BIN" --import tsx/esm src/index.ts --config "$CONFIG_FILE" \
    >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  # Wait for startup
  local i=0
  while (( i < 10 )); do
    if curl -sf http://localhost:${PROXY_PORT}/health > /dev/null 2>&1; then
      echo "[context-proxy] started (pid=$(cat "$PID_FILE"))"
      echo "[context-proxy] log: $LOG_FILE"
      return 0
    fi
    sleep 0.5
    (( i++ )) || true
  done

  echo "[context-proxy] failed to start, check log: $LOG_FILE" >&2
  return 1
}

cmd_stop() {
  # Stop the daemon first, to keep it from immediately restarting the proxy
  if _daemon_is_running; then
    cmd_daemon_stop
  fi

  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  # Fallback: make sure the port is released
  fuser -k ${PROXY_PORT}/tcp 2>/dev/null || true
  sleep 1
  if [[ -n "$pid" ]]; then
    echo "[context-proxy] stopped (pid=$pid)"
  else
    echo "[context-proxy] stopped"
  fi
}

cmd_restart() {
  cmd_daemon_stop
  cmd_stop
  sleep 1
  cmd_daemon
}

cmd_status() {
  if _is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "[context-proxy] running (pid=$pid)"
    curl -s http://localhost:${PROXY_PORT}/health | python3 -m json.tool 2>/dev/null || \
      curl -s http://localhost:${PROXY_PORT}/health
  else
    echo "[context-proxy] not running"
  fi
}

cmd_log() {
  local today_log="$LOG_DIR/$(date +%Y-%m-%d).log"
  if [[ -f "$today_log" ]]; then
    tail -f "$today_log"
  else
    echo "[context-proxy] No log for today yet: $today_log"
    # Fallback: show latest log file
    local latest
    latest="$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)"
    [[ -n "$latest" ]] && echo "[context-proxy] Latest log: $latest" && tail -f "$latest"
  fi
}

# ── Daemon ──────────────────────────────────────────────────────────────

_daemon_is_running() {
  [[ -f "$DAEMON_PID_FILE" ]] && kill -0 "$(cat "$DAEMON_PID_FILE")" 2>/dev/null
}

_daemon_log() {
  echo "[daemon $(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$DAEMON_LOG"
}

# Core daemon loop: monitor the proxy process and restart it automatically on failure
_daemon_loop() {
  # Do not use set -e inside the daemon loop; each operation handles its own errors
  set +e

  local restart_count=0
  local window_start=0
  local consecutive_failures=0

  while true; do
    if ! _is_running; then
      _daemon_log "proxy process died, attempting restart..."

      # Backoff strategy: the more consecutive failures, the longer the wait
      local backoff=$(( DAEMON_BACKOFF_BASE ** consecutive_failures ))
      [[ $backoff -gt $DAEMON_BACKOFF_MAX ]] && backoff=$DAEMON_BACKOFF_MAX

      # Restart rate limiting
      local now
      now=$(date +%s)
      if (( window_start == 0 )) || (( now - window_start > DAEMON_RESTART_WINDOW )); then
        window_start=$now
        restart_count=0
      fi

      if (( restart_count >= DAEMON_MAX_RESTARTS )); then
        _daemon_log "FATAL: exceeded $DAEMON_MAX_RESTARTS restarts in ${DAEMON_RESTART_WINDOW}s window. Giving up."
        exit 1
      fi

      _daemon_log "backoff ${backoff}s (failure #$((consecutive_failures + 1)), restart #$((restart_count + 1))/${DAEMON_MAX_RESTARTS})"
      sleep "$backoff"

      if cmd_start; then
        _daemon_log "proxy restarted successfully"
        consecutive_failures=0
        restart_count=$((restart_count + 1))
      else
        _daemon_log "proxy restart failed"
        consecutive_failures=$((consecutive_failures + 1))
      fi
    else
      # Process alive: reset the consecutive failure count (but keep the in-window restart count)
      consecutive_failures=0
    fi

    sleep "$DAEMON_CHECK_INTERVAL"
  done
}

cmd_daemon() {
  if _daemon_is_running; then
    echo "[daemon] already running (pid=$(cat "$DAEMON_PID_FILE"))"
    return 0
  fi

  # Make sure the proxy is started first
  if ! _is_running; then
    echo "[daemon] proxy not running, starting first..."
    cmd_start || { echo "[daemon] failed to start proxy, aborting" >&2; return 1; }
  fi

  echo "[daemon] starting daemon process..."
  mkdir -p "$LOG_DIR"

  # Start the daemon loop in the background
  nohup "$SCRIPT_DIR/proxy.sh" _daemon_entry >> "$DAEMON_LOG" 2>&1 &

  echo $! > "$DAEMON_PID_FILE"
  echo "[daemon] started (pid=$(cat "$DAEMON_PID_FILE"))"
  echo "[daemon] check interval: ${DAEMON_CHECK_INTERVAL}s, max restarts: ${DAEMON_MAX_RESTARTS}/${DAEMON_RESTART_WINDOW}s"
  echo "[daemon] log: $DAEMON_LOG"
}

cmd_daemon_stop() {
  if _daemon_is_running; then
    local pid
    pid=$(cat "$DAEMON_PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$DAEMON_PID_FILE"
    echo "[daemon] stopped (pid=$pid)"
  else
    echo "[daemon] not running"
  fi
}

cmd_daemon_status() {
  if _daemon_is_running; then
    local pid
    pid=$(cat "$DAEMON_PID_FILE")
    echo "[daemon] running (pid=$pid)"
    if [[ -f "$DAEMON_LOG" ]]; then
      echo "[daemon] recent log:"
      tail -5 "$DAEMON_LOG"
    fi
  else
    echo "[daemon] not running"
  fi
}

case "${1:-daemon}" in
  start)          cmd_start          ;;
  stop)           cmd_stop           ;;
  restart)        cmd_restart        ;;
  status)         cmd_status         ;;
  log)            cmd_log            ;;
  daemon)         cmd_daemon         ;;
  daemon-stop)    cmd_daemon_stop    ;;
  daemon-status)  cmd_daemon_status  ;;
  _daemon_entry)  _daemon_loop       ;;  # internal entry, not exposed externally
  *)
    echo "Usage: $0 [start|stop|restart|status|log|daemon|daemon-stop|daemon-status]"
    exit 1
    ;;
esac
