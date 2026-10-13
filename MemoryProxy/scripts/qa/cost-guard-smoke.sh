#!/usr/bin/env bash
# cost-guard-smoke.sh —— P1-K: lock in all cost-guard modes (self-contained)
#
# See docs/design/2026-09-22-refactor-verification-prioritized.md §P1-K
# Coverage:
#   K1  mode=full      route + compress (analyzer really runs -> route+confidence)
#   K2  mode=pre       compress only, no routing (compress_only_mode passthrough)
#   K3  mode=cheap     route only, no compression (cheap-forced, skipPrepare)
#   K4  markerOptIn=false default behavior (covered by p1-api-test.sh)
#   K5  retry -> routedFrom cleared (semi-automatic, needs a mock routing model returning 4xx)
#   K6  analyzerTrace report (every request with tools produces cost_guard.analyzed)
#
# Starts its own proxy instance with markerOptIn=true + costGuard.enabled=true,
# sends real requests -> reads proxy stdout to decide, and cleans up automatically on exit.
#
# Required environment variables (all required, no defaults, to avoid hardcoding test-environment addresses/credentials in the repo):
#   MPROJ     MemoryProxy local repo root directory
#   BASECFG   path to the proxy's base config.yaml (the script copies variants via sed, the original is untouched)
#   KEY       valid user_key (sk-mem-* / ck_*)
#   SPACE     spaceId (must be on the same instance as KEY)
#   MODEL     a model in the price list (e.g. deepseek-v4-pro)
# Optional:
#   DRIVE     directory containing mock-core.mjs (default /tmp/tui-drive)
#   CGPORT    proxy port this script starts (default 18196)

set -uo pipefail

MPROJ="${MPROJ:?MPROJ required, e.g. /path/to/tdai-memory-openclaw-plugin/MemoryProxy}"
BASECFG="${BASECFG:?BASECFG required, path to the proxy base config.yaml}"
KEY="${KEY:?KEY required (sk-mem-* / ck_* user_key)}"
SPACE="${SPACE:?SPACE required (spaceId, must match KEY instance)}"
MODEL="${MODEL:?MODEL required (e.g. deepseek-v4-pro)}"
DRIVE="${DRIVE:-/tmp/tui-drive}"

CGPORT="${CGPORT:-18196}"
CGCFG=$DRIVE/cost-guard-smoke.yaml
CGLOG=/tmp/proxy-cg-smoke.log

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
skip(){ printf '  \033[33mSKIP\033[0m %-8s %s\n' "$1" "$2"; }

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

# 1) Start a proxy with cost-guard enabled + markerOptIn=true + log.level=debug
sed -e "s|^  port: 8096|  port: $CGPORT|" \
    -e 's|^  level: info.*|  level: debug|' \
    -e 's|^  enabled: false        # Whether to enable cost guard|  enabled: true        # Whether to enable cost guard|' \
    -e 's|^  markerOptIn: false|  markerOptIn: true|' \
    "$BASECFG" > "$CGCFG"

mkdir -p "$DRIVE"
(cd "$MPROJ" && node --import tsx/esm src/index.ts --config "$CGCFG") > "$CGLOG" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 30); do
  curl -sf -m 2 "http://127.0.0.1:$CGPORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -sf -m 3 "http://127.0.0.1:$CGPORT/health" >/dev/null 2>&1; then
    echo "[FATAL] proxy on $CGPORT not ready"
  tail -20 "$CGLOG"
  exit 2
fi
# health should show costGuard=enabled
if ! curl -s -m 5 "http://127.0.0.1:$CGPORT/health" | grep -q '"costGuard":"enabled"'; then
    echo "[FATAL] proxy started but costGuard is not enabled"
  exit 2
fi

printf '\n\033[1m== P1-K cost-guard mode lock-in ==\033[0m\n'

# ── helper ──
log_lines() { wc -l < "$CGLOG" 2>/dev/null || echo 0; }
# Send a "complex request" with tools to trigger the analyzer to really run
cg_req() {
  local marker="$1" path_suffix="${2:-v1/messages}"
  curl -s -m 40 -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:$CGPORT/claude-code/$SPACE/$marker/$path_suffix" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
        -d "{\"model\":\"$MODEL\",\"max_tokens\":64,\"tools\":[{\"name\":\"Read\",\"description\":\"read a file\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}}],\"messages\":[{\"role\":\"user\",\"content\":\"Please read /etc/passwd and refactor the entire module; this is a complex multi-step task\"}]}"
}

# ── K1: full ─────────────────────────────────────────────────────────────────
B=$(log_lines)
C=$(cg_req "cost-guard")
sleep 2
D=$(tail -n +$((B+1)) "$CGLOG")
analyzed=$(printf '%s' "$D" | grep -oE 'cost_guard\.analyzed [^}]+}' | head -1)
if [[ "$C" == "200" ]] && [[ -n "$analyzed" ]]; then
  ok "P1-K1" "mode=full → http=$C | $(printf '%s' "$analyzed" | head -c 120)"
else
    bad "P1-K1" "expected 200+analyzed, got http=$C analyzed=$analyzed"
fi

# ── K2: pre (compress-only) ──────────────────────────────────────────────────
B=$(log_lines)
C=$(cg_req "cost-guard/pre")
sleep 2
D=$(tail -n +$((B+1)) "$CGLOG")
pt=$(printf '%s' "$D" | grep -oE 'guard_adapter\.passthrough [^}]+}' | head -1)
if [[ "$C" == "200" ]] && printf '%s' "$pt" | grep -q "compress_only_mode"; then
  ok "P1-K2" "mode=pre → compress_only_mode passthrough (http=$C)"
else
    bad "P1-K2" "expected compress_only_mode, got http=$C passthrough=$pt"
fi

# ── K3: cheap (route-only, skip prepare) ─────────────────────────────────────
B=$(log_lines)
C=$(cg_req "cost-guard/cheap")
sleep 2
D=$(tail -n +$((B+1)) "$CGLOG")
# cheap mode: cost-guard forces the cheap model (log has analyzed route=cheap, or forced)
analyzed=$(printf '%s' "$D" | grep -oE 'cost_guard\.analyzed [^}]+}' | head -1)
forced=$(printf '%s' "$D" | grep -ic "cheap\|forced")
if [[ "$C" == "200" ]] && [[ -n "$analyzed" || "$forced" -gt 0 ]]; then
  ok "P1-K3" "mode=cheap → http=$C | analyzed=${analyzed:-'(no analyzer)'} forced_hits=$forced"
else
    bad "P1-K3" "expected the cheap branch to take effect, got http=$C"
fi

# ── K6: analyzer trace report ────────────────────────────────────────────────
# The K1 request should already have produced an analyzer trace to opik/langfuse; confirm from the log here
# the analyzer emits a cost_guard.analyzed log (already verified in K1), plus an optional
# analyzer_usage event written to ClickHouse.
if grep -q "cost_guard\.analyzed" "$CGLOG"; then
  cnt=$(grep -c "cost_guard\.analyzed" "$CGLOG")
    ok "P1-K6" "analyzer trace: $cnt cost_guard.analyzed reports sent"
else
    bad "P1-K6" "no cost_guard.analyzed seen"
fi

# ── K5: retry → routedFrom cleared ──────────────────────────────────────────
# To construct "route to cheap -> cheap returns 4xx -> retry to target succeeds -> writeLog routedFrom="""
# this requires the cheap model to fail; in the current instance cheap=deepseek-v4-pro is the same as the target
# and will not 4xx, so it cannot be triggered reliably. Recorded as skip with the reproduction path.
skip "P1-K5" "need to construct a cheap->4xx->retry scenario: point costGuard.cheapModel at a model that returns 4xx (e.g. no-such-model); the current instance has cheap=$MODEL which does not 4xx"

# ── K7: anthropic independent upstream (duplicates p1-api-test; confirm it also holds in marker mode) ─
B=$(log_lines)
curl -s -m 25 -o /dev/null -X POST "http://127.0.0.1:$CGPORT/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" >/dev/null
sleep 2
D=$(tail -n +$((B+1)) "$CGLOG")
fwd=$(printf '%s' "$D" | grep -oE "FORWARD upstream=\S+" | head -1)
if [[ -n "$fwd" ]]; then
    ok "P1-K7" "CC forwarding on the marker instance: $fwd"
else
    bad "P1-K7" "forward target not captured"
fi

printf '\n  PASS=%d FAIL=%d (K5 needs manual)\n\n' "$PASS" "$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
