# Changelog

This file records notable changes to **TencentDB Agent Memory**. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/)。

It covers all open-source modules in the repository: `MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
`MemoryProxy` / SDK。

---

## [2.0.2] — 2026-10-09

### 🗄️ MongoDB Storage Backend (Experimental, Optional, Off by Default)

- Further completed MongoDB backend capabilities: added two new storage types, memory-prompt and generation-ref,
  covering more memory data structures
- The one-command entry `./start-all-mongo.sh` persists `STORE_MODE` to `.env`, so later starts
  keep the same backend without reconfiguring each time
- Fixed self-healing in index-conflict scenarios; duplicate default/extracted records no longer cause startup errors

### 🔀 More Client Integrations

- **OpenCode**: added an official Memory adapter config package (including `opencode.json` and integration docs); configure it as documented to integrate, with no plugin code required
- **OpenCode**: supports the v2 provider config structure of 2.0; newer clients can reuse the official `opencode.v2.json` directly
- **DeepSeek Harness**: added dsh desktop adaptation; for configuration, see section 1.6 of `./agents/dsh/README.md`
- Added **Pi** client integration (an AI Agent client similar to Codex, using the OpenAI Chat protocol)

### 🧠 External Source Import (Wiki / Code / Tasks)

- Added the ability to import Tasks from external task management systems; task cards show their source directly and support ID copying
  and pagination
- Added registration of external code sources (private repos) with credential isolation; each team holds its own credentials, invisible to others
- Added Wiki external source import, which together with code sources and task sources completes the external asset import pipeline

### 🧰 Skill Experience Improvements

- Added a strict mode to cold-start batch skill extraction for more controllable extraction quality
- Skill extraction now automatically follows the user's language, so generated content better fits usage habits
- The skill list can be sorted by usage activity, making frequently used skills easier to find

### 🎛️ Memory Hub Panel

- Task cards support source display, ID copying, and improved pagination, making bulk import smoother
- Manual refresh now resets the time filter, so newly created memories are visible immediately

### 🔄 Session and Integration Experience

- Session onboarding is more stable on more clients: the only Agent is auto-selected, asset confirmation is more precise, and when a preset fails
  it is bypassed automatically instead of getting stuck
- Fixed repeated popups with WorkBuddy parallel sub-agents; session normalization is more robust
- Fixed issues affecting experience across several clients, such as memory commands, tool-result pollution, and duplicated history messages

### 🐛 Fixes

- Fixed abnormal BM25 recall without embeddings, L0 tool-result pollution, and raw-text display issues
- Fixed empty memory recall, duplicated history messages, truncated lists when switching between multiple teams, and similar issues
- Fixed Claude Code AGENTS.md instructions being lost, and similar issues
- Fixed deployment script compatibility issues in some environments

---

## [2.0.2-beta.1] — 2026-09-07

### 🗄️ MongoDB Storage Backend (Experimental, Optional, Off by Default)

The default storage is still sqlite, and existing deployments need no changes. MongoDB is offered as an optional backend,
for scenarios that need mongot native full-text search or want to evaluate a non-sqlite data plane:

- Added the one-command entry `./start-all-mongo.sh`; when `MONGODB_ENDPOINT` is not configured,
  the script starts a `mongodb-atlas-local` container locally (not cloud Atlas)
- When enabled, `MEMORY_CORE_STORE_MODE=mongodb` is written to `.env`, and later starts
  keep that backend and never silently fall back to sqlite
- **Switching storage backends does not migrate existing data.** sqlite and MongoDB use independent
  data directories / instances, so after switching the original data stays on the original backend. The current version requires you to back up and
  migrate manually; an official migration tool will be provided in a later version

For usage, see the "MongoDB storage backend (experimental)" section of [INSTALL.md](./INSTALL.md).

### 🧰 Skill Experience Improvements

- Skill retrieval and display are more structured, with clearer information and more stable invocation
- Legacy abnormal skill data is repaired automatically, so old assets remain seamlessly compatible

### 🔄 Session and Integration Experience

- Smoother integration for more clients; text-mode clients also work out of the box
- The team / Agent selection list is shown in full, so teams are no longer missed when there are many
- Clearer completion message after a session reset

### 🔐 OAuth2 Compatibility · Integrate with Enterprise OA Login

- Panel login is compatible with the standard OAuth2 protocol and can integrate with enterprise OA / SSO systems
- OA protocol details differ between vendors, so the repository provides an integration skeleton and config options;
  users only need minor adaptation to their own OA's `authorize` / `token` / `userinfo` endpoints
- After integration, team members can log in to Panel with their OA accounts, and user identity is linked to `user_key`
  automatically, with no need to distribute or remember a separate `sk-mem-...` string

### 📊 Data Analytics and Observability (Optional, Off by Default)

- A brand-new analytics page shows team usage at a glance, helping you judge how well memory assets are accumulating
- Added instrumentation and observability data at key points, making operations troubleshooting more intuitive
- **Off by default**; enabling it requires configuring ClickHouse on three services: Proxy / Knowledge
  handle event reporting (Proxy records memory / skill tool calls, Knowledge records
  wiki / code-graph tool calls), and Core provides the query interface. Panel calls the
  config-discovery interfaces of Core and Knowledge to decide whether it is enabled, and then calls the query interface
  to fetch data. See the
  "Data analytics and observability (optional)" section of [INSTALL.md](./INSTALL.md) for details

### 🐛 Fixes

- Fixed empty memory recall and ineffective retrieval degradation in some scenarios
- Fixed memory parsing failures and duplicated history messages in some cases
- Fixed truncated, incomplete lists when switching between multiple teams
- Fixed deployment script compatibility issues in some environments

---

## [2.0.1] — 2026-08-25

### 🚀 Support for More Agent Clients

Whichever coding agent you use, you can now attach team memory directly:

- Added **OpenCode** client integration
- Added **DeepSeek Harness (dsh)** integration: the Web UI sessions of DeepSeek's official agent harness
  can connect to the Proxy directly and automatically get team memory / skill / knowledge injection
- Added **Codex CLI** integration
- Added **WorkBuddy** client integration, ready out of the box
- First-run onboarding and reset behavior are consistent across clients, making switching smoother

### 🤖 Commands Directly in the Conversation

Common operations can be done in the conversation without switching to the panel:

- Reset bindings mid-session with one command (switch team / Agent / task)
- Create / update tasks directly in the conversation
- Faster command responses with less waiting

### 🧠 Cold Start Out of the Box

- A default Agent is generated automatically when a team or user is created, with no manual configuration
- Admins can customize the default Agent template, which is applied automatically to new users on cold start
- Assets can be imported in one click from existing Agents in the IDE for a quick start
- A task is bound by default after integration, so it works immediately

### 🔄 More Stable Session Binding

- Session bindings are persisted and survive restarts
- After switching Agent, memory and skills follow the switch correctly with no cross-talk
- Fixed history replay being misjudged on some clients

### 🧰 Skill Experience Upgrade

- Skills newly created in a session can be retrieved immediately, with no "search blind spot"
- Restored skill ID display and one-click copy
- Skills can be edited online
- Added an integration wizard skill: configure step by step with guidance, or complete Proxy integration automatically with one command

### 🎛️ Memory Hub Panel

- New login page with a dot-matrix ripple animation
- Team edit / delete entries are merged into the team switcher for easier operation, and a switching bug is fixed
- Admins can customize the User_Key when creating accounts
- Added conversation memory search: cross-session semantic and keyword retrieval with precise permission-based visibility;
  a single memory layer can be overwritten directly
- Asset IDs are shown directly and can be copied; lists load completely, fixing truncated pagination

### ⚙️ One-Command Deployment Enhancements

- The start script supports interactive configuration and pre-checks LLM connectivity and port usage to avoid deployment pitfalls
- Client integration address can be copied in one click; in single-node deployments it resolves to the host address automatically so external clients can connect directly

### ⚡ Performance Improvements

- Faster knowledge base list loading and quicker responses on common paths
- Wiki pages are built concurrently with automatic retry on single-page failure, greatly shortening bulk document import time

### 📚 Documentation

- Integration docs are split per client, so each agent has a clear integration guide
- Added panel and API usage docs
- Added English panel screenshots and README updates

### 🐛 Fixes

- Fixed empty memory retrieval in multi-Agent scenarios
- Fixed asset unbinding not taking effect and the memory tab disappearing when there are many assets
- Fixed scrambled timestamps when importing historical sessions; the original timeline is restored
- Fixed some content being expanded repeatedly when editing a scene
- Fixed deployment script compatibility on macOS
- Fixed installation errors caused by missing dependencies
- Fixed compatibility of the first-run onboarding form with older versions on some clients
- Added a clear-conversation-memory feature with bulk deletion

---

## [2.0.1-beta.1] — 2026-08-13

### 🧠 Cold Start Out of the Box · Default Agent + Preset Skills

- A default Agent is generated automatically when a team/user is created, with no manual configuration
- Client integration address can be copied in one click and can point to the Memory Proxy
- In single-node deployments the integration address resolves to the host address automatically so external clients can connect directly

### ⚡ Faster Wiki Generation

- Optimized Wiki generation with concurrent page builds, greatly shortening bulk document import time
- A single-page failure is retried automatically and no longer stalls the whole batch
- Generation progress and per-page status are visible in real time

### 🧰 Skill Ecosystem

- Added Skill export
- Improved Skill retrieval: private Skills can now be retrieved, with more precise results
- Improved Skill extraction with broader capture coverage

### 🔀 Memory Proxy · New Client Integrations

- Added Codex CLI integration
- Added WorkBuddy client integration
- Added DeepSeek Harness (dsh) integration: Web UI sessions of DeepSeek's official agent harness
  can connect to the Proxy directly and get team memory / skill / knowledge injection; supports aux request short-circuiting
  (compaction / title-gen) and CLI headless bypass
- Improved the association between code-graph resources and workspaces

### 🎛️ Memory Hub Panel

- Reworked the first-use onboarding flow, adding an Agent binding step
- Improved panel interactions, loading skeleton screens, and transitions
- Improved user display name resolution on the Task page
- Improved the asset page layout and the explanation of ownership/sharing rules
- Fixed the memory tab disappearing when there are many assets

### 🐛 Fixes

- Fixed empty memory retrieval in multi-Agent scenarios
- Fixed asset unbinding not taking effect
- Imported historical sessions keep their original timestamps, so the timeline is no longer scrambled
- Fixed memory loss in some scenarios
- Added a clear-conversation-memory feature with bulk deletion

---

## [2.0.0] — 2026-08-03

> **Product positioning**: turn an Agent's experience, documents, and code into reusable assets, so the next Agent
> can load them directly. See [README.md](./README.md) for details.

### 🧠 Four Memory Asset Types · First Complete Open-Source Release

The four asset types are automatically distilled from "conversations / work traces":

- **Chat Memory** — extracts layer by layer from conversations: L0 raw records → L1 facts → L2 scenes → L3
  long-term understanding; preferences, decisions, and interaction history persist across sessions.
- **Skill** — distills reusable SOPs from successfully completed tasks, with versions / resource files / trigger boundaries /
  execution steps / validation rules. Added forced Skill archiving.
- **Wiki** — turns documents into structured pages + a link graph (inspired by Karpathy's LLM knowledge base
  practice).
- **CodeGraph** — indexes a repository's symbols / files / call relationships / impact paths; Agents run impact analysis before
  changing code. Added scheduled automatic codebase sync.

### 🎛️ Memory Hub · Team-Oriented Console

Management panel (`agentmemory/memory-hub` image, including Panel + Knowledge Service):

- Create Teams / Agents and manage assets uniformly by Owner / version / status / visibility
- Three visibility levels: `private` / `team` / `restricted` (User / Role / Agent ACL),
  plus targeted `agent` assembly
- Agent Loadout: bind different assets to different Agents and adjust priority and usage
- Wiki + CodeGraph workshops are built into the Hub; import a codebase/documents and they build automatically
- Administrators (System Admin) can now also use asset management
- The panel fully supports switching between Chinese and English; unified page design style and improved list interaction and pagination

### 🔀 Memory Proxy · The Channel for Attaching Memory to Agents

`agentmemory/memory-proxy` lets coding agents such as Claude Code use team memory directly:

- **Anthropic / OpenAI dual protocol**: both `/claude-code/<spaceId>/v1/messages` and
  `/v1/chat/completions` are accepted
- **First-turn onboarding**: sessionInit uses `AskUserQuestion` to let the user pick team / agent /
  task, and the proxy remembers the binding
- **Per-turn injection**: stitches that agent's L2/L3 memory, matched skills, and wiki/code-graph
  into the system prompt and forwards to the upstream LLM
- **Authentication**: `x-tdai-user-key` → exchanged for `user_id` via the kernel's `/v3/meta/auth/verify`,
  controlling asset visibility per user
- Cost Guard supports configuring different models for different Agents to reduce cost

### 🚀 One Command to Start the Full Trio

All three images are published as multi-arch (`linux/amd64` + `linux/arm64`) to
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory), publicly pullable
without login:

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # fill in the two sets of LLM parameters
./start-all.sh                          # one-command start
```

On first start, `start-all.sh` automatically runs `init-admin`, generates the admin `sk-mem-...`, and saves it to
`.admin-key`; after self-checking `/v3/meta/auth/verify`, it prints a copyable `claude` launch command.
`stop-all.sh --purge` fully removes the volumes and admin key, making resets easy.

See [INSTALL.md](./INSTALL.md) for details (Chinese: [INSTALL_CN.md](./INSTALL_CN.md)).

### 🧰 Official SDKs

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 strict isolation: all three required
  });
  ```

  The top-level export is the v3 strict isolation version; legacy code can keep using the `.../v2/v3` subpath
  (the subpath is kept as a backward-compatible alias).

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # default (v2 compatible)
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```

### 📖 Documentation

- Added CodeBuddy / Hermes / OpenClaw integration guides
- Updated the role permission notes in the installation guide

---

## [2.0.0-beta.1] — 2026-07-21

First public release. SemVer starts at `2.0.0-beta.1` (npm package names migrate to a `-v2` suffix:
`@tencentdb-agent-memory/memory-tencentdb-v2`、`memory-sdk-ts-v2`）。
Docker image tags are independent of npm versions; this release's image is tagged `:1.0.0-beta.1`.

> **Product positioning**: turn an Agent's experience, documents, and code into reusable assets, so the next Agent
> can load them directly. See [README.md](./README.md) for details.

### 🧠 Four Memory Asset Types · First Complete Open-Source Release

The four asset types are automatically distilled from "conversations / work traces":

- **Chat Memory** — extracts layer by layer from conversations: L0 raw records → L1 facts → L2 scenes → L3
  long-term understanding; preferences, decisions, and interaction history persist across sessions.
- **Skill** — distills reusable SOPs from successfully completed tasks, with versions / resource files / trigger boundaries /
  execution steps / validation rules.
- **Wiki** — turns documents into structured pages + a link graph (inspired by Karpathy's LLM knowledge base
  practice).
- **CodeGraph** — indexes a repository's symbols / files / call relationships / impact paths; Agents run impact analysis before
  changing code.

### 🎛️ Memory Hub · Team-Oriented Console

Management panel (`agentmemory/memory-hub` image, including Panel + Knowledge Service):

- Create Teams / Agents and manage assets uniformly by Owner / version / status / visibility
- Three visibility levels: `private` / `team` / `restricted` (User / Role / Agent ACL),
  plus targeted `agent` assembly
- Agent Loadout: bind different assets to different Agents and adjust priority and usage
- Wiki + CodeGraph workshops are built into the Hub; import a codebase/documents and they build automatically

### 🔀 Memory Proxy · The Channel for Attaching Memory to Agents

`agentmemory/memory-proxy` lets coding agents such as Claude Code use team memory directly:

- **Anthropic / OpenAI dual protocol**: both `/claude-code/<spaceId>/v1/messages` and
  `/v1/chat/completions` are accepted
- **First-turn onboarding**: sessionInit uses `AskUserQuestion` to let the user pick team / agent /
  task, and the proxy remembers the binding
- **Per-turn injection**: stitches that agent's L2/L3 memory, matched skills, and wiki/code-graph
  into the system prompt and forwards to the upstream LLM
- **Authentication**: `x-tdai-user-key` → exchanged for `user_id` via the kernel's `/v3/meta/auth/verify`,
  controlling asset visibility per user

### 🚀 One Command to Start the Full Trio

All three images are published as multi-arch (`linux/amd64` + `linux/arm64`) to
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory), publicly pullable
without login:

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # fill in the two sets of LLM parameters
./start-all.sh                          # one-command start
```

On first start, `start-all.sh` automatically runs `init-admin`, generates the admin `sk-mem-...`, and saves it to
`.admin-key`; after self-checking `/v3/meta/auth/verify`, it prints a copyable `claude` launch command.
`stop-all.sh --purge` fully removes the volumes and admin key, making resets easy.

See [INSTALL.md](./INSTALL.md) for details (Chinese: [INSTALL_CN.md](./INSTALL_CN.md)).

### 🧰 Official SDKs

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 strict isolation: all three required
  });
  ```

  The top-level export is the v3 strict isolation version; legacy code can keep using the `.../v2/v3` subpath
  (the subpath is kept as a backward-compatible alias).

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # default (v2 compatible)
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```
