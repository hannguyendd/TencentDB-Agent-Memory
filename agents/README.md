# Agents

Memory Proxy currently supports 7 types of AI Agent clients, whose protocols, session initialization methods, and injection logic differ significantly.

> 🛠 **Want to integrate a new AI Agent client (not in the table below)?**
> Read the [**New Client Adaptation Guide →**](./adapter-agent-development.md)
> It contains a 20-item checklist covering everything from "packet capture reconnaissance" to "proxy-side route / adapter / session-init changes" to "end-to-end e2e passing", a quick reference of 8 categories of common pitfalls, and a dsh reference implementation you can copy.

## Quick Start

### Option 1: Run the script manually

```bash
cd <repo root>
bash agents/setup-proxy.sh
```

An interactive wizard that guides you step by step through configuring an Agent to connect to the Proxy:
1. Automatically scans existing configuration (reuses it if present, no need to fill it in again)
2. Choose the Agent to configure
3. Enter the model ID
4. Health probe (verifies Proxy connectivity)
5. Write the config file (the original file is automatically backed up as `.bak`)
6. Optional: import local skills/conversations into team memory

All 7 Agents are supported; configure one at a time and run it multiple times to configure different Agents.

### Option 2: AI Agent-assisted configuration (Skill)

Let an AI Agent such as Claude Code / CodeBuddy guide you through the configuration based on the skill; the agent will probe the environment step by step, verify connectivity, and make choices dynamically.

#### Step 1: Copy the agents directory to your home directory

```bash
cd <repo root>
cp -r agents ~/agents
```

#### Step 2: Use the following prompts in an AI Agent conversation

> Note: before running the script, the agent needs to `cd ~/agents` into the directory first.

**Configure a new Agent to connect to the Proxy:**

```
Please read the skill document ~/agents/skills/setup-proxy/SKILL.md, then follow the steps in it to guide me through configuring an Agent to connect to the Memory Proxy.
```

**Configure a specific Agent (e.g. Claude Code):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me configure Claude Code to connect to the Memory Proxy. My proxy address is http://localhost:8096 and the instance ID is default.
```

**Configure Hermes/OpenClaw (requires header preselection):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me configure Hermes to connect to the Memory Proxy. The panel address is http://localhost:8125; help me fetch the team/agent list from the panel to choose from.
```

**Health probe only (no config written):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me probe whether the proxy at http://localhost:8096 is healthy, using the codebuddy protocol and model claude-opus-4.7.
```

> ℹ️ The Skill file is at `agents/skills/setup-proxy/SKILL.md`, with the companion script `agents/skills/setup-proxy/setup-proxy.sh`. The Agent is responsible for collecting information and verifying the environment step by step, and finally calls the script's `--non-interactive` mode to write the configuration.

---

Each subdirectory corresponds to one agent and contains:
- `README.md` — integration config, adaptation approach, Session Init flow, FAQ
- `asset-import.md` — import that client's local skills / memory / sessions into Memory Hub (single-file manual)
- `asset-import.ts` — that client's disk-scan implementation; the unified entry is `agents/asset-import.ts` at the repo root, with `--source <name>` to specify the IDE
- Can later hold: adaptation process notes, debug scripts, captured-traffic fixtures, etc.

---

## Quick Comparison Table

| Agent | Protocol | Session Init Method | Form Tool | Pagination | Default/Plan Gate | Headless Bypass |
|-------|------|-------------------|-----------|------|-------------------|-----------------|
| [Claude Code](./claude-code/) | Anthropic Messages | Interactive Form | `AskUserQuestion` | ✅ (max 4) | ❌ | ❌ |
| [CodeBuddy](./codebuddy/) | OpenAI Chat Completions | Interactive Form | `ask_followup_question` | ❌ (no limit) | ❌ | ❌ |
| [Codex](./codex/) | OpenAI Responses API | Interactive Form + Default Gate | `request_user_input` | ✅ | ✅ | ❌ |
| [WorkBuddy](./workbuddy/) | Responses (Desktop) / Chat (Web) | Interactive Form | `AskUserQuestion` | ✅ (max 4) | ✅ | ✅ (silent passthrough) |
| [dsh (DeepSeek Harness)](./dsh/) | OpenAI Chat Completions | Interactive Form + Headless Bypass | `ask_user_question` | ❌ (no limit) | ❌ | ✅ (when no tool) |
| [Hermes](./hermes/) | OpenAI Chat Completions | Header preselection (no Form) | N/A | N/A | N/A | ✅ (when header is missing) |
| [OpenClaw](./openclaw/) | OpenAI Chat Completions | Header preselection (no Form) | N/A | N/A | N/A | ✅ (when header is missing) |

---

## Local Asset Import

Import the skills / memory / historical sessions on each client's disk into Memory Hub. Each client has one scan file that you can run directly:

```bash
# Interactive import (after launch, asks y/N item by item for skill / memory / session)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid>

# Non-interactive full import (scripts/CI)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y
```


| Agent | Manual |
|-------|------|
| Claude Code | [asset-import.md](./claude-code/asset-import.md) |
| CodeBuddy | [asset-import.md](./codebuddy/asset-import.md) |
| Codex | [asset-import.md](./codex/asset-import.md) |
| WorkBuddy | [asset-import.md](./workbuddy/asset-import.md) |
| dsh | [asset-import.md](./dsh/asset-import.md) |
| Hermes | [asset-import.md](./hermes/asset-import.md) |
| OpenClaw | [asset-import.md](./openclaw/asset-import.md) |

---

## Session ID Header Quick Reference

| Agent | Primary Header | Alternatives |
|-------|-----------|------|
| Claude Code | `x-claude-code-session-id` | `x-session-id`, `x-conversation-id` |
| CodeBuddy | `x-conversation-id` | `x-session-id`, `x-cb-session-id`, `x-codebuddy-session-id` |
| Codex | `session-id` | `body.client_metadata.session_id` |
| WorkBuddy | `session-id` | `body.client_metadata.session_id` |
| dsh | `x-deepseek-harness-session-id` | `x-session-id` |
| Hermes | `x-conversation-id` | — (static user config) |
| OpenClaw | `x-conversation-id` | — (static user config) |

---

## Client Configuration Methods

| Agent | Configuration Method | Config File / Variable | Key Passing |
|-------|----------|-----------------|----------|
| Claude Code | Environment variable or config file | `~/.claude/settings.json` or env `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | env / JSON `env.ANTHROPIC_AUTH_TOKEN` |
| CodeBuddy | Config file | `~/.codebuddy/models.json` | JSON `apiKey` |
| Codex | Config file | `~/.codex/config.toml` | TOML `experimental_bearer_token` |
| WorkBuddy | Config file | `~/.workbuddy/models.json` | JSON `apiKey` |
| dsh | Config file | `~/.dsh/settings.yaml` + `.credentials.yaml` | YAML environment variable reference |
| Hermes | Config file | `~/.hermes/config.yaml` | YAML `api_key` + headers |
| OpenClaw | Config file | `~/.openclaw/openclaw.json` | JSON `apiKey` + headers |

---

## Routing Rules

```
/:agent/:spaceId/v1/messages          → Anthropic protocol (CC, CB-Anthropic)
/:agent/:spaceId/v1/chat/completions  → OpenAI Chat (CB, WB-web, dsh, Hermes, OpenClaw)
/:agent/:spaceId/chat/completions     → OpenAI Chat without v1 prefix (dsh)
/:agent/:spaceId/v1/responses         → Responses API (Codex, WB-desktop)
/:agent/:spaceId/responses            → Responses API without v1 prefix (Codex, WB-desktop)
```

---

## Header Preselection (generic, usable by all agents)

In addition to the interactive Form, **all agents** support completing session registration directly via HTTP Headers, skipping the form interaction. Suitable for:
- Clients that cannot respond to a form (such as Hermes / OpenClaw)
- Wanting to skip the form to speed up the first frame (such as CI/CD automation scenarios)
- Third-party platforms / self-developed Agents

### Required Headers

| Header | Description |
|--------|------|
| `Authorization: Bearer <user_key>` | The business user's API Key (obtained from the panel) |
| `x-team-id` | Team ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | Task ID (required in the current version) |
| `x-conversation-id` | Conversation identifier, generated and managed by the client itself |

All headers above present → the Proxy completes session registration + asset injection directly, without showing a form.  
Any missing → falls back to the interactive form (if the client supports it) or session bypass (when the form is not supported).

### Integrating Other Platforms

Any OpenAI API-compatible platform can be integrated by pointing its API base URL at the Proxy:

```text
http://<proxy-host>:<port>/<agent-source>/<spaceId>
```

- `<agent-source>`: must be one of the values supported by the Proxy: `claude-code`, `codebuddy`, `workbuddy`, `codex`, `hermes`, `openclaw`; other platforms can integrate by masquerading as one of them (e.g. using `codebuddy`)
- `<spaceId>`: memory instance ID (fixed to `default` for local deployments)

---

## New Agent Integration Flow Overview

1. **Capture traffic** — use mitmproxy to capture 3~5 typical requests (main / aux / title-gen), saved to `MemoryProxy/docs/<agent>-recon/`
2. **Identify the protocol** — determine the wire protocol (Anthropic / Chat / Responses)
3. **Determine the Session ID source** — find the unique conversation identifier in the header or body
4. **Choose the Session Init strategy** — has a tool → interactive form; no tool → header preselection / headless bypass
5. **Classify auxiliary requests** — identify requests such as title-gen / compact / fork that do not need the full pipeline
6. **Implement Handler / reuse** — clients with the same protocol can share a handler (e.g. dsh reuses CB's handleChatCompletions)
7. **Injection Profile** — define the injection template according to the client's system prompt format
8. **E2E verification** — run the full pipeline to confirm session-init + injection + archiving work correctly

👉 **For the complete adaptation steps (20-item checklist + 8 categories of pitfalls quick reference + dsh reference implementation) see [`adapter-agent-development.md`](./adapter-agent-development.md)**.
