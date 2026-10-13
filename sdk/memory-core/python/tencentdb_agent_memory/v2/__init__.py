"""TencentDB Agent Memory v2 Python SDK (existing data-plane + management-plane APIs, paths use /v2).

Explicit v2 entry point; the top-level `from tencentdb_agent_memory import MemoryClient` still points here,
so existing code keeps working unchanged after upgrading the SDK.
"""

from .client import AsyncMemoryClient, MemoryClient

__all__ = ["MemoryClient", "AsyncMemoryClient"]
