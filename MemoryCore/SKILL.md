---
name: openclaw-memory-tencentdb-setup
description: Install, configure, and verify the @tencentdb-agent-memory/memory-tencentdb plugin in an OpenClaw environment. Trigger when the user mentions "install the memory plugin", "configure memory-tencentdb", "enable long-term memory/recall", or when related errors appear.
version: 1.0.0
---

## Purpose

Without relying on an external hosted memory service, provide OpenClaw with sustainable local long-term memory (L0→L1→L2→L3), completing a one-shot closed loop from installation and configuration to acceptance.

## When to Use

- The user asks to install or enable `memory-tencentdb` in OpenClaw
- The user needs to configure recall, extraction, persona, cleanup, and other parameters
- The user reports "the plugin is installed but there is no memory / no recall / no vector search"

## When Not to Use

- The user only needs an explanation of the memory concept, without actual deployment
- The user wants to integrate with a non-OpenClaw host (confirm the target framework first)

## Standard Workflow

### 1) Environment pre-check

First confirm that the base versions meet the requirements:

- OpenClaw: `>= 2026.3.13`
- Node.js: `>= 22.16.0`

Run:

```bash
openclaw --version
node -v
```

If the versions do not meet the requirements, upgrade first and then continue.

### 2) Install the plugin

Run the install command:

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
```

If already installed, run the update:

```bash
openclaw plugins update memory-tencentdb
```

### 3) Write the minimal config

Edit `~/.openclaw/openclaw.json` and make sure the following exists:

```json
{
  "memory-tencentdb": {
    "enabled": true
  }
}
```

Note: the plugin supports zero-config startup; basic capabilities run even without adding other fields.

### 4) Add recommended config as needed (common in production)

Add the following groups according to user needs:

- `capture`: conversation capture and retention policy
- `extraction`: L1 extraction and dedup
- `pipeline`: L1→L2→L3 scheduling
- `recall`: recall count, threshold, strategy
- `persona`: scene and persona trigger parameters
- `embedding`: vector retrieval config (remote OpenAI-compatible)

Recommended template:

```json
{
  "memory-tencentdb": {
    "capture": {
      "enabled": true,
      "excludeAgents": [],
      "l0l1RetentionDays": 90,
      "cleanTime": "03:00"
    },
    "extraction": {
      "enabled": true,
      "enableDedup": true,
      "maxMemoriesPerSession": 10,
      "model": "provider/model"
    },
    "pipeline": {
      "everyNConversations": 5,
      "enableWarmup": true,
      "l1IdleTimeoutSeconds": 600,
      "l2DelayAfterL1Seconds": 10,
      "l2MinIntervalSeconds": 900,
      "l2MaxIntervalSeconds": 3600,
      "sessionActiveWindowHours": 24
    },
    "recall": {
      "enabled": true,
      "maxResults": 5,
      "scoreThreshold": 0.3,
      "strategy": "hybrid"
    },
    "persona": {
      "triggerEveryN": 50,
      "maxScenes": 15,
      "backupCount": 3,
      "sceneBackupCount": 10,
      "model": "provider/model"
    },
    "embedding": {
      "enabled": true,
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${EMBEDDING_API_KEY}",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "conflictRecallTopK": 5
    }
  }
}
```

### 5) Key config rules (avoid silent failures)

- When `embedding.provider = "none"`, vector capability is disabled and only the keyword path remains.
- If a remote `provider` is configured (such as `openai` / `deepseek`), all of the following must also be provided:
  - `apiKey`
  - `baseUrl`
  - `model`
  - `dimensions`
- If any of the above is missing, the plugin keeps running but automatically degrades to non-vector mode.
- `l0l1RetentionDays`:
  - `0` means no cleanup
  - When non-`0`, `>=3` is recommended
  - If set to `1~2`, `allowAggressiveCleanup` must be explicitly enabled

### 6) Restart and verify it takes effect

Run:

```bash
openclaw gateway restart
```

Check items:

- The `[memory-tdai]` prefix appears in the Gateway log
- The data directory has been created: `~/.openclaw/state/memory-tdai/`
- It contains at least: `conversations/`, `records/`, `scene_blocks/`, `vectors.db`

### 7) Functional smoke test

Run a minimal conversation loop and verify:

1. Hold 2~3 rounds of conversation, providing memorable information (preferences, constraints, background).
2. Start a new conversation round and observe whether recalled context is injected.
3. In the Agent, call:
   - `tdai_memory_search`
   - `tdai_conversation_search`
4. Confirm that the content just produced can be retrieved.

## Troubleshooting Quick Reference

- Plugin has no logs: check whether `memory-tencentdb.enabled` in `openclaw.json` is `true`, and confirm the Gateway has been restarted.
- Records exist but no recall: check whether `recall.enabled` and `scoreThreshold` are too high.
- No vector results: check whether the `embedding` four-tuple (`apiKey/baseUrl/model/dimensions`) is complete.
- Cleanup too aggressive leaving too little history: check `l0l1RetentionDays` and `allowAggressiveCleanup`.
- Config changed but behavior unchanged: confirm that you modified `~/.openclaw/openclaw.json`, and restart the Gateway again.

## Security and Compliance Constraints

- Treat `apiKey` as sensitive information; do not spread it in plaintext in chats, logs, or screenshots.
- Prefer injecting secrets via environment variables; keep only placeholders in config examples.
- Only modify the config section corresponding to `memory-tencentdb`, to avoid overwriting the user's other plugin configs.

## Definition of Done

Before finishing the task, all of the following must be met:

- The plugin install/update command succeeded
- A valid `memory-tencentdb` config exists in `openclaw.json`
- The Gateway has been restarted
- The `[memory-tdai]` log is visible
- The data directory and key files have been generated
- At least 1 retrieval tool call returned results successfully

## Delivery Message Template

After completion, you may output to the user:

- Installation and configuration of `memory-tencentdb` is complete, and the Gateway has been restarted.
- Logs and the data directory have been verified as in effect; the memory pipeline is usable.
- For further optimization, continue tuning `recall.scoreThreshold`, `pipeline.everyNConversations`, `persona.triggerEveryN`, and `embedding` model parameters.