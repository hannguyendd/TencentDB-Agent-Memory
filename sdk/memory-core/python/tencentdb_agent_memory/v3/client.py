"""TencentDB Agent Memory v3 Python SDK — strict-isolation data-plane client.

Differences from v2
-----------

- At construction ``team_id`` / ``agent_id`` / ``user_id`` **required**; a missing one raises ``ParamError``.
- ``session_id`` rules:
    - ``add_conversation`` **required for writes** (either at construction or per call); missing raises ``ValueError`` --
      this prevents the server from silently merging session-less writes into the default bucket and mixing data with other callers.
    - Read endpoints (query / search / count / delete) are optional: when given, results are scoped to the session;
      when missing, they aggregate across sessions by (team, agent, user) (full agent-level view semantics,
      used for the governance panel's layer-counts, cross-session L0/L1 lists, etc.).
    - L2/L3 are inherently team+agent-level profile aggregates and do not consume session_id.
- HTTP paths use ``/v3/...``; the server validates by the same rules (any missing team/agent/user yields 422).
- ``offload`` / ``read_file`` and other non-L0-L3 endpoints are not exposed in v3 -- keep using the v2 client.

>>> from tencentdb_agent_memory.v3 import MemoryClient
>>> # Typical usage: team+agent+user are fixed at construction; session follows the actual conversation
>>> client = MemoryClient(
...     endpoint="https://memory.tencentyun.com",
...     api_key="sk-...",
...     service_id="mem-...",
...     team_id="t1", agent_id="a1", user_id="u1",
...     session_id="s1",   # optional; when omitted, L0/L1 queries aggregate across sessions
... )
>>> client.add_conversation(messages=[{"role": "user", "content": "hi"}])
>>> client.read_scenario("notes/2026Q2.md")   # L2 does not read session_id
>>> # Fetch the total L0 conversation count of an agent across sessions
>>> client.with_isolation(session_id=None).query_conversation(limit=1)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .._http import Stub
from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError

logger = logging.getLogger(__name__)


_V3 = "/v3"
_UNSET = object()


def _strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _normalize_delete_ids(
    field: str,
    raw: Optional[List[str]],
    max_items: int,
) -> Optional[List[str]]:
    """Normalizes the id list for batch deletes: validates non-empty strings, deduplicates (order-preserving), and checks the limit.

    Input of destructive operations is checked on the client, which surfaces problems earlier than waiting for a server 400
    and avoids sending obviously invalid batch requests.

    :returns: the normalized list; returns None when ``raw`` is None (meaning "not provided").
    """
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        raise ParamError(f"{field} must be a list of non-empty strings")
    if any(not isinstance(item, str) or not item.strip() for item in raw):
        raise ParamError(f"{field} must contain only non-empty strings")

    seen: Dict[str, None] = {}
    for item in raw:
        seen.setdefault(item.strip(), None)
    deduped = list(seen.keys())

    if len(deduped) > max_items:
        raise ParamError(f"{field} accepts at most {max_items} items, got {len(deduped)}")
    return deduped


def _validate_construction(team_id: str, agent_id: str, user_id: str) -> None:
    """In v3, team+agent+user are required at construction; any missing one raises ParamError immediately instead of surfacing as a 422 later.

    session_id is not strictly validated at construction (L2/L3 endpoints do not need it); it is validated separately when L0/L1 methods are called.
    """
    missing = [
        name for name, val in (
            ("team_id", team_id),
            ("agent_id", agent_id),
            ("user_id", user_id),
        ) if not val
    ]
    if missing:
        raise ParamError(
            f"v3 MemoryClient requires non-empty {', '.join(missing)} at construction time"
        )


class _IsolationCtx:
    """Carrier for the v3 isolation context. Internal only; exposed via with_isolation()."""

    __slots__ = ("team_id", "agent_id", "user_id", "session_id", "task_id")

    def __init__(
        self,
        team_id: str,
        agent_id: str,
        user_id: str,
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> None:
        self.team_id = team_id
        self.agent_id = agent_id
        self.user_id = user_id
        self.session_id = session_id
        self.task_id = task_id

    def base_body(self) -> Dict[str, Any]:
        """team + agent + user (+ optional task); does not include session_id. Used by L2/L3 calls."""
        body: Dict[str, Any] = {
            "team_id": self.team_id,
            "agent_id": self.agent_id,
            "user_id": self.user_id,
        }
        if self.task_id:
            body["task_id"] = self.task_id
        return body

    def resolve_session(self, override: Optional[str]) -> Optional[str]:
        """L0/L1 calls: override > session_id from construction.

        On the v3 server session_id is optional: when given, results are scoped to the session; when missing, queries/counts
        aggregate across sessions by (team,agent,user) ("full agent-level view" semantics, used for the governance panel, etc.).
        This method returns the effective session_id, or None if missing -- callers should not put
        the session_id field into the request body when it is None.
        """
        return override or self.session_id

    def resolve_session_for_write(self, override: Optional[str]) -> str:
        """Write path only: ``add_conversation`` must get a non-empty session_id.

        Raises ``ValueError`` if missing -- this prevents the server from silently merging session-less writes into the default
        bucket, mixing them with other callers' data. Read paths (query/search/count/
        delete) still go through ``resolve_session`` and may omit it to aggregate across sessions.
        """
        sid = override or self.session_id
        if not sid:
            raise ValueError(
                "v3 MemoryClient.add_conversation requires session_id: "
                "pass it in the constructor or per call. "
                "Reads (query/search/count) may omit it to aggregate across sessions."
            )
        return sid


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------

class MemoryClient:
    """v3 sync client -- strict-isolation L0-L3 data plane (including count endpoints).

    Required at construction: ``team_id`` / ``agent_id`` / ``user_id``.
    Optional at construction: ``session_id`` (when omitted, all L0-L3 endpoints aggregate across sessions), ``task_id``,
    ``user_key`` (needed by asset-level endpoints such as ``clear_chat_memory``).
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        team_id: str = "",
        agent_id: str = "",
        user_id: str = "",
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
        user_key: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        _validate_construction(team_id, agent_id, user_id)
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            # user_key is optional: the kernel does no user-level auth, but an upstream gateway/panel may need
            # the caller identity; keep the same passthrough capability as MetadataClient.
            self._stub = HttpStub(
                endpoint, api_key, service_id,
                timeout=timeout, verify=verify, user_key=user_key,
            )
        self._iso = _IsolationCtx(team_id, agent_id, user_id, session_id, task_id)

    # -- isolation overrides ------------------------------------------------

    def with_isolation(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Any = _UNSET,
        task_id: Any = _UNSET,
    ) -> "MemoryClient":
        """Return a clone sharing the transport with selected isolation fields overridden.

        Pass ``session_id=None`` or ``task_id=None`` to explicitly clear a bound
        value. Omitting either argument keeps the current value.
        """
        new_team = team_id or self._iso.team_id
        new_agent = agent_id or self._iso.agent_id
        new_user = user_id or self._iso.user_id
        new_session = self._iso.session_id if session_id is _UNSET else session_id
        new_task = self._iso.task_id if task_id is _UNSET else task_id
        _validate_construction(new_team, new_agent, new_user)
        clone = object.__new__(MemoryClient)
        clone._stub = self._stub
        clone._iso = _IsolationCtx(new_team, new_agent, new_user, new_session, new_task)
        return clone

    # -- L0 Conversation ---------------------------------------------------
    # Writes must carry a session_id (otherwise the server silently puts them into the default bucket and mixes data);
    # for read endpoints session_id is optional; when missing they aggregate across sessions.

    def add_conversation(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/add`` — session_id is required for writes (either at construction or per call)."""
        return self._stub.post(
            f"{_V3}/conversation/add",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session_for_write(session_id),
                "messages": messages,
            }),
        )

    def query_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/query``"""
        return self._stub.post(
            f"{_V3}/conversation/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "limit": limit,
                "offset": offset,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def search_conversation(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/search``"""
        return self._stub.post(
            f"{_V3}/conversation/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query,
                "limit": limit,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_conversation(
        self,
        *,
        message_ids: Optional[List[str]] = None,
        session_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/delete`` — batch-delete L0.

        At least one of ``message_ids`` (<=5000) and ``session_ids`` (<=100) is required; both may be given.

        Note the scope: this does **not** fall back to the ``session_id`` from construction. Deletion is destructive;
        if the default session were attached automatically as in read endpoints, a caller who only wants to delete a few message_ids
        would accidentally delete the whole session. To delete sessions, pass ``session_ids`` explicitly.

        ``session_id`` (singular) is deprecated and kept only for compatibility with old callers; it is merged into
        ``session_ids``.
        """
        normalized_messages = _normalize_delete_ids("message_ids", message_ids, 5000)
        normalized_sessions = _normalize_delete_ids("session_ids", session_ids, 100)

        if session_id is not None:
            if not isinstance(session_id, str) or not session_id.strip():
                raise ParamError("session_id must be a non-empty string")
            merged = list(normalized_sessions or [])
            if session_id.strip() not in merged:
                merged.append(session_id.strip())
            normalized_sessions = merged

        if not normalized_messages and not normalized_sessions:
            raise ParamError(
                "delete_conversation requires message_ids or session_ids "
                "(the constructor session_id is intentionally NOT used for deletes)"
            )

        return self._stub.post(
            f"{_V3}/conversation/delete",
            _strip_none({
                **self._iso.base_body(),
                "message_ids": normalized_messages,
                "session_ids": normalized_sessions,
            }),
        )

    def count_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/count`` — same filters as query; returns only ``{total}``."""
        return self._stub.post(
            f"{_V3}/conversation/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L1 Atomic (session_id optional; when missing, aggregates across sessions) -----------------

    def update_atomic(
        self,
        id: str,
        content: str,
        *,
        background: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/update``"""
        return self._stub.post(
            f"{_V3}/atomic/update",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "id": id,
                "content": content,
                "background": background,
            }),
        )

    def query_atomic(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/query``"""
        return self._stub.post(
            f"{_V3}/atomic/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "limit": limit,
                "offset": offset,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def search_atomic(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/search``"""
        return self._stub.post(
            f"{_V3}/atomic/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query,
                "limit": limit,
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_atomic(
        self,
        ids: List[str],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/delete`` — ids are required, at most 5000 per call."""
        normalized = _normalize_delete_ids("ids", ids, 5000)
        if not normalized:
            raise ParamError("delete_atomic requires a non-empty ids list")
        return self._stub.post(
            f"{_V3}/atomic/delete",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "ids": normalized,
            }),
        )

    def count_atomic(
        self,
        *,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/count`` — same filters as query; returns only ``{total}``."""
        return self._stub.post(
            f"{_V3}/atomic/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L2 Scenario (team+agent level, no session_id needed) -------------------

    def list_scenarios(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        """``POST /v3/scenario/ls``"""
        return self._stub.post(
            f"{_V3}/scenario/ls",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    def read_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /v3/scenario/read``"""
        return self._stub.post(
            f"{_V3}/scenario/read",
            {**self._iso.base_body(), "path": path},
        )

    def write_scenario(
        self,
        path: str,
        content: str,
        *,
        summary: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/scenario/write``"""
        return self._stub.post(
            f"{_V3}/scenario/write",
            _strip_none({
                **self._iso.base_body(),
                "path": path,
                "content": content,
                "summary": summary,
            }),
        )

    def rm_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /v3/scenario/rm``"""
        return self._stub.post(
            f"{_V3}/scenario/rm",
            {**self._iso.base_body(), "path": path},
        )

    def count_scenario(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        """``POST /v3/scenario/count`` — same filters as ls; returns only ``{total}``."""
        return self._stub.post(
            f"{_V3}/scenario/count",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    # -- L3 Core (team+agent level, no session_id needed) -----------------------

    def read_core(self) -> Dict[str, Any]:
        """``POST /v3/core/read``"""
        return self._stub.post(f"{_V3}/core/read", self._iso.base_body())

    def write_core(self, content: str) -> Dict[str, Any]:
        """``POST /v3/core/write``"""
        return self._stub.post(
            f"{_V3}/core/write",
            {**self._iso.base_body(), "content": content},
        )

    def count_core(self) -> Dict[str, Any]:
        """``POST /v3/core/count`` — count core memory files."""
        return self._stub.post(f"{_V3}/core/count", self._iso.base_body())

    # -- Chat Memory (asset-level) -----------------------------------------

    def clear_chat_memory(self, memory_ids: List[str]) -> Dict[str, Any]:
        """``POST /v3/chat-memory/clear`` — clear all content of a chat memory while keeping the asset.

        Cleared: L0 / L1 / L2 / L3 + vectors + files.
        Kept: ``memory_id``, Team/Agent ownership, Agent bindings, ACL, Owner,
        name, visibility -- after clearing, the Agent keeps writing with the original ``memory_id``; no rebuild needed.

        Unlike the L0/L1 delete endpoints, this is an **asset-level** operation:

        * scope is determined by ``memory_ids`` itself; the isolation triple is not used
        * if any ``memory_id`` does not exist or is not a chat_memory, the **whole batch is rejected** and nothing is cleared
        * idempotent: calling again on an already-cleared memory still succeeds, with counts of 0

        Permissions: as with other delete endpoints, the kernel does no user-level auth. If you need an "Owner only" restriction,
        go through the panel backend ``/api/v1/chat-memory/clear`` (which validates the Owner).

        Failed items carry a ``retryable`` flag; True means the server already retried automatically without success,
        and retrying later will clean up the remaining content.

        :param memory_ids: asset ids to clear, 1-100 items (auto-deduplicated)
        """
        normalized = _normalize_delete_ids("memory_ids", memory_ids, 100)
        if not normalized:
            raise ParamError("clear_chat_memory requires a non-empty memory_ids list")
        # Note: no isolation triple is sent -- scope is determined by memory_ids.
        return self._stub.post(f"{_V3}/chat-memory/clear", {"memory_ids": normalized})

    # -- Lifecycle ---------------------------------------------------------

    def close(self) -> None:
        self._stub.close()

    def __enter__(self) -> "MemoryClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Asynchronous client
# ---------------------------------------------------------------------------

class AsyncMemoryClient:
    """v3 async client -- strict-isolation L0-L3 data plane (including count endpoints, async version).

    Same as the sync version: team+agent+user are required at construction; session_id is optional for all L0-L3
    (when missing, aggregates across sessions by (team,agent,user)).
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        team_id: str = "",
        agent_id: str = "",
        user_id: str = "",
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
        user_key: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        _validate_construction(team_id, agent_id, user_id)
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            # user_key is optional: the kernel does not validate it, but an upstream gateway/panel may need the caller identity.
            self._stub = AsyncHttpStub(
                endpoint, api_key, service_id,
                timeout=timeout, verify=verify, user_key=user_key,
            )
        self._iso = _IsolationCtx(team_id, agent_id, user_id, session_id, task_id)

    def with_isolation(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Any = _UNSET,
        task_id: Any = _UNSET,
    ) -> "AsyncMemoryClient":
        """Clone this client; pass ``None`` to clear a bound session/task."""
        new_team = team_id or self._iso.team_id
        new_agent = agent_id or self._iso.agent_id
        new_user = user_id or self._iso.user_id
        new_session = self._iso.session_id if session_id is _UNSET else session_id
        new_task = self._iso.task_id if task_id is _UNSET else task_id
        _validate_construction(new_team, new_agent, new_user)
        clone = object.__new__(AsyncMemoryClient)
        clone._stub = self._stub
        clone._iso = _IsolationCtx(new_team, new_agent, new_user, new_session, new_task)
        return clone

    # -- L0 Conversation ---------------------------------------------------
    # Writes must carry a session_id (otherwise the server silently puts them into the default bucket and mixes data);
    # for read endpoints session_id is optional; when missing they aggregate across sessions.

    async def add_conversation(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/add`` — session_id is required for writes (either at construction or per call)."""
        return await self._stub.post(
            f"{_V3}/conversation/add",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session_for_write(session_id),
                "messages": messages,
            }),
        )

    async def query_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "limit": limit, "offset": offset,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def search_conversation(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query, "limit": limit,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def delete_conversation(
        self,
        *,
        message_ids: Optional[List[str]] = None,
        session_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/delete``(async). Same semantics as the sync version."""
        normalized_messages = _normalize_delete_ids("message_ids", message_ids, 5000)
        normalized_sessions = _normalize_delete_ids("session_ids", session_ids, 100)

        if session_id is not None:
            if not isinstance(session_id, str) or not session_id.strip():
                raise ParamError("session_id must be a non-empty string")
            merged = list(normalized_sessions or [])
            if session_id.strip() not in merged:
                merged.append(session_id.strip())
            normalized_sessions = merged

        if not normalized_messages and not normalized_sessions:
            raise ParamError(
                "delete_conversation requires message_ids or session_ids "
                "(the constructor session_id is intentionally NOT used for deletes)"
            )

        return await self._stub.post(
            f"{_V3}/conversation/delete",
            _strip_none({
                **self._iso.base_body(),
                "message_ids": normalized_messages,
                "session_ids": normalized_sessions,
            }),
        )

    async def count_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L1 Atomic (session_id optional; when missing, aggregates across sessions) -----------------

    async def update_atomic(
        self,
        id: str,
        content: str,
        *,
        background: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/update",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "id": id, "content": content, "background": background,
            }),
        )

    async def query_atomic(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type, "limit": limit, "offset": offset,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def search_atomic(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query, "limit": limit, "type": type,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def delete_atomic(
        self,
        ids: List[str],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/delete``(async). ids are required, at most 5000 per call."""
        normalized = _normalize_delete_ids("ids", ids, 5000)
        if not normalized:
            raise ParamError("delete_atomic requires a non-empty ids list")
        return await self._stub.post(
            f"{_V3}/atomic/delete",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "ids": normalized,
            }),
        )

    async def count_atomic(
        self,
        *,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L2 Scenario (team+agent level, no session_id needed) -------------------

    async def list_scenarios(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/ls",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    async def read_scenario(self, path: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/read",
            {**self._iso.base_body(), "path": path},
        )

    async def write_scenario(
        self,
        path: str,
        content: str,
        *,
        summary: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/write",
            _strip_none({
                **self._iso.base_body(),
                "path": path, "content": content, "summary": summary,
            }),
        )

    async def rm_scenario(self, path: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/rm",
            {**self._iso.base_body(), "path": path},
        )

    async def count_scenario(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/count",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    # -- L3 Core (team+agent level, no session_id needed) -----------------------

    async def read_core(self) -> Dict[str, Any]:
        return await self._stub.post(f"{_V3}/core/read", self._iso.base_body())

    async def write_core(self, content: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/core/write",
            {**self._iso.base_body(), "content": content},
        )

    async def count_core(self) -> Dict[str, Any]:
        return await self._stub.post(f"{_V3}/core/count", self._iso.base_body())

    # -- Chat Memory (asset-level) -----------------------------------------

    async def clear_chat_memory(self, memory_ids: List[str]) -> Dict[str, Any]:
        """``POST /v3/chat-memory/clear``(async). Same semantics as the sync version."""
        normalized = _normalize_delete_ids("memory_ids", memory_ids, 100)
        if not normalized:
            raise ParamError("clear_chat_memory requires a non-empty memory_ids list")
        # Note: no isolation triple is sent -- scope is determined by memory_ids.
        return await self._stub.post(f"{_V3}/chat-memory/clear", {"memory_ids": normalized})

    async def close(self) -> None:
        await self._stub.close()

    async def __aenter__(self) -> "AsyncMemoryClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
