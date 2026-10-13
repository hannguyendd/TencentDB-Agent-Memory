"""TencentDB Agent Memory v3 Python SDK — strict-isolation data-plane client.

The team_id / agent_id / user_id / session_id 4-tuple must be provided at construction;
paths use ``/v3/...``. See the ``v3.client.MemoryClient`` docstring.

The management-plane clients :class:`MetadataClient` / :class:`AsyncMetadataClient` do not need the isolation
4-tuple; they wrap the public ``/v3/meta/*`` endpoints (54, aligned with Panel ``META_ACTIONS``) and
``/v3/knowledge/*`` Knowledge CRUD. See ``v3.metadata_client``.

The Skill clients :class:`SkillClient` / :class:`AsyncSkillClient` wrap the 14
``/v3/skill/*`` endpoints -- the skill isolation fields are all optional at the server schema layer,
so pass defaults at construction as needed; when missing, the server returns business error codes (40001/40301/40302).
"""

from .client import AsyncMemoryClient, MemoryClient
from .metadata_client import AsyncMetadataClient, MetadataClient
from .memory_prompt import AsyncMemoryPromptClient, MemoryPromptClient
from .memory_generation_log import AsyncMemoryGenerationLogClient, MemoryGenerationLogClient
from .skill_client import (
    SKILL_ERROR_CODE,
    AsyncSkillClient,
    SkillClient,
    encode_base64,
    encode_utf8,
)

__all__ = [
    "MemoryClient",
    "AsyncMemoryClient",
    "MetadataClient",
    "AsyncMetadataClient",
    "MemoryPromptClient",
    "AsyncMemoryPromptClient",
    "MemoryGenerationLogClient",
    "AsyncMemoryGenerationLogClient",
    "SkillClient",
    "AsyncSkillClient",
    "SKILL_ERROR_CODE",
    "encode_utf8",
    "encode_base64",
]
