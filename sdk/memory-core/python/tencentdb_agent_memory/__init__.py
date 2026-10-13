"""TencentDB Agent Memory Python SDK.

Version layout (modeled on the tencentcloud-sdk-python per-version submodule style):

- The default exports `MemoryClient` / `AsyncMemoryClient` point to v2, so existing code keeps working unchanged after upgrading the SDK.
- Explicitly import `from tencentdb_agent_memory.v3 import MemoryClient` to switch to v3,
  the strict-isolation version (team/agent/user/session are all required at construction; paths use /v3).

>>> # Existing code
>>> from tencentdb_agent_memory import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...")
>>> client.add_conversation(session_id="s1", messages=[...])

>>> # New code (strict isolation)
>>> from tencentdb_agent_memory.v3 import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...",
...                       team_id="t1", agent_id="a1", user_id="u1")
>>> client.add_conversation(session_id="s1", messages=[...])
"""

from .errors import ParamError, TDAMError
from .v2 import AsyncMemoryClient, MemoryClient

__all__ = ["MemoryClient", "AsyncMemoryClient", "TDAMError", "ParamError"]
