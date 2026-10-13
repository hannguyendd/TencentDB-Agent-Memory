#!/usr/bin/env python3
"""
Opik Trace → Memory Core Skill extraction import tool (Python version)

Design goals (more conservative and simpler than the TS version):
  - Download Opik data in batches + paginated rate limiting, to avoid overwhelming Opik
  - For traces with the same thread_id, keep only the one with the most messages (Opik cumulative-snapshot semantics)
  - Different sessions can run concurrently (--concurrency controls the cap)
  - Strictly serial within the same session; after one conversation (a user + assistant group) is loaded, sleep briefly
  - Every conversation/add carries the same session_id, loading one user + one assistant group at a time
  - force-archive as a backstop after loading
  - No checkpoint, no polling of skill/list -- keep it simple; look at the output yourself later

See README.md in the same directory for usage.
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional


# ──────────────────────────── HTTP utilities (no third-party dependencies) ────────────────────────────


class HttpError(Exception):
    def __init__(self, status: int, message: str, body: str = "") -> None:
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message
        self.body = body


def http_request(
    method: str,
    url: str,
    *,
    headers: Optional[dict[str, str]] = None,
    json_body: Any = None,
    timeout: float = 30.0,
    retries: int = 4,
) -> Any:
    """JSON HTTP client with exponential-backoff retry. stdlib only, good enough."""
    payload = None
    hdrs = dict(headers or {})
    if json_body is not None:
        payload = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    hdrs.setdefault("Accept", "application/json")

    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=payload, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if not raw:
                    return None
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    return raw.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace") if err.fp else ""
            # 4xx (except 429) is raised directly, no retry
            if err.code < 500 and err.code != 429:
                raise HttpError(err.code, err.reason or "http error", body)
            last_err = HttpError(err.code, err.reason or "http error", body)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:  # noqa: PERF203
            last_err = err
        # exponential backoff + jitter
        if attempt < retries:
            backoff = min(30.0, 0.5 * (2 ** attempt)) + random.random() * 0.5
            time.sleep(backoff)
    assert last_err is not None
    raise last_err


# ──────────────────────────── Opik ────────────────────────────


def normalize_opik_base(url: str, workspace_hint: Optional[str]) -> tuple[str, str]:
    """Normalize a UI address or API address to /api/v1/private, and also probe the workspace."""
    parsed = urllib.parse.urlparse(url)
    if parsed.username or parsed.password:
        raise ValueError("OPIK_URL must not contain credentials; use an environment variable")
    parts = [p for p in parsed.path.split("/") if p]
    workspace_from_ui = parts[0] if parts and parts[0] not in {"api", "v1"} else None

    if "api" in parts and parts[parts.index("api") + 1: parts.index("api") + 2] == ["v1"]:
        api_path = "/" + "/".join(parts[: parts.index("api") + 2]) + "/private"
    elif "v1" in parts:
        api_path = "/" + "/".join(parts[: parts.index("v1") + 1]) + "/private"
    else:
        api_path = "/api/v1/private"

    api_base = f"{parsed.scheme}://{parsed.netloc}{api_path}".rstrip("/")
    workspace = (workspace_hint or workspace_from_ui or "default").strip()
    return api_base, workspace


@dataclass
class OpikClient:
    api_base: str
    workspace: str
    api_key: Optional[str] = None
    auth_scheme: Optional[str] = None
    timeout: float = 30.0
    retries: int = 4
    page_size: int = 100
    # Minimum interval (seconds) between Opik requests, to protect Opik.
    request_gap_s: float = 0.5

    _last_request_at: float = 0.0
    _gap_lock: threading.Lock = field(default_factory=threading.Lock)

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json", "Comet-Workspace-Name": self.workspace}
        if self.api_key:
            h["Authorization"] = f"{self.auth_scheme} {self.api_key}".strip() if self.auth_scheme else self.api_key
        return h

    def _throttle(self) -> None:
        """Global minimum-interval rate limit: no matter how many threads call Opik, at least request_gap_s between two requests."""
        with self._gap_lock:
            now = time.monotonic()
            wait = self.request_gap_s - (now - self._last_request_at)
            if wait > 0:
                time.sleep(wait)
            self._last_request_at = time.monotonic()

    def _get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        self._throttle()
        url = f"{self.api_base}{path}?{urllib.parse.urlencode(params)}"
        data = http_request("GET", url, headers=self._headers(), timeout=self.timeout, retries=self.retries)
        if not isinstance(data, dict) or "content" not in data or "total" not in data:
            raise RuntimeError(f"Unexpected Opik response format: {url}")
        return data

    def list_projects(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        page_no = 1
        while True:
            page = self._get("/projects", {"page": str(page_no), "size": str(self.page_size)})
            out.extend(page["content"])
            if len(out) >= page["total"] or not page["content"]:
                break
            page_no += 1
        return out

    def iter_traces(
        self,
        project_id: str,
        *,
        max_traces: int = 0,
    ) -> Iterable[dict[str, Any]]:
        """Fetch traces page by page. Throttling between pages is backstopped by _throttle, so don't take Opik down."""
        seen = 0
        page_no = 1
        while True:
            page = self._get(
                "/traces",
                {
                    "page": str(page_no),
                    "size": str(self.page_size),
                    "project_id": project_id,
                    "truncate": "false",
                    "strip_attachments": "true",
                },
            )
            for trace in page["content"]:
                if not trace.get("id"):
                    continue
                yield trace
                seen += 1
                if max_traces and seen >= max_traces:
                    return
            if seen >= page["total"] or not page["content"]:
                return
            page_no += 1


# ──────────────────────────── Trace → Skill message conversion ────────────────────────────

MAX_MSG_CHARS = 32_000
FORBIDDEN_ID_CHAR = "|"  # Redis queue element separator


def truncate(text: str) -> str:
    text = text.strip()
    return text if len(text) <= MAX_MSG_CHARS else text[:MAX_MSG_CHARS] + "\n…[truncated]"


def stringify_primitive(v: Any) -> Optional[str]:
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float, bool)):
        return str(v)
    return None


def content_to_text(v: Any) -> Optional[str]:
    """Flatten string / OpenAI blocks / Anthropic blocks into text."""
    prim = stringify_primitive(v)
    if prim is not None:
        return prim
    if isinstance(v, list):
        parts: list[str] = []
        for item in v:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif isinstance(item.get("content"), str):
                    parts.append(item["content"])
                elif isinstance(item.get("text"), str):
                    parts.append(item["text"])
        joined = "\n".join(p for p in parts if p.strip())
        return joined or None
    if isinstance(v, dict):
        for key in ("content", "text", "responseContent", "answer", "response", "completion"):
            if key in v:
                t = content_to_text(v[key])
                if t and t.strip():
                    return t
        if isinstance(v.get("message"), dict):
            return content_to_text(v["message"])
        if isinstance(v.get("choices"), list):
            for choice in v["choices"]:
                if isinstance(choice, dict):
                    t = content_to_text(choice.get("message") or choice.get("text"))
                    if t and t.strip():
                        return t
    return None


def epoch_ms(v: Any) -> Optional[int]:
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        try:
            # Compatible with formats like "2024-01-02T03:04:05.678Z"
            return int(time.mktime(time.strptime(v.split(".")[0].rstrip("Z"), "%Y-%m-%dT%H:%M:%S")) * 1000)
        except ValueError:
            return None
    return None


def extract_tool_calls(raw: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    # OpenAI style
    for call in raw.get("tool_calls") or []:
        if not isinstance(call, dict):
            continue
        fn = call.get("function") if isinstance(call.get("function"), dict) else {}
        cid = stringify_primitive(call.get("id") or call.get("tool_call_id"))
        name = stringify_primitive(fn.get("name") or call.get("name"))
        args = fn.get("arguments") if fn else call.get("arguments") or call.get("input")
        if not cid:
            continue
        content = args if isinstance(args, str) else json.dumps(args if args is not None else {}, ensure_ascii=False)
        msg = {"role": "tool_call", "content": truncate(content), "tool_call_id": cid}
        if name:
            msg["tool_name"] = name
        out.append(msg)
    # Anthropic tool_use blocks
    content = raw.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            cid = stringify_primitive(block.get("id"))
            if not cid:
                continue
            msg = {
                "role": "tool_call",
                "content": truncate(json.dumps(block.get("input", {}), ensure_ascii=False)),
                "tool_call_id": cid,
            }
            name = stringify_primitive(block.get("name"))
            if name:
                msg["tool_name"] = name
            out.append(msg)
    return out


def extract_tool_results(raw: dict[str, Any], role: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if role in {"tool", "function", "tool_result"}:
        cid = stringify_primitive(raw.get("tool_call_id") or raw.get("id"))
        if cid:
            text = content_to_text(raw.get("content") or raw.get("text"))
            name = stringify_primitive(raw.get("name") or raw.get("tool_name"))
            msg = {"role": "tool_result", "content": truncate(text) if text is not None else "", "tool_call_id": cid}
            if name:
                msg["tool_name"] = name
            out.append(msg)
        return out
    content = raw.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            cid = stringify_primitive(block.get("tool_use_id") or block.get("tool_call_id"))
            if not cid:
                continue
            text = content_to_text(block.get("content") or block.get("text"))
            out.append({"role": "tool_result", "content": truncate(text) if text is not None else "", "tool_call_id": cid})
    return out


def normalize_message(raw_msg: Any, include_system: bool) -> list[dict[str, Any]]:
    if not isinstance(raw_msg, dict):
        return []
    raw = {**raw_msg, **raw_msg.get("message", {})} if isinstance(raw_msg.get("message"), dict) else raw_msg
    role = str(raw.get("role") or raw.get("type") or "").lower()
    ts = epoch_ms(raw.get("timestamp") or raw.get("created_at") or raw.get("createdAt"))

    def stamp(msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if ts is None:
            return msgs
        return [{**m, "timestamp": ts} for m in msgs]

    tool_results = extract_tool_results(raw, role)
    if tool_results:
        return stamp(tool_results)

    mapped: Optional[str] = None
    if role in {"user", "human"}:
        mapped = "user"
    elif role in {"assistant", "ai", "model", "bot"}:
        mapped = "assistant"
    elif role in {"system", "developer"}:
        mapped = "system" if include_system else None
    if not mapped:
        return []

    out: list[dict[str, Any]] = []
    text = content_to_text(raw.get("content") or raw.get("text"))
    if text and text.strip():
        out.append({"role": mapped, "content": truncate(text)})
    if mapped == "assistant":
        out.extend(extract_tool_calls(raw))
    return stamp(out)


def find_message_arrays(v: Any, depth: int = 0) -> list[list[Any]]:
    if depth > 5:
        return []
    if isinstance(v, list):
        looks_like_msgs = any(
            isinstance(x, dict) and ("role" in x or (isinstance(x.get("message"), dict) and "role" in x["message"]))
            for x in v
        )
        if looks_like_msgs:
            return [v]
        result = []
        for item in v:
            result.extend(find_message_arrays(item, depth + 1))
        return result
    if not isinstance(v, dict):
        return []
    preferred = []
    for k in ("messages", "conversation", "history"):
        if k in v:
            preferred.extend(find_message_arrays(v[k], depth + 1))
    if preferred:
        return preferred
    result = []
    for item in v.values():
        result.extend(find_message_arrays(item, depth + 1))
    return result


def best_message_array(v: Any, include_system: bool) -> list[dict[str, Any]]:
    candidates = []
    for arr in find_message_arrays(v):
        flat: list[dict[str, Any]] = []
        for m in arr:
            flat.extend(normalize_message(m, include_system))
        candidates.append(flat)
    if not candidates:
        return []
    candidates.sort(key=lambda x: len(x), reverse=True)
    return candidates[0]


def same_msg(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return a.get("role") == b.get("role") and a.get("content") == b.get("content") and a.get("tool_call_id") == b.get("tool_call_id")


def merge_messages(inp: list[dict[str, Any]], out: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove the overlap between the tail of input and the head of output."""
    max_overlap = min(len(inp), len(out))
    for k in range(max_overlap, 0, -1):
        start = len(inp) - k
        if all(same_msg(out[i], inp[start + i]) for i in range(k)):
            return inp + out[k:]
    return inp + out


def extract_messages(trace: dict[str, Any], include_system: bool = False) -> list[dict[str, Any]]:
    merged = merge_messages(
        best_message_array(trace.get("input"), include_system),
        best_message_array(trace.get("output"), include_system),
    )
    if merged:
        return merged
    # Fallback: treat input/output as plain text
    out: list[dict[str, Any]] = []
    prompt = content_to_text(trace.get("input"))
    answer = content_to_text(trace.get("output"))
    if prompt and prompt.strip():
        out.append({"role": "user", "content": truncate(prompt)})
    if answer and answer.strip():
        out.append({"role": "assistant", "content": truncate(answer)})
    return out


def drop_orphan_tool_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop orphan tool_results (whose paired tool_call is not in the sequence)."""
    call_ids = {m.get("tool_call_id") for m in messages if m.get("role") == "tool_call"}
    return [
        m for m in messages
        if not (m.get("role") == "tool_result" and m.get("tool_call_id") not in call_ids)
    ]


# ──────────────────────────── Session aggregation ────────────────────────────

SAFE_ID_RE = re.compile(r"[^A-Za-z0-9._-]")


def sanitize_id_segment(raw: str, fallback: str = "unknown") -> str:
    cleaned = SAFE_ID_RE.sub("-", raw.strip()) if raw else ""
    return cleaned or fallback


def stable_short_hash(text: str) -> str:
    import hashlib

    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]


def build_session_id(project_id: str, thread_key: str) -> str:
    proj = sanitize_id_segment(project_id[:8] if project_id else "opik", "opik")
    thread = sanitize_id_segment(thread_key, "notrhread")
    return f"opik-{proj}-{thread}-{stable_short_hash(thread_key)}"


@dataclass
class Session:
    session_id: str
    thread_key: str
    picked_trace_id: str
    trace_count: int
    messages: list[dict[str, Any]]


def collect_sessions(
    project_id: str,
    traces: Iterable[dict[str, Any]],
    include_system: bool,
) -> list[Session]:
    """
    traces with the same thread_id keep only the one with the most messages (Opik cumulative snapshot);
    traces without a thread_id each form their own session.
    """
    best: dict[str, dict[str, Any]] = {}
    for trace in traces:
        thread = (trace.get("thread_id") or "").strip() or trace["id"]
        msgs = extract_messages(trace, include_system)
        msgs = drop_orphan_tool_results(msgs)
        prev = best.get(thread)
        if prev is None or len(msgs) > len(prev["messages"]):
            best[thread] = {
                "trace_id": trace["id"],
                "messages": msgs,
                "count": (prev["count"] + 1) if prev else 1,
            }
        else:
            prev["count"] += 1

    out: list[Session] = []
    for thread, bucket in best.items():
        if not bucket["messages"]:
            continue
        out.append(
            Session(
                session_id=build_session_id(project_id, thread),
                thread_key=thread,
                picked_trace_id=bucket["trace_id"],
                trace_count=bucket["count"],
                messages=bucket["messages"],
            )
        )
    return out


# ──────────────────────────── Load into Memory Core ────────────────────────────


@dataclass
class MemoryCoreClient:
    base_url: str
    api_key: str
    service_id: str
    team_id: str
    agent_id: str
    user_id: str
    task_id: Optional[str] = None
    timeout: float = 30.0
    retries: int = 4

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "x-tdai-service-id": self.service_id,
        }

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        resp = http_request(
            "POST", url,
            headers=self._headers(),
            json_body=body,
            timeout=self.timeout,
            retries=self.retries,
        )
        if not isinstance(resp, dict) or resp.get("code") != 0:
            code = resp.get("code") if isinstance(resp, dict) else "?"
            msg = resp.get("message") if isinstance(resp, dict) else str(resp)
            rid = resp.get("request_id", "-") if isinstance(resp, dict) else "-"
            raise RuntimeError(f"{path} failed: code={code} message={msg} request_id={rid}")
        return resp.get("data") or {}

    def conversation_add(self, session_id: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
        body = {
            "session_id": session_id,
            "user_id": self.user_id,
            "team_id": self.team_id,
            "agent_id": self.agent_id,
            "messages": messages,
        }
        if self.task_id:
            body["task_id"] = self.task_id
        return self._post("/v3/skill/conversation/add", body)

    def force_archive(self, session_id: str) -> dict[str, Any]:
        return self._post("/v3/skill/conversation/force-archive", {
            "space_id": self.service_id,
            "session_id": session_id,
            "user_id": self.user_id,
            "team_id": self.team_id,
            "agent_id": self.agent_id,
        })


def group_into_turns(messages: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """
    Group by "one conversation turn": starting from each user message, include all following
    assistant / tool_call / tool_result / system, up to the next user.

    If a turn has no preceding user (e.g. the conversation starts with assistant), it still forms a group.
    """
    if not messages:
        return []
    groups: list[list[dict[str, Any]]] = []
    cur: list[dict[str, Any]] = []
    for msg in messages:
        if msg["role"] == "user" and cur:
            groups.append(cur)
            cur = [msg]
        else:
            cur.append(msg)
    if cur:
        groups.append(cur)
    return groups


def import_session(
    session: Session,
    core: MemoryCoreClient,
    *,
    turn_gap_s: float,
    force_archive: bool,
    dry_run: bool,
    logger,
) -> dict[str, Any]:
    turns = group_into_turns(session.messages)
    stats = {"turns": len(turns), "archived": 0, "force_archived": 0, "errors": 0}
    logger.info(f"[session start] {session.session_id} turns={len(turns)} messages={len(session.messages)} picked_trace={session.picked_trace_id}")

    for idx, turn in enumerate(turns, start=1):
        if dry_run:
            logger.info(f"[dry-run] {session.session_id} turn={idx}/{len(turns)} msgs={len(turn)}")
        else:
            try:
                result = core.conversation_add(session.session_id, turn)
                status = result.get("status")
                if status == "archived":
                    stats["archived"] += 1
                    tid = (result.get("archived") or {}).get("task_id", "-")
                    logger.info(f"[archived] {session.session_id} turn={idx}/{len(turns)} task={tid}")
                else:
                    logger.info(f"[ok] {session.session_id} turn={idx}/{len(turns)} status={status}")
            except Exception as err:  # noqa: BLE001
                stats["errors"] += 1
                logger.warning(f"[error] {session.session_id} turn={idx}/{len(turns)}: {err}")
        # Sleep between turns (no sleep needed after the last turn)
        if idx < len(turns) and turn_gap_s > 0:
            time.sleep(turn_gap_s)

    if force_archive and not dry_run:
        try:
            result = core.force_archive(session.session_id)
            if result.get("status") == "archived":
                stats["force_archived"] = 1
                logger.info(f"[force-archived] {session.session_id} task={result.get('task_id')}")
            else:
                logger.info(f"[force-archive skip] {session.session_id} status={result.get('status')}")
        except Exception as err:  # noqa: BLE001
            logger.warning(f"[force-archive error] {session.session_id}: {err}")
            stats["errors"] += 1

    logger.info(f"[session done] {session.session_id} {stats}")
    return stats


# ──────────────────────────── Main flow ────────────────────────────


class Logger:
    def __init__(self) -> None:
        self._lock = threading.Lock()

    def _emit(self, level: str, msg: str) -> None:
        with self._lock:
            print(f"[{time.strftime('%H:%M:%S')}] [{level}] {msg}", flush=True)

    def info(self, msg: str) -> None:
        self._emit("info", msg)

    def warning(self, msg: str) -> None:
        self._emit("warn", msg)


def require_id(v: Optional[str], name: str) -> str:
    if not v:
        raise SystemExit(f"Missing {name}")
    v = v.strip()
    if FORBIDDEN_ID_CHAR in v:
        raise SystemExit(f"{name} must not contain '|' (queue element separator)")
    return v


def resolve_project(projects: list[dict[str, Any]], selector: str) -> dict[str, Any]:
    """Supports exact id / exact name / id prefix / name prefix."""
    selector = selector.strip()
    # 1) exact id/name
    for p in projects:
        if p.get("id") == selector or p.get("name") == selector:
            return p
    # 2) id prefix (Opik ids are uuids; the first 8 characters are enough to locate)
    id_prefix = [p for p in projects if isinstance(p.get("id"), str) and p["id"].startswith(selector)]
    if len(id_prefix) == 1:
        return id_prefix[0]
    if len(id_prefix) > 1:
        raise SystemExit(f"--project '{selector}' matched {len(id_prefix)} project ids; give a longer prefix or use the exact id")
    # 3) name prefix
    name_prefix = [p for p in projects if isinstance(p.get("name"), str) and p["name"].startswith(selector)]
    if len(name_prefix) == 1:
        return name_prefix[0]
    if len(name_prefix) > 1:
        raise SystemExit(f"--project '{selector}' matched {len(name_prefix)} project names; give a longer prefix or use the exact name")
    raise SystemExit(f"--project '{selector}' matched no project; run --list-projects first to see the options")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    # ── list-projects ────────────────────────────────────────────
    lp = sub.add_parser("list-projects", help="List Opik projects only")
    lp.add_argument("--opik-url", required=True, help="Opik UI or API address")
    lp.add_argument("--workspace", default="default", help="Opik workspace (default: default)")
    lp.add_argument("--page-size", type=int, default=100)
    lp.add_argument("--opik-request-gap-ms", type=int, default=500)
    lp.add_argument("--timeout-ms", type=int, default=30000)
    lp.add_argument("--retries", type=int, default=4)

    # ── fetch: only pull Opik + aggregate + write local JSON ────────────────────
    f = sub.add_parser("fetch", help="Pull data from Opik and aggregate into local session files (does not write core)")
    f.add_argument("--opik-url", required=True, help="Opik UI or API address")
    f.add_argument("--workspace", default="default", help="Opik workspace (default: default)")
    f.add_argument("--project", required=True, help="Project name / id / prefix")
    f.add_argument("--out-dir", required=True, help="Output directory (one .json file per session)")
    f.add_argument("--max-traces", type=int, default=0)
    f.add_argument("--max-sessions", type=int, default=0)
    f.add_argument("--page-size", type=int, default=100)
    f.add_argument("--opik-request-gap-ms", type=int, default=500)
    f.add_argument("--include-system", action="store_true")
    f.add_argument("--timeout-ms", type=int, default=30000)
    f.add_argument("--retries", type=int, default=4)
    f.add_argument("--overwrite", action="store_true", help="Overwrite existing session files (skipped by default)")

    # ── import: read from the local JSON directory and load into core ─────────────────────
    im = sub.add_parser("import", help="Load the local sessions produced by fetch into Memory Core")
    im.add_argument("--in-dir", required=True, help="Directory generated by fetch")
    im.add_argument("--memory-url", required=True, help="Memory Core Gateway address")
    im.add_argument("--service-id", required=True, help="x-tdai-service-id / space_id")
    im.add_argument("--team-id", required=True)
    im.add_argument("--agent-id", required=True, help="⚠️ The prefix is agt-, not apt-")
    im.add_argument("--user-id", required=True)
    im.add_argument("--task-id", default=None, help="Optional audit tag")
    im.add_argument("--max-sessions", type=int, default=0)
    im.add_argument("--concurrency", type=int, default=2, help="Concurrency cap across different sessions (default 2)")
    im.add_argument("--turn-gap-ms", type=int, default=3000, help="Interval between turns within the same session (default 3000ms)")
    im.add_argument("--no-force-archive", dest="force_archive", action="store_false")
    im.set_defaults(force_archive=True)
    im.add_argument("--dry-run", action="store_true", help="Read but do not write core")
    im.add_argument("--state-file", default=None, help="Checkpoint file (default <in-dir>/.import-state.json)")
    im.add_argument("--no-resume", action="store_true", help="Ignore the checkpoint and reload")
    im.add_argument("--timeout-ms", type=int, default=30000)
    im.add_argument("--retries", type=int, default=4)

    return p.parse_args()


# ──────────────────────────── Local JSON storage ────────────────────────────

_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]")


def session_filename(session_id: str) -> str:
    """Turn a session_id into a safe filename."""
    return _FILENAME_RE.sub("-", session_id) + ".json"


def save_session(session: Session, project: dict[str, Any], out_dir: str, overwrite: bool) -> bool:
    """Write a single session file. Returns whether it actually wrote (False = already exists and not overwritten)."""
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, session_filename(session.session_id))
    if os.path.exists(path) and not overwrite:
        return False
    payload = {
        "version": 1,
        "project_id": project.get("id"),
        "project_name": project.get("name"),
        "session_id": session.session_id,
        "thread_key": session.thread_key,
        "picked_trace_id": session.picked_trace_id,
        "trace_count": session.trace_count,
        "message_count": len(session.messages),
        "messages": session.messages,
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return True


def load_session(path: str) -> Session:
    with open(path, encoding="utf-8") as fp:
        data = json.load(fp)
    return Session(
        session_id=data["session_id"],
        thread_key=data.get("thread_key", ""),
        picked_trace_id=data.get("picked_trace_id", ""),
        trace_count=data.get("trace_count", 1),
        messages=data.get("messages", []),
    )


def list_session_files(in_dir: str) -> list[str]:
    if not os.path.isdir(in_dir):
        raise SystemExit(f"--in-dir is not a directory: {in_dir}")
    return sorted(
        os.path.join(in_dir, name)
        for name in os.listdir(in_dir)
        if name.endswith(".json") and not name.startswith(".") and name != "manifest.json"
    )


# ──────────────────────────── Checkpoint ────────────────────────────


class ResumeState:
    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.done: dict[str, dict[str, Any]] = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fp:
                    data = json.load(fp)
                self.done = data.get("done", {}) if isinstance(data, dict) else {}
            except (json.JSONDecodeError, OSError):
                self.done = {}

    def is_done(self, session_id: str) -> bool:
        return session_id in self.done

    def mark(self, session_id: str, stats: dict[str, Any]) -> None:
        with self._lock:
            self.done[session_id] = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **stats}
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fp:
                json.dump({"version": 1, "done": self.done}, fp, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)


# ──────────────────────────── Subcommand implementations ────────────────────────────


def cmd_list_projects(args: argparse.Namespace, log: Logger) -> int:
    if not args.opik_url:
        raise SystemExit("Missing --opik-url or OPIK_URL")
    api_base, workspace = normalize_opik_base(args.opik_url, args.workspace)
    opik = OpikClient(
        api_base=api_base, workspace=workspace,
        api_key=os.environ.get("OPIK_API_KEY"),
        auth_scheme=os.environ.get("OPIK_AUTH_SCHEME"),
        timeout=args.timeout_ms / 1000, retries=args.retries,
        page_size=args.page_size,
        request_gap_s=args.opik_request_gap_ms / 1000,
    )
    log.info(f"opik={api_base} workspace={workspace}")
    projects = opik.list_projects()
    log.info(f"Found {len(projects)} projects in total")
    for p in projects:
        print(f"  {p.get('name', '?')}\t{p.get('id')}")
    return 0


def cmd_fetch(args: argparse.Namespace, log: Logger) -> int:
    if not args.opik_url:
        raise SystemExit("Missing --opik-url or OPIK_URL")
    api_base, workspace = normalize_opik_base(args.opik_url, args.workspace)
    opik = OpikClient(
        api_base=api_base, workspace=workspace,
        api_key=os.environ.get("OPIK_API_KEY"),
        auth_scheme=os.environ.get("OPIK_AUTH_SCHEME"),
        timeout=args.timeout_ms / 1000, retries=args.retries,
        page_size=args.page_size,
        request_gap_s=args.opik_request_gap_ms / 1000,
    )
    log.info(f"opik={api_base} workspace={workspace}")

    projects = opik.list_projects()
    project = resolve_project(projects, args.project)
    log.info(f"Target project name={project.get('name')} id={project.get('id')}")

    log.info(
        f"Starting to fetch traces (page_size={args.page_size} gap={args.opik_request_gap_ms}ms "
        f"max_traces={args.max_traces or 'unlimited'})"
    )
    # Two steps: first stream-fetch all traces (with progress), then aggregate locally → write files
    traces: list[dict[str, Any]] = []
    for i, trace in enumerate(opik.iter_traces(project["id"], max_traces=args.max_traces), start=1):
        traces.append(trace)
        if i % 200 == 0:
            log.info(f"[fetch] fetched traces={i}")
    log.info(f"[fetch] fetch complete traces={len(traces)}")

    sessions = collect_sessions(project["id"], iter(traces), args.include_system)
    log.info(f"[fetch] aggregated sessions={len(sessions)}")

    if args.max_sessions:
        sessions = sessions[: args.max_sessions]
        log.info(f"[fetch] truncated to {len(sessions)} per --max-sessions")

    os.makedirs(args.out_dir, exist_ok=True)
    manifest_path = os.path.join(args.out_dir, "manifest.json")
    manifest = {
        "version": 1,
        "project_id": project.get("id"),
        "project_name": project.get("name"),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "trace_count": len(traces),
        "session_count": len(sessions),
        "include_system": args.include_system,
    }
    with open(manifest_path, "w", encoding="utf-8") as fp:
        json.dump(manifest, fp, ensure_ascii=False, indent=2)

    written = skipped = 0
    total_msgs = total_turns = 0
    for s in sessions:
        did_write = save_session(s, project, args.out_dir, args.overwrite)
        if did_write:
            written += 1
        else:
            skipped += 1
        total_msgs += len(s.messages)
        total_turns += len(group_into_turns(s.messages))
    log.info(
        f"[fetch] wrote {written} session files (skipped {skipped} existing), "
        f"messages={total_msgs} turns={total_turns} → {args.out_dir}"
    )
    return 0


def cmd_import(args: argparse.Namespace, log: Logger) -> int:
    files = list_session_files(args.in_dir)
    if not files:
        raise SystemExit(f"No session .json files under {args.in_dir}")
    log.info(f"[import] found {len(files)} session files in {args.in_dir}")

    if args.max_sessions:
        files = files[: args.max_sessions]
        log.info(f"[import] truncated to {len(files)} per --max-sessions")

    core: Optional[MemoryCoreClient] = None
    if not args.dry_run:
        api_key = os.environ.get("MEMORY_CORE_API_KEY")
        if not api_key:
            raise SystemExit("Missing MEMORY_CORE_API_KEY")
        if not args.memory_url:
            raise SystemExit("Missing --memory-url or MEMORY_CORE_URL")
        core = MemoryCoreClient(
            base_url=args.memory_url.rstrip("/"),
            api_key=api_key,
            service_id=require_id(args.service_id, "--service-id"),
            team_id=require_id(args.team_id, "--team-id"),
            agent_id=require_id(args.agent_id, "--agent-id"),
            user_id=require_id(args.user_id, "--user-id"),
            task_id=(args.task_id or None),
            timeout=args.timeout_ms / 1000,
            retries=args.retries,
        )
        log.info(f"memory={core.base_url} team={core.team_id} agent={core.agent_id} user={core.user_id} space={core.service_id}")

    state_path = args.state_file or os.path.join(args.in_dir, ".import-state.json")
    state = ResumeState(state_path)
    if not args.no_resume and state.done:
        log.info(f"[import] checkpoint: {len(state.done)} sessions already done, will skip (disable with --no-resume)")

    # Pre-scan to compute scale (for ETA / progress)
    sessions_and_files: list[tuple[str, Session]] = []
    total_turns = 0
    for path in files:
        s = load_session(path)
        sessions_and_files.append((path, s))
        total_turns += len(group_into_turns(s.messages))

    already = sum(1 for _, s in sessions_and_files if not args.no_resume and state.is_done(s.session_id))
    todo_turns = 0
    for _, s in sessions_and_files:
        if not args.no_resume and state.is_done(s.session_id):
            continue
        todo_turns += len(group_into_turns(s.messages))

    log.info(
        f"[import] total sessions={len(sessions_and_files)} (done {already}, pending {len(sessions_and_files)-already}) "
        f"total turns={total_turns} pending turns={todo_turns}"
    )
    # Rough ETA: todo_turns × turn_gap / concurrency
    eta_s = (todo_turns * args.turn_gap_ms / 1000) / max(1, args.concurrency)
    log.info(
        f"[import] concurrency={args.concurrency} turn-gap={args.turn_gap_ms}ms → rough ETA ~{int(eta_s // 60)}m{int(eta_s % 60)}s "
        f"(HTTP time counted separately)"
    )

    # Progress counters
    counter_lock = threading.Lock()
    counters = {"done_sessions": 0, "done_turns": 0}
    total_todo_sessions = len(sessions_and_files) - already
    start_ts = time.time()

    def worker(path_and_session: tuple[str, Session]) -> dict[str, Any]:
        path, s = path_and_session
        if not args.no_resume and state.is_done(s.session_id):
            return {"turns": 0, "archived": 0, "force_archived": 0, "errors": 0, "skipped": True}
        stats = import_session(
            s,
            core,  # type: ignore[arg-type]
            turn_gap_s=args.turn_gap_ms / 1000,
            force_archive=args.force_archive,
            dry_run=args.dry_run,
            logger=log,
        )
        if not args.dry_run:
            state.mark(s.session_id, stats)
        with counter_lock:
            counters["done_sessions"] += 1
            counters["done_turns"] += stats.get("turns", 0)
            elapsed = time.time() - start_ts
            remaining = max(0, todo_turns - counters["done_turns"])
            if counters["done_turns"] > 0:
                rate = counters["done_turns"] / elapsed
                eta = remaining / rate if rate > 0 else 0
                log.info(
                    f"[progress] sessions {counters['done_sessions']}/{total_todo_sessions}  "
                    f"turns {counters['done_turns']}/{todo_turns}  "
                    f"elapsed {int(elapsed)}s  ETA ~{int(eta // 60)}m{int(eta % 60)}s"
                )
        return stats

    totals = {"turns": 0, "archived": 0, "force_archived": 0, "errors": 0, "sessions": 0, "skipped": 0}
    with futures.ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        for stats in pool.map(worker, sessions_and_files):
            totals["sessions"] += 1
            for k in ("turns", "archived", "force_archived", "errors"):
                totals[k] += stats.get(k, 0)
            if stats.get("skipped"):
                totals["skipped"] += 1

    log.info(
        f"[done] sessions={totals['sessions']} (skipped {totals['skipped']}) "
        f"turns={totals['turns']} archived={totals['archived']} "
        f"force_archived={totals['force_archived']} errors={totals['errors']}"
    )
    return 0


def main() -> int:
    args = parse_args()
    log = Logger()
    if args.cmd == "list-projects":
        return cmd_list_projects(args, log)
    if args.cmd == "fetch":
        return cmd_fetch(args, log)
    if args.cmd == "import":
        return cmd_import(args, log)
    raise SystemExit(f"Unknown subcommand: {args.cmd}")


if __name__ == "__main__":
    sys.exit(main())
