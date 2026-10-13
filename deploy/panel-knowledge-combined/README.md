# Memory Hub

**Memory Hub** is a combined image: a single container runs two services at once -- Team Memory Control (Panel) and Knowledge Service (KS).

- **Panel**: a console for managing team / Agent / Knowledge resources
- **KS**: a Wiki / Code Graph knowledge service that Agents call via tools

The image is published on Docker Hub: [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) (pulling `latest` is recommended).

---

## Prerequisites

### 1. Instance config file

After purchasing a Memory instance in the cloud, you will get an **instance ID**, a **Gateway address**, and an **API Key**. Write them into a JSON file (e.g. `metadata-instances.json`):

```json
{
  "instances": [
    {
      "id": "mem-xxxxxxxx",
      "name": "My Memory instance",
      "gateway_endpoint": "<your-gateway>.ap-shanghai",
      "api_key": "your-gateway-api-key"
    }
  ]
}
```

Set `gateway_endpoint` to the Gateway address given by the console (the example above is only for the Shanghai region; fill in your actual address). For multiple instances, add more objects to the `instances` array.

### 2. KS externally reachable address

KS needs to expose an address so that Agents (and the cloud Gateway) can reach KS's tools endpoint. This address **must be externally reachable** (`127.0.0.1` / `localhost` cannot be used) and **must contain** `/v3`.

For example, if the host's public/internal IP is `10.2.3.4` and port `8424` is mapped:

`http://10.2.3.4:8424/v3`

### 3. LLM Proxy address

KS's Wiki ingest / summarization and other capabilities call a large model, going through the LLM forwarding provided by Memory by default.

`KNOWLEDGE_LLM_PROXY_BASE_URL` is **the same address** as the `gateway_endpoint` above: the Gateway address obtained from the Memory console. For example, for the Shanghai region:

`<your-gateway>.ap-shanghai`

(For other regions, fill in the actual address from the console.)

To use your own LLM endpoint instead, see [Custom mode](#custom-mode-connect-directly-to-llm-bypassing-proxy) below.

---

## Quick start

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=<your-gateway>.ap-shanghai \
  agentmemory/memory-hub:latest
```

> Replace `/path/to/metadata-instances.json`, `10.2.3.4` (the KS external address), and `KNOWLEDGE_LLM_PROXY_BASE_URL` (same as `gateway_endpoint`; fill in the actual Gateway address from the console) with your actual values.

### Required settings (only these 3)

| Setting | How | Description |
| --- | --- | --- |
| Instance config | Mount `metadata-instances.json` | Cloud Memory instance ID, Gateway address, API Key |
| KS external address | `KNOWLEDGE_PUBLIC_BASE_URL` | An address from which KS is externally reachable; **must contain** `/v3` |
| LLM Proxy address | `KNOWLEDGE_LLM_PROXY_BASE_URL` | Same as `gateway_endpoint`; fill in the Gateway address from the Memory console |

These 3 items must be provided by the user; all other settings have built-in defaults in the image and can be adjusted as needed.

---

## Optional settings

All settings below have built-in defaults in the image and work without being passed. Override them as needed.

### LLM settings

| Environment variable | Default | Description |
| --- | --- | --- |
| `LLM_PROTOCOL` | `openai` | LLM protocol: `openai` uses `/chat/completions`, `anthropic` uses `/messages` |
| `LLM_MODEL` | `Memory-Model` | Model ID, passed through to proxy/TokenHub |
| `LLM_MODE` | `proxy` | `proxy`: go through the Memory Gateway LLM forwarding; `custom`: connect directly to a BYO endpoint |
| `LLM_MAX_TOKENS` | `32768` | Max output tokens per LLM call |
| `LLM_TIMEOUT_MS` | `1200000` | LLM call timeout in ms (20 minutes; reasoning models need a long time) |
| `LLM_API_KEY` | empty | Required only when `LLM_MODE=custom` |
| `LLM_BASE_URL` | empty | Required only when `LLM_MODE=custom`, e.g. `https://api.openai.com/v1` |

**Protocol and model pairing rules**:

| Protocol | Applicable models | Endpoint |
| --- | --- | --- |
| `openai` (default) | `Memory-Model`, `deepseek-v4-pro` | `/chat/completions` |
| `anthropic` | `ep-pksklwtb`, `claude-sonnet-4-5`, etc. | `/messages` |

The protocol must match when switching models:

```bash
# Default (OpenAI protocol + Memory-Model)
# No extra config needed; this is the image default

# Switch to an Anthropic model
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

### Network and storage

| Environment variable | Default | Description |
| --- | --- | --- |
| `PANEL_PORT` | `8125` | Panel service port |
| `KNOWLEDGE_PORT` | `8424` | KS service port |
| `KNOWLEDGE_DATA_DIR` | `/data/knowledge` | KS data directory (SQLite, git clone, wiki files, logs) |
| `KNOWLEDGE_DB_PATH` | `/data/knowledge/knowledge.db` | KS SQLite database path |
| `TMC_CALLBACK_URL` | `http://127.0.0.1:8125` | Root address of the Panel that KS calls back when ingest completes (loopback inside the container automatically; usually no need to change) |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | Request timeout for Panel calling KS |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | Request timeout for Panel calling the remote Gateway |
| `REMOTE_INSTANCE_PROXY_URL` | empty | Base URL shown on the Panel UI "client access address" card. When running core+proxy separately in an open-source local deployment, set it to the proxy's external address (e.g. `http://host.docker.internal:8096`), and the CodeBuddy/ClaudeCode access address copied from the Panel UI will point to the proxy. If left empty, the old behavior applies -- the UI falls back to `gateway_endpoint`. **Panel backend → Kernel forwarding always goes through `REMOTE_INSTANCE_URL`, unrelated to this variable.** (When `metadata-instances.json` is mounted this variable is ignored; add a `proxy_endpoint` field directly in the JSON) |

### TLS certificates

Public official certificates generally need no extra configuration. When the LLM Proxy or Gateway uses HTTPS and the certificate is not trusted by the container (e.g. self-signed certificates, internal CA), there are two ways to resolve it:

**Option A: skip TLS verification (for quick testing; not recommended for production)**

```bash
-e NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Option B: mount a CA certificate (recommended)**

```bash
-v /path/to/your-ca.pem:/usr/local/share/ca-certificates/extra-ca.crt:ro \
-e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/extra-ca.crt
```

| Environment variable | Default | Description |
| --- | --- | --- |
| `NODE_TLS_REJECT_UNAUTHORIZED` | unset | Set to `0` to skip TLS certificate verification (testing only) |
| `NODE_EXTRA_CA_CERTS` | unset | Path to additional CA certificates; natively supported by Node.js, and the AI SDK's fetch also reads it |

### Logging

| Environment variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Log level (`debug` / `info` / `warn` / `error`) |
| `LOG_FORMAT` | `json` | Log format (`json` / `text`) |
| `LOG_DIR` | `/data/knowledge/logs` | Log file directory |

Logs are written to files at `${LOG_DIR}/panel.log` and `${LOG_DIR}/knowledge.log`, rotated to a `.prev` copy on each start, and also output to stdout (visible via `docker logs`).

### Observability (Langfuse)

Once all three are configured, KS's LLM calls automatically report traces to Langfuse.

| Environment variable | Default | Description |
| --- | --- | --- |
| `LANGFUSE_BASE_URL` | empty | Langfuse service address |
| `LANGFUSE_PUBLIC_KEY` | empty | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | empty | Langfuse secret key |

### LLM Binding sync

| Environment variable | Default | Description |
| --- | --- | --- |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `1` | Whether the Panel syncs the KS llm_binding for instances on startup. Forced to `1` when `LLM_MODE=proxy`; in `custom` mode set `0` to make KS use the global config |

---

## Access addresses

| Service | Address |
| --- | --- |
| Panel UI | `http://localhost:8125/` |
| Panel API | `http://localhost:8125/api/v1/` |
| KS Health | `http://localhost:8424/health` |
| KS API | `http://localhost:8424/v3/` |
| KS Swagger docs | `http://localhost:8424/docs` |

---

## Custom mode (connect directly to LLM, bypassing Proxy)

If you do not use the Memory Gateway's LLM forwarding, you can specify your own LLM endpoint directly. In that case `KNOWLEDGE_LLM_PROXY_BASE_URL` is not needed.

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_API_KEY=sk-your-llm-key \
  -e LLM_BASE_URL=https://api.openai.com/v1 \
  -e LLM_MODEL=gpt-4o \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  agentmemory/memory-hub:latest
```

---

## Data persistence

| Mount point | Description |
| --- | --- |
| `/data/knowledge` | KS data (SQLite, git clone, wiki files, logs) |

A named volume is recommended: `-v memory-hub:/data/knowledge` (consistent with the container name).

---

## FAQ

### Q: How do I reach host services from inside the container?

The cloud Gateway (`KNOWLEDGE_LLM_PROXY_BASE_URL`) can generally be reached directly, with no need to change it to a host address. If other services (such as Langfuse) run on the host, use `172.17.0.1` (the docker0 bridge) instead of `localhost`:

```bash
-e LANGFUSE_BASE_URL=http://172.17.0.1:8400
```

Or add `--add-host=host.docker.internal:host-gateway` and use `host.docker.internal`.

### Q: wiki ingest reports a timeout?

Reasoning models may need more than 20 minutes for large files:

```bash
-e LLM_TIMEOUT_MS=1800000  # 30 minutes
```

### Q: tools/list returns 404?

`KNOWLEDGE_PUBLIC_BASE_URL` must include the `/v3` prefix. Correct format: `http://host:port/v3`.

### Q: Errors after switching the LLM protocol?

Make sure `LLM_PROTOCOL` and `LLM_MODEL` are paired:

```bash
# OpenAI model (default)
-e LLM_PROTOCOL=openai -e LLM_MODEL=Memory-Model

# Anthropic model
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

---

## Build

### Prerequisites

Sources are all under this repo's root directory:

```text
memory-tencentdb/
├── MemoryPanel/                         # Panel backend + web frontend
├── MemoryKnowledge/                     # Knowledge Service
└── deploy/panel-knowledge-combined/     # this recipe
```

### Local single-arch build (for debugging)

```bash
cd deploy/panel-knowledge-combined
IMAGE_TAG=1.0.0-beta.1 ./build.sh          # default linux/amd64 → team-memory-panel-knowledge:1.0.0-beta.1
PLATFORM=linux/arm64 IMAGE_TAG=arm64 ./build.sh   # if your machine is arm64 you can build directly
```

### Publish to Docker Hub (amd64 + arm64)

Tag conventions:

| Tag | Meaning |
| --- | --- |
| `1.0.0-beta.N` | Pinned version (use this for docs/reproduction) |
| `beta` | Floating channel: always points to the latest beta (pushed along with the release by default) |
| `latest` | Use only for official stable releases (not pushed by default) |

For the first release, it is recommended to push: `agentmemory/memory-hub:1.0.0-beta.1` + `agentmemory/memory-hub:beta`.

```bash
cd deploy/panel-knowledge-combined

# 1) Logged in to Docker Hub (requires agentmemory org push permission)
docker login

# 2) Only scan for secrets + prepare the context (no build)
DRY_RUN=1 VERSION=1.0.0-beta.1 ./publish.sh

# 3) Optional: first load amd64 locally and spot-check that the image layers contain no .env / metadata-instances.json
PUSH=0 VERSION=1.0.0-beta.1 ./publish.sh

# 4) Official dual-arch build and push (also tags :beta by default)
VERSION=1.0.0-beta.1 ./publish.sh

# Only the version tag, without moving :beta:
# ALSO_BETA=0 VERSION=1.0.0-beta.1 ./publish.sh

# Tag latest for official releases (do not enable during the beta phase):
# ALSO_LATEST=1 ALSO_BETA=0 VERSION=1.0.0 ./publish.sh
```

`publish.sh` will, in order:

1. Run `scripts/secret-scan.sh` on `MemoryPanel` / `MemoryKnowledge`
2. `PREPARE_ONLY=1 ./build.sh` generates the rsync context (already excluding `.env*`, `metadata-instances.json`, etc.)
3. Scan the context again
4. `docker buildx build --platform linux/amd64,linux/arm64 --push` to `agentmemory/memory-hub:<VERSION>` (also tags `:beta` by default; the local name `team-memory-panel-knowledge` is used only for `PUSH=0` and is not pushed)

Post-push self-check:

```bash
docker buildx imagetools inspect agentmemory/memory-hub:1.0.0-beta.1
docker buildx imagetools inspect agentmemory/memory-hub:beta
# You should see Platform: linux/amd64 and linux/arm64, with identical digests
docker pull agentmemory/memory-hub:beta
```

Quick reference of environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `VERSION` | `1.0.0-beta.1` | Version tag |
| `HUB_IMAGE` | `agentmemory/memory-hub` | Repository name |
| `PLATFORMS` | `linux/amd64,linux/arm64` | buildx targets |
| `BUILDER` | `multiarch` | buildx builder name (created automatically if missing) |
| `DRY_RUN` | `0` | `1` = scan only |
| `PUSH` | `1` | `0` = local `--load` single arch |
| `ALSO_BETA` | `1` | `1` = also push the floating `:beta` |
| `ALSO_LATEST` | `0` | `1` = also push `:latest` |
