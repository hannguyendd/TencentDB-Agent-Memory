# Agent Integration Guide (Python)

This guide explains how to wire `tencentdb-agent-memory-sdk-python` into an AI Agent. For a quick reference of the SDK's 14 APIs see [`README.md`](./README.md); this guide covers **how to assemble them into a long-term memory system**.

---

## Four things to do when integrating

```
User input  →  ① Recall (inject into prompt) → LLM → ② Capture (write L0)
                            ↑
                  ③ Tools: let the LLM search again on its own
                            ↑
                  ④ Error degradation: failures must not break the main flow
```

---

## 0. Initialization

```python
from tencentdb_agent_memory import MemoryClient, AsyncMemoryClient

# Sync
client = MemoryClient(
    endpoint="https://your-memory-gateway",
    api_key=os.environ["MEMORY_API_KEY"],
    service_id="your-instance-id",
)

# Async (recommended for Agent scenarios)
async with AsyncMemoryClient(
    endpoint="https://your-memory-gateway",
    api_key=os.environ["MEMORY_API_KEY"],
    service_id="your-instance-id",
) as client:
    ...
```

`service_id` determines the memory space isolation granularity: the same id shares data, different ids are fully isolated. Agent scenarios almost always use async; do not use the sync version (it blocks the event loop).

---

## 1. Recall

Before sending the user message to the LLM, fetch three kinds of memory in parallel and assemble them into the system prompt.

```python
import asyncio

async def recall(client: AsyncMemoryClient, user_query: str) -> dict:
    l1, persona, scenes = await asyncio.gather(
        client.search_atomic(query=user_query, limit=5),
        client.read_core(),                            # L3 user persona
        client.list_scenarios(),                       # L2 scene index
        return_exceptions=True,                        # Key: one failing path does not affect the others
    )

    l1_items = l1["items"] if not isinstance(l1, Exception) else []
    persona_text = persona["content"] if not isinstance(persona, Exception) else None
    scene_list = scenes["entries"] if not isinstance(scenes, Exception) else []

    return format_prompt(l1_items, persona_text, scene_list)
```

`asyncio.gather(..., return_exceptions=True)` is the key: if any one path times out or fails, the other two results are still used and the main conversation is unaffected.

### Two blocks for assembling the prompt

- **prepend_context (dynamic)**: L1 recall results, which change every turn; placed before the user message.
- **append_system_context (stable)**: Persona + Scene index + tool usage guide; placed at the end of the system prompt, KV-cache friendly. _(TBD: placing it at the end of the system prompt can still cause KV cache misses; needs further discussion.)_

```python
def format_prompt(l1_items, persona, scenes) -> dict:
    prepend = None
    if l1_items:
        lines = [f"- [{m['type']}] {m['content']}" for m in l1_items]
        prepend = "<relevant-memories>\n" + "\n".join(lines) + "\n</relevant-memories>"

    parts = []
    if persona:
        parts.append(f"<user-persona>\n{persona}\n</user-persona>")
    if scenes:
        parts.append("## Scene Navigation\n*The following scenes can be read in detail with tdai_read_file*")
        parts.extend(f"- `{s['path']}`" for s in scenes)
    parts.append(MEMORY_TOOLS_GUIDE)  # See below

    return {"prepend": prepend, "append": "\n\n".join(parts)}
```

> Implementation note: during recall, **cache the original user text** (the clean version, without injected recall); the capture phase needs it later -- see Section 2.

---

## 2. Capture

After an agent turn finishes, clean the new user/assistant messages from that turn and write them back to L0.

```python
async def capture(
    client: AsyncMemoryClient,
    session_key: str,
    raw_messages: list,                  # Full message history provided by the framework
    original_user_text: str,             # Clean user text cached during recall
    original_user_message_count: int,    # Message count cached during recall
):
    # ① Positional slice: keep only the messages added in this turn
    new_messages = raw_messages[original_user_message_count:]

    # ② Extract user/assistant, dropping tool calls / system / multimodal noise
    extracted = extract_user_assistant(new_messages)

    # ③ Swap the recall-polluted user message back to the original
    for m in extracted:
        if m["role"] == "user" and m["timestamp"] == new_messages[0].get("timestamp"):
            m["content"] = original_user_text
            break

    # ④ Text cleanup: strip image base64, strip code blocks, filter too-short / symbol-only content
    cleaned = [
        {**m, "content": sanitize(m["content"])}
        for m in extracted
        if len(sanitize(m["content"]).strip()) > 5
    ]

    if not cleaned:
        return

    # ⑤ Submit
    await client.add_conversation(
        session_id=session_key,
        messages=[
            {
                "role": m["role"],
                "content": m["content"],
                "timestamp": datetime.fromtimestamp(m["timestamp"] / 1000).isoformat(),
            }
            for m in cleaned
        ],
    )
```

### Why replace the "polluted user message"

During recall, a `<relevant-memories>...</relevant-memories>` block is prepended to the user message. If it is written to L0 without restoring the original text, the next recall will search/embed based on this polluted text, forming a **feedback loop** that makes memory increasingly messy.

### Why use a positional slice

When an agent turn ends, the framework hands you the **full history**, not just this turn's additions. Sending it all would write duplicates. Record the message count N during recall; at the end, `messages[N:]` is the new content.

---

## 3. Exposing tools

Memory injected via the prompt alone is limited. Register three more tools so the LLM can search on its own:

| Tool | When to use | Implementation |
|---|---|---|
| `tdai_memory_search` | Find structured preferences/facts | `client.search_atomic(query=..., limit=...)` |
| `tdai_conversation_search` | Find raw conversation snippets | `client.search_conversation(query=..., limit=...)` |
| `tdai_read_file` | Read the full persona / scene block | `client.read_file(path)` |

State clearly in the system prompt when to call them, and add a call limit:

```
## Memory tools
- tdai_memory_search: search structured memory (user preferences, rules, historical events)
- tdai_conversation_search: search raw conversation text
- tdai_read_file: read a scene file (use the paths listed in Scene Navigation)

⚠️ memory_search + conversation_search may be called at most 3 times in total per turn.
```

Without a limit, the LLM will search aimlessly over and over.

---

## 4. Error degradation

A memory service outage **must not break the main conversation**. Three principles:

1. **Recall** uses `asyncio.gather(..., return_exceptions=True)`, so one failing path does not affect the others.
2. **Capture** is wrapped in try/except; on failure just log:
   ```python
   try:
       await capture(...)
   except Exception as e:
       logger.warning(f"capture failed: {e}")
   ```
3. **Tools** return an error string instead of raising, so the LLM sees "memory unavailable" and keeps chatting.

---

## 5. Error handling

A non-zero code raises `TDAMError`:

```python
from tencentdb_agent_memory import TDAMError

try:
    content = await client.read_file("scene_blocks/x.md")
except TDAMError as e:
    if e.code == 404:
        pass  # File does not exist; normal case
    else:
        logger.warning(f"memory error code={e.code} request_id={e.request_id}")
```

`request_id` is also logged on the server side; just give it to the backend when troubleshooting.

---

## 6. Performance tips

- **Total recall budget < 200ms**: run the three paths in parallel, use the fastest available results, and drop any that time out.
- **Keep injected prompt size small**: L1 <= 5 items, list only the path (not the content) in the Scene list, and one Persona is enough. Let the LLM pull details with tools when it needs more.
- **Session granularity**: `session_key` is the L0 partition key; for long-running conversations use a stable id (user id + conversation id) and do not change it every turn.
- **Do not call synchronously on the main thread**: use `AsyncMemoryClient`, not `MemoryClient`, otherwise the event loop is blocked.

---

## 7. Management plane: Knowledge / metadata

Everything above is about `MemoryClient` (data plane: reading and writing memory). If you also need to **manage** the metadata of Knowledge sources (wiki / code-graph), use `MetadataClient` (v3 management plane; no isolation 4-tuple needed):

```python
from tencentdb_agent_memory.v3 import MetadataClient

meta = MetadataClient(
    endpoint="http://127.0.0.1:8420",
    api_key="verify-token",
    service_id="your-instance-id",
)

# Register / list / rename / delete Knowledge entities (management-plane CRUD, see README.md)
meta.create_knowledge({
    "knowledge_id": "wiki-1", "type": "wiki",
    "service_url": "http://ks:8421/v3", "name": "Wiki", "team_id": "team-1",
})
meta.list_knowledge({"team_id": "team-1", "type": "wiki"})
```

Note: `MetadataClient` only handles metadata CRUD; actually searching wiki content, reading pages, or syncing repositories requires calling the Knowledge Service data plane (`:8421`, pointed to by `service_url`). That is a separate set of endpoints and is outside the scope of this SDK.

---

## Appendix: sanitize reference implementation

The cleanup functions handle these kinds of noise:

```python
import re
import time

_IMAGE_DATA_URI = re.compile(r"data:image/[a-z+]+;base64,[A-Za-z0-9+/=]+", re.IGNORECASE)
_CODE_BLOCK = re.compile(r"```[\s\S]*?```")

def sanitize(text: str) -> str:
    # Strip base64 images
    text = _IMAGE_DATA_URI.sub("[image]", text)
    # Strip code blocks (common in assistant output; noise for embeddings)
    text = _CODE_BLOCK.sub("[code]", text)
    return text.strip()


def extract_user_assistant(messages: list) -> list:
    """Extract user/assistant text from the raw message list, dropping tool / system / empty content."""
    out = []
    for m in messages:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if isinstance(content, list):
            # Multimodal message: concatenate the text parts
            content = "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
        if not isinstance(content, str) or not content.strip():
            continue
        out.append({
            "role": role,
            "content": content.strip(),
            "timestamp": m.get("timestamp", int(time.time() * 1000)),
        })
    return out
```
