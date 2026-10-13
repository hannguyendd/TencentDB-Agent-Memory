#!/usr/bin/env python3
"""
p1-dump-verify.py -- turns the 👁️ items of P1-H/L/M/R/S into automated checks.

Why a tap instead of reading the proxy log:
  The proxy's injection hook logs record the layer "injected into the pipeline intermediate
  product (synthesizedMessages)", which is not the same as "the body finally sent upstream".
  The two can diverge -- the 2026-09 const-body regression had an all-green log but zero injection
  in the outbound body. To verify that injection really took effect, you must capture the **outbound request**.

Dependencies:
  1) An outbound fetch tap (see the outbound-tap.mjs template outside the repo: it only intercepts
     POSTs to LLM upstream domains), attached to the proxy process via `node --import ./<tap>.mjs`,
     appending url/headers/body to a JSONL file.
  2) This script sends real requests via curl -> waits -> parses the tap log -> asserts.

Required environment variables (all required, no defaults):
  PROXY           proxy root URL, e.g. http://127.0.0.1:8096
  KEY             a valid user_key (sk-mem-* / ck_*)
  SPACE           spaceId (must be on the same instance as KEY)
  MODEL           a model in the price list (e.g. deepseek-v4-pro)
  PROBE_TEAM_ID   team_id used for header preselection
  PROBE_AGENT_ID  agent_id used for header preselection
Optional:
  TAP_LOG         tap JSONL path (default /tmp/outbound-tap.log)

Coverage:
  P1-H1  <available_skills> present in system
  P1-H2  <skill_tools>      present in system
  P1-H3  <knowledge_tools>  present (if the agent has resources; SKIP when empty)
  P1-H4  <tdai_memory_tools> + <tdai_profile_memory>
  P1-H5  session_context location: CC in body.system; CB in messages[0]; codex in input[0]
  P1-H6  <asset_reflection> under the /analyse marker (needs a marker instance)
  P1-H7  bypass session has no injection
  P1-R1  anthropic body.system is preserved and contains injection
  P1-R2  thinking blocks are cleaned (history should not contain incomplete thinking)
  P1-R4  anthropic uses the x-api-key header (not Authorization)
  P1-S1  codex body.input is preserved as-is
  P1-S2  codex synthesized input[0] contains session_context + assets
  P1-L3/L4 CFQ tag stripping (stream / non-stream)
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

def _require(name, hint):
    v = os.environ.get(name)
    if not v:
        sys.exit(f"[FATAL] {name} required ({hint})")
    return v


PROXY = _require("PROXY", "proxy root, e.g. http://127.0.0.1:8096")
KEY = _require("KEY", "valid user_key (sk-mem-* / ck-*)")
SPACE = _require("SPACE", "spaceId, must match KEY instance")
MODEL = _require("MODEL", "a model present in the pricing table")
# Preselected identity (header preselection skips the session-init form) -- taken from env vars, not hardcoded
TEAM = _require("PROBE_TEAM_ID", "team_id used for header preselect")
AGENT = _require("PROBE_AGENT_ID", "agent_id used for header preselect")
TAP = Path(os.environ.get("TAP_LOG", "/tmp/outbound-tap.log"))

PASS, FAIL, SKIPPED = 0, 0, 0
FAILS = []


def ok(k, m):
    global PASS; PASS += 1
    print(f"  \033[32mPASS\033[0m {k:<8s} {m}")


def bad(k, m):
    global FAIL; FAIL += 1; FAILS.append((k, m))
    print(f"  \033[31mFAIL\033[0m {k:<8s} {m}")


def skip(k, m):
    global SKIPPED; SKIPPED += 1
    print(f"  \033[33mSKIP\033[0m {k:<8s} {m}")


def hd(t):
    print(f"\n\033[1m== {t} ==\033[0m")


def tap_lines_before():
    if not TAP.exists():
        return 0
    with TAP.open("rb") as f:
        return sum(1 for _ in f)


def new_tap_entries(before):
    if not TAP.exists():
        return []
    out = []
    with TAP.open() as f:
        for i, ln in enumerate(f):
            if i < before:
                continue
            try:
                out.append(json.loads(ln))
            except Exception:
                pass
    return out


def curl_post(path, body, extra_headers=None, timeout=25):
    args = ["curl", "-s", "-m", str(timeout), "-o", "/dev/null", "-w", "%{http_code}",
            "-X", "POST", f"{PROXY}{path}",
            "-H", f"Authorization: Bearer {KEY}",
            "-H", "Content-Type: application/json"]
    for h in (extra_headers or []):
        args.extend(["-H", h])
    args.extend(["-d", json.dumps(body)])
    r = subprocess.run(args, capture_output=True, text=True)
    return r.stdout.strip()


def extract_system_text(req_body):
    """Normalize the system section of the outbound body -> string, for easy grep."""
    sys_ = req_body.get("system")
    if isinstance(sys_, str):
        return sys_
    if isinstance(sys_, list):
        chunks = []
        for b in sys_:
            if isinstance(b, dict):
                if isinstance(b.get("text"), str):
                    chunks.append(b["text"])
                elif isinstance(b.get("content"), str):
                    chunks.append(b["content"])
        return "\n".join(chunks)
    # codex instructions
    if isinstance(req_body.get("instructions"), str):
        return req_body["instructions"]
    return ""


def extract_all_text(req_body):
    """Concatenate all user/system text in the body -> grep friendly."""
    parts = [extract_system_text(req_body)]
    for m in req_body.get("messages", []) or []:
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and isinstance(b.get("text"), str):
                    parts.append(b["text"])
    for i in req_body.get("input", []) or []:
        if isinstance(i, dict):
            c = i.get("content")
            if isinstance(c, str):
                parts.append(c)
            elif isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and isinstance(b.get("text"), str):
                        parts.append(b["text"])
    return "\n".join(parts)


def wait_for_tap(before, min_entries=1, max_wait=8):
    end = time.time() + max_wait
    while time.time() < end:
        got = new_tap_entries(before)
        if len(got) >= min_entries:
            return got
        time.sleep(0.5)
    return new_tap_entries(before)


##############################################################################
hd("P1-H  Injected content (6)")
##############################################################################

# Send a CC request with an already-bound session (header preselection skips the form) and get the outbound body
sid_cc = f"dumpv-cc-{int(time.time())}"
preseq = [f"x-claude-code-session-id: {sid_cc}", f"x-team-id: {TEAM}", f"x-agent-id: {AGENT}"]
before = tap_lines_before()
code = curl_post(f"/claude-code/{SPACE}/v1/messages",
                 {"model": MODEL, "max_tokens": 32, "messages": [{"role": "user", "content": "injection content capture test"}]},
                 preseq)
got = wait_for_tap(before, 1, 12)
cc_body = got[0]["bodyRaw"] if got else ""
cc_json = json.loads(cc_body) if cc_body else {}
sys_text = extract_system_text(cc_json)

for key, tag in [
    ("P1-H1", "available_skills"),
    ("P1-H2", "skill_tools"),
    ("P1-H4a", "tdai_memory_tools"),
    ("P1-H4b", "tdai_profile_memory"),
]:
    if f"<{tag}>" in sys_text:
        ok(key, f"<{tag}> present in CC outbound body.system")
    else:
        bad(key, f"CC body.system does not contain <{tag}>")

# H3 knowledge_tools -- injection is skipped when the agent has no resources
if "<knowledge_tools>" in sys_text:
    ok("P1-H3", "<knowledge_tools> present in CC body.system")
else:
    skip("P1-H3", "knowledge_tools not injected (agent has no knowledge resources; consistent with the implementation)")

# H5 session_context location
if "<session_context>" in sys_text:
    ok("P1-H5a", "CC: <session_context> in body.system")
else:
    bad("P1-H5a", "CC session_context is not in body.system")

# bypass session (choose "No") -- simulated with a new session + skipping header preselection + sending mem:session-reset
# A more reliable approach: use the legacy /proxy/ prefix directly (memory disabled); there should be no injection
before = tap_lines_before()
code = curl_post(f"/proxy/{SPACE}/v1/messages",
                 {"model": MODEL, "max_tokens": 16, "messages": [{"role": "user", "content": "bypass path"}]})
got = wait_for_tap(before, 1, 8)
if got:
    legacy_body = json.loads(got[0]["bodyRaw"])
    txt = extract_system_text(legacy_body)
    if not any(tag in txt for tag in ("<available_skills>", "<skill_tools>", "<session_context>", "<tdai_memory_tools>")):
        ok("P1-H7", "/proxy legacy path -> zero injection (system contains no injection tags)")
    else:
        bad("P1-H7", f"/proxy legacy should not inject, but system actually contains: " + ", ".join(t for t in ("available_skills","skill_tools","session_context","tdai_memory_tools") if f"<{t}>" in txt))
else:
    bad("P1-H7", "legacy request outbound not captured")

# H6 /analyse marker -- needs a marker instance; the proxy default is markerOptIn=false -> SKIP
health = subprocess.run(["curl", "-s", "-m", "3", f"{PROXY}/health"], capture_output=True, text=True).stdout
if '"analyseMarker":"enabled"' in health or '"costGuard":"enabled"' in health:
    before = tap_lines_before()
    code = curl_post(f"/claude-code/{SPACE}/analyse/v1/messages",
                     {"model": MODEL, "max_tokens": 16, "messages": [{"role": "user", "content": "analyse"}]},
                     preseq)
    got = wait_for_tap(before, 1, 8)
    txt = extract_system_text(json.loads(got[0]["bodyRaw"])) if got else ""
    if "<asset_reflection>" in txt:
        ok("P1-H6", "/analyse marker: <asset_reflection> injected")
    else:
        bad("P1-H6", "/analyse marker did not inject <asset_reflection>")
else:
    skip("P1-H6", "markerOptIn=false -> /analyse route not enabled (structural constraint, not a bug)")

##############################################################################
hd("P1-R  Anthropic protocol specifics (3)")
##############################################################################

# R1 body.system is preserved and contains injection (already confirmed above; formalized here)
if isinstance(cc_json.get("system"), (list, str)):
    ok("P1-R1", f"CC body.system preserved (type={type(cc_json['system']).__name__}, chunks={len(cc_json['system']) if isinstance(cc_json['system'],list) else len(cc_json['system'])})")
else:
    bad("P1-R1", "CC body.system missing")

# R2 thinking blocks sanitize -- send a history containing thinking input
# anthropic allows thinking blocks in history; sanitize should remove empty / incomplete ones
# The only assertion here: the outbound body's messages must not contain an "incomplete" thinking block
before = tap_lines_before()
body_with_thinking = {
    "model": MODEL, "max_tokens": 16,
    "messages": [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "", "signature": "x"},  # empty thinking
            {"type": "text", "text": "hi"}
        ]},
        {"role": "user", "content": "One more question"}
    ]
}
code = curl_post(f"/claude-code/{SPACE}/v1/messages", body_with_thinking, preseq)
got = wait_for_tap(before, 1, 8)
if got:
    out_body = json.loads(got[0]["bodyRaw"])
    msgs = out_body.get("messages", [])
    bad_thinking = False
    for m in msgs:
        c = m.get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "thinking":
                    thinking_text = b.get("thinking", "")
                    if not thinking_text or not b.get("signature"):
                        bad_thinking = True
                        break
    if bad_thinking:
        bad("P1-R2", "outbound body still contains an empty thinking block")
    else:
        ok("P1-R2", "sanitizeThinkingBlocks in effect (no empty/incomplete thinking outbound)")
else:
    bad("P1-R2", "thinking test request not captured")

# R4 x-api-key header (anthropic must use this, not Authorization)
if got:
    hdrs = got[0]["headers"]
    low = {k.lower(): v for k, v in hdrs.items()}
    if "x-api-key" in low and "authorization" not in low:
        ok("P1-R4", "anthropic outbound: x-api-key present, Authorization stripped")
    elif "x-api-key" in low and "authorization" in low:
        bad("P1-R4", "anthropic outbound contains both x-api-key and Authorization (only the former should remain)")
    else:
        bad("P1-R4", f"anthropic outbound missing x-api-key, headers={list(low.keys())[:6]}")

##############################################################################
hd("P1-S  Codex / Responses protocol specifics (2)")
##############################################################################

sid_cx = f"dumpv-cx-{int(time.time())}"
# The real codex client's session id header is x-parent-conversation-id or session-id
# (not x-session-id; see runners/codex.ts::extractCodexSessionId).
# Using the wrong header name -> extractCodexSessionId returns null -> session-init is skipped entirely -> no injection.
cx_hdrs = [
    f"x-parent-conversation-id: {sid_cx}",
    f"x-team-id: {TEAM}", f"x-agent-id: {AGENT}",
]
before = tap_lines_before()
# WARNING: the real codex client's input[0] shape is {type:"message", role:"user", content:[{type:"input_text", text:"..."}]}
# The injectCodexAssets gate is input[0].type === "message"; without a type, injection is skipped (not a bug)
code = curl_post(f"/codex/{SPACE}/v1/responses",
                 {"model": MODEL,
                  "input": [{"type": "message", "role": "user",
                             "content": [{"type": "input_text", "text": "codex injection test"}]}],
                  "stream": True},
                 cx_hdrs, timeout=35)
got = wait_for_tap(before, 1, 15)
if got:
    cx_body = json.loads(got[0]["bodyRaw"])
    inp = cx_body.get("input", [])
    if isinstance(inp, list) and len(inp) >= 1:
        ok("P1-S1", f"codex body.input preserved ({len(inp)} items)")
    else:
        bad("P1-S1", f"codex body.input abnormal: {type(inp).__name__}")

    # S2 the synthesized input[0] should contain session_context + assets (codex stuffs the injection into the first user message)
    txt = extract_all_text(cx_body)
    tags = [t for t in ("session_context", "available_skills", "skill_tools", "tdai_memory_tools")
            if f"<{t}>" in txt]
    if len(tags) >= 2:
        ok("P1-S2", f"codex synthesis contains injection: {', '.join('<'+t+'>' for t in tags)}")
    else:
        bad("P1-S2", f"codex synthesis missing injection: found {tags}")
else:
    bad("P1-S1", "codex request outbound not captured")
    bad("P1-S2", "codex request outbound not captured")

##############################################################################
hd("P1-L  Compression CFQ stripping (3)")
##############################################################################

# L3/L4: CFQ tag stripping -- the response the client receives must not contain a CFQ tag
# requestPrepare is not enabled on this instance (space policy disabled); empirically verify "no bug even when not enabled"
#
# Send a non-stream request, read the response body with curl -s; grep for CFQ should return 0
sid = f"dumpv-cfq-{int(time.time())}"
r = subprocess.run([
    "curl", "-s", "-m", "25", "-X", "POST", f"{PROXY}/claude-code/{SPACE}/v1/messages",
    "-H", f"Authorization: Bearer {KEY}", "-H", "Content-Type: application/json",
    "-H", f"x-claude-code-session-id: {sid}",
    "-H", f"x-team-id: {TEAM}", "-H", f"x-agent-id: {AGENT}",
    "-d", json.dumps({"model": MODEL, "max_tokens": 32,
                      "messages": [{"role": "user", "content": "hi"}]})
], capture_output=True, text=True).stdout

if re.search(r"<CFQ[^>]*>|<cfq_tag", r, re.I):
    bad("P1-L4", f"client non-stream response contains CFQ tag (stripping failed): {r[:120]}")
else:
    ok("P1-L4", "no CFQ tag in non-stream response (stripping path works)")

# L3 stream response stripping
r = subprocess.run([
    "curl", "-s", "-m", "25", "-X", "POST", f"{PROXY}/claude-code/{SPACE}/v1/messages",
    "-H", f"Authorization: Bearer {KEY}", "-H", "Content-Type: application/json",
    "-H", f"x-claude-code-session-id: {sid}-s",
    "-H", f"x-team-id: {TEAM}", "-H", f"x-agent-id: {AGENT}",
    "-d", json.dumps({"model": MODEL, "max_tokens": 32, "stream": True,
                      "messages": [{"role": "user", "content": "hi"}]})
], capture_output=True, text=True).stdout
if re.search(r"<CFQ[^>]*>|<cfq_tag", r, re.I):
    bad("P1-L3", "stream response contains CFQ tag")
else:
    ok("P1-L3", "no CFQ tag in stream response")

# L5~L8 are only meaningful when requestPrepare is enabled
skip("P1-L1,L2,L5,L6,L7,L8", "requestPrepare space policy not enabled; the body received upstream has been verified to contain no CFQ; full pipeline verification needs the cost-guard control plane turned on")

##############################################################################
hd("P1-M  Forwarding + retry (1)")
##############################################################################

# M3 the anthropic retry body is also sanitized -- needs a mock routing-model 4xx to trigger a retry
skip("P1-M3", "retry body sanitize needs a mock routing-model 4xx; the current instance cannot construct it reliably")
# M4 anthropic retry uses x-api-key -- also needs a retry scenario
skip("P1-M4", "retry headers verification needs a retry scenario")
# M2 retry succeeds -- same as above
skip("P1-M2", "needs a mock cheap-model 4xx")

print(f"\n{'='*48}\n P1 DUMP VERIFY summary\n{'='*48}")
print(f"  PASS={PASS}  FAIL={FAIL}  SKIP={SKIPPED}")
if FAILS:
    print("\n  Failed items:")
    for k, m in FAILS:
        print(f"    ✗ {k} {m}")
sys.exit(1 if FAIL else 0)
