# TDAI Global Images: Local Deployment

Local launch scripts for the three global images: `memory-core` + `memory-hub` + `proxy`. Each can run on its own, or all can be started with a single command.

## Components and Ports

| Component | Container | Image (public on Docker Hub) | Host Port | Purpose |
|---|---|---|---|---|
| **memory-core** | `tdai-memory-core` | [`agentmemory/memory-core`](https://hub.docker.com/r/agentmemory/memory-core) | `8420` | Core gateway: memory read/write, auth, skill/RAG data plane |
| **memory-hub**  | `tdai-memory-hub`  | [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)   | `8125` / `8424` | Combined image of the management panel (Panel) and knowledge service (Knowledge) |
| **proxy**       | `tdai-proxy`       | [`agentmemory/memory-proxy`](https://hub.docker.com/r/agentmemory/memory-proxy) | `8096` | LLM request forwarding proxy, the API entry point for coding agents |

> All three images are published under the [`agentmemory`](https://hub.docker.com/u/agentmemory) namespace on Docker Hub.
> They are multi-arch (`linux/amd64` + `linux/arm64`), publicly pullable, and need no login. To pin a version, change the tag in `.env` from
> `:latest` to a specific version, e.g. `:1.0.0-beta.1`.
>
> Tencent internal colleagues can also override to the internal private registry `mirrors.tencent.com/memory-team-control/`; see the
> commented-out alternative block in `.env.example`.

## Requirements

- macOS / Linux
- Docker (any of Docker Desktop / colima / OrbStack)
- `bash` 4+ (the 3.2 bundled with macOS also works)

## Quick Start

```bash
cd TencentDB-Agent-Memory/deploy/global-images

# One command: auto-copy .env → interactively fill in LLM → auto-verify connectivity → start all three
./start-all.sh
```

`start-all.sh` is now **interactive**. When run, it will:

1. If `.env` does not exist, copy it from `.env.example` automatically (no manual `cp` needed)
2. Guide you through filling in two LLM groups (**Enter = keep the current default**):
   - `memory group`: `BASE_URL` / `API_KEY` / `MODEL` (protocol defaults to `openai`)
   - `proxy group`: first asks "reuse the memory group config?"; if yes, it is skipped
3. **Immediately check LLM connectivity** after you fill it in; if it fails, you are prompted to re-enter until it passes
4. **Write the values back to `.env`** for persistence (reused by default on the next start)
5. Once checks pass, start all three with one command

> To skip the interaction and read `.env` directly: manually `cp .env.example .env` and fill in the LLM settings,
> then run `./start-all.sh` and press Enter through the prompts (the defaults are the values in `.env`).

### MongoDB Storage Backend (experimental, optional)

The default storage is still **sqlite** (zero dependencies, data lives in a container volume). The MongoDB data plane is an **experimental feature**,
disabled by default, and not recommended as the production default backend. When enabled, it uses L0/L1/profile/skill documents + mongot
native BM25 retrieval, and metadata is synced to Mongo by default:

```bash
./start-all-mongo.sh    # Same flow as start-all.sh; writes MEMORY_CORE_STORE_MODE=mongodb to .env
```

- The script writes `MEMORY_CORE_STORE_MODE=mongodb` to `.env`, so afterwards `./start-all.sh`
  also keeps MongoDB and does not silently fall back to sqlite. To go back to sqlite: comment out that line or set it to
  `sqlite`, then run `./start-all.sh`;
- When `MONGODB_ENDPOINT` is not set, the script automatically starts a local `mongodb-atlas-local` container
  (mongod + mongot combined, **not** cloud Atlas; data persists in `mongo-local-*` volumes,
  which `stop-all.sh --purge` also cleans up);
- To use an external Mongo (cloud Atlas / a self-hosted replica set with mongot), just set
  `MONGODB_ENDPOINT` in `.env`;
- **Switching the storage backend does not migrate existing data.** sqlite lives in the `MEMORY_CORE_VOLUME` volume, mongo
  in the `mongo-local-*` volumes (or the external instance); after switching, the old data stays in the original backend. The current version requires
  you to back up and migrate manually; an official migration tool will be provided in a later version. L2/L3 files live in the
  `MEMORY_CORE_VOLUME` volume in both modes.

### Dry-Run Verification (optional)

`verify.sh` can still be used on its own; it only checks the environment and does not start containers:

```bash
./verify.sh              # Full check by default (including LLM connectivity pre-check)
./verify.sh --skip-llm   # Skip the LLM check (offline environments)
```

## LLM Connectivity Pre-Check

By default `verify.sh` pre-checks two LLM groups (`--skip-llm` turns this off):

- **OpenAI-compatible protocol**: `GET {base}/models`, only verifies the API key + URL, **consumes no tokens**
- **Anthropic protocol**: `POST {base}/v1/messages` with a minimal message at `max_tokens=1`, consuming ≤ 10 tokens
- The **memory group** and **proxy group** are verified independently; if the two groups are identical, the duplicate check is skipped
- **When the containers are already running**, it additionally execs a curl from inside the container to verify "container → LLM" network reachability (in some corporate proxy / DNS-isolated environments the host can reach it but the container cannot)

Failure example:

```
[error] memory group API key invalid (HTTP 401): https://api.deepseek.com/v1/models
{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid",...}}
```

A wrong API key, URL, or model name is caught before startup, instead of failing with a 401 only during wiki ingest / chat.

After startup completes:

- Panel UI: <http://localhost:8125/>
- Knowledge API: <http://localhost:8424/v3/>
- Knowledge Swagger: <http://localhost:8424/docs>
- Memory Gateway: <http://localhost:8420/>
- Proxy: <http://localhost:8096/>

## Two Independent Parameter Groups

**This is the core of the script design**: the memory group and proxy group LLMs are fully independent and can point to different providers / different models.

### memory group (used by memory-core + memory-hub)

Core memory embed/summarize and knowledge wiki ingest / summarization use this group's config.

| Variable | Description | Example |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | OpenAI-compatible base URL | `https://api.deepseek.com/v1` |
| `MEMORY_LLM_API_KEY` | API key for the endpoint above | `sk-xxxxxxxx` |
| `MEMORY_LLM_MODEL` | Model ID | `deepseek-chat` |
| `MEMORY_LLM_PROTOCOL` | `openai` or `anthropic`, defaults to `openai` | `openai` |

### proxy group (used by proxy)

After the proxy receives a user request, it forwards it to this group's endpoint.

| Variable | Description | Example |
|---|---|---|
| `PROXY_UPSTREAM_URL` | Forwarding target base URL | `https://api.deepseek.com/v1` |
| `PROXY_UPSTREAM_API_KEY` | API key used for forwarding | `sk-xxxxxxxx` |
| `PROXY_UPSTREAM_MODEL` | User-facing model ID | `deepseek-chat` |

> The two groups can have the same values (both pointing to the same LLM) or be completely different: for example, the memory group uses a cheap model for embedding while the proxy group uses a strong model for the main conversation.

When parameters are missing, the script **lists all missing items at once before startup** and runs `exit 1`, rather than failing halfway through.

## Memory Prompt Mode (chat / code)

memory-core uses `MEMORY_PROMPT_MODE` to switch the prompt family of the L1/L2/L3 pipeline:

| Mode | `.env` value | Extracted content | L3 output | Use case |
|---|---|---|---|---|
| **code** (default) | `MEMORY_PROMPT_MODE=code` | Project facts / tasks / decisions / SOPs / taboos | Team Operating Doctrine | coding agents, team collaboration, engineering projects |
| chat | `MEMORY_PROMPT_MODE=chat` | persona / episodic / instruction | persona.md (personal profile) | personal assistants, casual chat, teaching |

> **Note**: in `code` mode, pure casual chat may yield 0 memories (the LLM sees no engineering content worth retaining). If L1 never produces output, first check whether `MEMORY_PROMPT_MODE` matches the actual conversation scenario.

## Internal Credentials (must-read for production)

The three components authenticate to each other with `MEMORY_CORE_GATEWAY_API_KEY`, and the first start also creates a `system_admin` account via
`init-admin`. For a **zero-config local experience**, the script defaults are:

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_CORE_GATEWAY_API_KEY` | `local` | Bearer for memory-hub / proxy → memory-core |
| `MEMORY_CORE_ADMIN_USERNAME` | `admin` | Username of the initialized system_admin |
| `MEMORY_CORE_ADMIN_USER_KEY` | `admin` | Login key of that admin user |
| `KNOWLEDGE_SERVICE_KEY` | **auto-generated random value** | Panel ↔ Knowledge service Bearer (enforced on write/admin endpoints) |

> `KNOWLEDGE_SERVICE_KEY` has no fixed default: on first start the script generates a random `ks-svc-*` string
> and writes it back to `.env` (reused on restart, no drift), and injects the same value into the memory-hub container twice:
> `KNOWLEDGE_SERVICE_KEY` (Knowledge verification side) + `KNOWLEDGE_AUTH_TOKEN` (Panel calling side).
> To distribute it yourself (multi-machine / external orchestration), set it explicitly in `.env`; the script respects an existing value.

> These three defaults are only suitable for getting things running on a personal machine. **Before production / integration testing / public exposure, you must replace them with long random strings**,
> otherwise anyone who can reach the ports gets system_admin privileges.
>
> Uncomment the corresponding three lines in `.env` and override them (`_lib.sh` runs `require_vars`
> to validate the other required items, but since these three variables have fallback defaults, the script prints a `[warn]` at startup reminding you to change them).

## Using Each Component Independently

The three scripts can be run on their own, which is handy for debugging or when you only need part of the functionality:

```bash
./start-memory-core.sh       # Run only the core gateway (8420)
./start-memory-hub.sh   # Run only panel + knowledge (8125 + 8424); requires MEMORY_LLM_* parameters
./start-proxy.sh        # Run only the proxy (8096); requires PROXY_UPSTREAM_* parameters
```

Dependencies:

- **memory-core**: no external dependencies, can start on its own
- **memory-hub**: can start on its own (LLM_MODE=custom connects to the LLM directly), but knowledge's internal RAG calls to memory-core will fail → start memory-core first
- **proxy**: can start on its own (when cost-guard is unavailable it automatically degrades to passthrough and forwards directly), but auth / tdai memory / skill injection only work with memory-core

When any component is missing, the script prints a `warn` but does not block.

## Data Persistence

- `tdai-memory-core-data` (named volume) → memory-core's SQLite / memory data
- `tdai-panel-data` (named volume) → knowledge's SQLite / git clones / wiki files inside memory-hub

Data is kept until `docker volume rm`. To rename them, change `MEMORY_CORE_VOLUME` / `PANEL_VOLUME` in `.env`.

## Stop / Clean Up

```bash
./stop-all.sh            # Stop containers, keep volumes (data is still there next start)
./stop-all.sh --purge    # Stop containers + delete volumes + delete network (full cleanup)
```

## Viewing Logs

```bash
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
```

memory-hub runs two processes internally (panel + knowledge); their logs are inside the container at `/data/knowledge/logs/panel.log` and `.../knowledge.log` respectively.

## Port Conflicts

If `8125` / `8420` / `8424` / `8096` conflict with existing local services, change them directly in `.env`:

```bash
MEMORY_CORE_PORT=18420
PANEL_PORT=18125
KNOWLEDGE_PORT=18424
PROXY_PORT=18096
# The externally reachable knowledge address must follow KNOWLEDGE_PORT
KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:18424/v3
```

## Using the Proxy as a Coding Agent's API Base

Using Claude Code as an example:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8096
export ANTHROPIC_API_KEY=any-string-if-auth-disabled
# Clients using the openai protocol are similar: OPENAI_BASE_URL=http://localhost:8096/v1
```

The Panel UI "Client Access URL" card automatically combines the host's LAN IP + `PROXY_PORT` (e.g.
`http://192.168.1.100:8096/codebuddy/default`), so other people's computers can copy it and connect directly.
It is injected into memory-hub's `metadata-instances.json.proxy_endpoint` from `MEMORY_HUB_PROXY_PUBLIC_URL` (when unset, the script auto-detects with `hostname -I` / macOS `ipconfig getifaddr en0`,
and only falls back to `localhost` if detection fails).
The Panel backend → Kernel forwarding is not affected by this variable (it always goes through `REMOTE_INSTANCE_URL` → memory-core:8420).
When the auto-detected address is wrong (multiple NICs / public domain / reverse proxy in front), explicitly set it in `.env`:
`MEMORY_HUB_PROXY_PUBLIC_URL=http://<actual-value>:8096`. To get the old UI card behavior (falling back to
gateway_endpoint), explicitly set `MEMORY_HUB_PROXY_PUBLIC_URL` to an empty string.

`proxy` disables `auth` / `sessionInit` / `costGuard` by default (these depend on internal services), and only does pure forwarding + `tdai-memory` context injection (an injector name, not the container name). To enable the full pipeline, configure it separately; see `context_proxy/config.example.yaml`.

## FAQ

**Q: `./start-all.sh` hangs at wait_healthy?**
The image may still be pulling. Pre-pull it manually with `docker pull <IMAGE>` and run the script again.

**Q: memory-hub is up but the Panel won't open?**

Check whether `KNOWLEDGE_PUBLIC_BASE_URL` in `.env` contains `/v3`; without `/v3` the panel reports an error.

**Q: proxy forwarding returns 401?**
`PROXY_UPSTREAM_API_KEY` is invalid or `PROXY_UPSTREAM_URL` does not match. Use `docker logs tdai-proxy` to see the error.

**Q: How do I reach other services on the host (Ollama, Langfuse, etc.) from inside the container?**
The scripts already pass `--add-host=host.docker.internal:host-gateway` by default. Inside the container, use `http://host.docker.internal:<port>`.
