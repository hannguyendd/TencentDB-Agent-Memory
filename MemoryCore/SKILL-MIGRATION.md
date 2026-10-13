---
name: openclaw-memory-tencentdb-migration
description: Helps existing users migrate the OpenClaw memory plugin from the old package @tdai/memory-tdai to the new package @tencentdb-agent-memory/memory-tencentdb. Trigger when the user mentions "plugin migration", "change the memory plugin package name", "memory-tdai upgrade", "package rename", or when install errors related to the old package appear.
version: 1.0.0
---

## Purpose

Help existing users who have installed `@tdai/memory-tdai` (old package name) migrate smoothly to `@tencentdb-agent-memory/memory-tencentdb` (new package name), ensuring existing memory data is not lost and the config is fully restored.

## Background

- **Old package name**: `@tdai/memory-tdai` (plugin ID: `memory-tdai`)
- **New package name**: `@tencentdb-agent-memory/memory-tencentdb` (plugin ID: `memory-tencentdb`)
- The old and new plugins share the same data directory (`~/.openclaw/memory-tdai/`); uninstalling the old plugin **does not delete the data directory**, so existing memory data is unaffected
- Uninstalling the old plugin **deletes** the plugin's config section in `openclaw.json`, so it must be backed up beforehand

## When to Use

- The user has installed `@tdai/memory-tdai` and needs to migrate to the new package name
- The user runs `openclaw plugins install @tdai/memory-tdai` and gets 404 / not found
- The user has been told the old package is deprecated and needs to migrate

## When Not to Use

- The user has never installed a memory plugin (use the `openclaw-memory-tencentdb-setup` skill)
- The user uses another memory plugin (such as `openclaw-mem0`)

## Standard Workflow

### 1) Confirm the current state

Confirm whether the old plugin is installed:

```bash
openclaw plugins list | grep -i memory
```

Expect to see `memory-tdai` or `@tdai/memory-tdai` in the loaded state.

If the old plugin is not seen, skip the migration flow and use the `openclaw-memory-tencentdb-setup` skill directly for a fresh install.

### 2) Back up the existing config (critical step)

Uninstalling the old plugin deletes the config section in `openclaw.json`. **You must back up first**.

Run the following command to extract the old plugin config:

```bash
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
plugins = cfg.get('plugins', {}).get('entries', {})
old_cfg = plugins.get('memory-tdai', {})
if old_cfg:
    print(json.dumps(old_cfg, indent=2, ensure_ascii=False))
    with open('/tmp/memory-tdai-config-backup.json', 'w') as f:
        json.dump(old_cfg, f, indent=2, ensure_ascii=False)
    print('\n✅ Config backed up to /tmp/memory-tdai-config-backup.json')
else:
    print('⚠️ memory-tdai config section not found (default config may be in use)')
"
```

**Pay special attention to whether the following configs exist (record them if present)**:

- `embedding` config (`provider`, `baseUrl`, `apiKey`, `model`, `dimensions`, `proxyUrl`)
- `extraction.model` (model used for extraction)
- `persona.model` (model used for persona)
- `capture.excludeAgents` (list of excluded agents)
- `capture.l0l1RetentionDays` (data retention days)

### 3) Confirm the data directory exists

```bash
ls -la ~/.openclaw/memory-tdai/
```

Expect to see files such as: `conversations/`, `records/`, `scene_blocks/`, `vectors.db`, `persona.md`.

Record the current data volume as the basis for post-migration verification:

```bash
echo "=== Pre-migration data stats ==="
wc -l ~/.openclaw/memory-tdai/conversations/*.jsonl 2>/dev/null || echo "No conversation data"
wc -l ~/.openclaw/memory-tdai/records/*.jsonl 2>/dev/null || echo "No record data"
ls ~/.openclaw/memory-tdai/scene_blocks/*.md 2>/dev/null | wc -l | xargs -I{} echo "Scene blocks: {}"
wc -c ~/.openclaw/memory-tdai/persona.md 2>/dev/null || echo "No persona"
```

### 4) Uninstall the old plugin

```bash
openclaw plugins uninstall memory-tdai
```

After running, confirm:

- The `memory-tdai` config section in `openclaw.json` has been deleted (expected behavior)
- The `~/.openclaw/memory-tdai/` data directory **still exists** (it is not deleted)

```bash
# Verify the data directory is still there
ls ~/.openclaw/memory-tdai/ && echo "✅ Data directory intact" || echo "❌ Data directory lost!"
```

### 5) Install the new plugin

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
```

### 6) Restore the config

Write the config backed up in step 2 back into `openclaw.json`; note that the new plugin's config key is `memory-tencentdb`:

```bash
python3 -c "
import json, os

# Read the backup config
backup_path = '/tmp/memory-tdai-config-backup.json'
if os.path.exists(backup_path):
    with open(backup_path) as f:
        old_cfg = json.load(f)
    print('📋 Backup config contents:')
    print(json.dumps(old_cfg, indent=2, ensure_ascii=False))
else:
    old_cfg = {'enabled': True}
    print('⚠️ Backup not found, using minimal config')

# Read the current openclaw.json
config_path = os.path.expanduser('~/.openclaw/openclaw.json')
with open(config_path) as f:
    cfg = json.load(f)

# Write the new plugin config
cfg.setdefault('plugins', {}).setdefault('entries', {})['memory-tencentdb'] = old_cfg

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print('\n✅ Config written to memory-tencentdb')
"
```

If the backup is lost or the user needs to restore manually, at least make sure the minimal config is written:

```json
{
  "memory-tencentdb": {
    "enabled": true
  }
}
```

### 7) Restart the Gateway and verify

```bash
openclaw gateway restart
```

Check items:

- The `[memory-tdai]` prefix appears in the Gateway log (note: the log tag is still memory-tdai, which is normal)
- The data directory contents are unchanged

```bash
echo "=== Post-migration verification ==="
# Confirm the new plugin is loaded
openclaw plugins list | grep -i memory

# Confirm the data volume matches the pre-migration state
wc -l ~/.openclaw/memory-tdai/conversations/*.jsonl 2>/dev/null
wc -l ~/.openclaw/memory-tdai/records/*.jsonl 2>/dev/null
```

### 8) Functional smoke verification

Run one conversation to confirm the memory pipeline works:

1. Send a message containing personal information (such as preferences or habits)
2. Confirm that `[before_prompt_build]` and `[agent_end]` related output appears in the logs
3. If embedding is configured, confirm vector retrieval works (no embedding errors in the logs)

## Rollback Plan

If problems occur after migration, roll back quickly:

```bash
# 1. Uninstall the new plugin
openclaw plugins uninstall memory-tencentdb

# 2. Reinstall the old plugin (if the npm registry is still available)
openclaw plugins install @tdai/memory-tdai

# 3. Manually restore the config (from the backup)
# Write the contents of /tmp/memory-tdai-config-backup.json back into the memory-tdai section of openclaw.json

# 4. Restart
openclaw gateway restart
```

## Troubleshooting

| Symptom | Possible Cause | Solution |
|------|----------|----------|
| New plugin has no log output | `enabled` is not set to `true` in the config | Check `memory-tencentdb.enabled` in `openclaw.json` |
| Error installing the new plugin | npm registry unavailable | Check the network / npm registry config |
| No historical memory after migration | Config restoration incomplete | Compare `/tmp/memory-tdai-config-backup.json` with the current config |
| Embedding errors | `apiKey` and other configs lost | Restore the `embedding` config section from the backup |
| Data directory is empty | Abnormal deletion during uninstall (very rare) | Check whether `~/.openclaw/memory-tdai/` exists |

## Security and Compliance Constraints

- The backup file `/tmp/memory-tdai-config-backup.json` may contain `apiKey`; deleting it after migration is recommended: `rm /tmp/memory-tdai-config-backup.json`
- Do not display `apiKey` in plaintext in chats or logs
- Only modify the `memory-tencentdb` config section, without affecting the user's other plugins

## Definition of Done

Migration is complete when all of the following are met:

- [x] The old plugin `@tdai/memory-tdai` has been uninstalled
- [x] The new plugin `@tencentdb-agent-memory/memory-tencentdb` has been installed and loaded
- [x] A complete `memory-tencentdb` config exists in `openclaw.json` (including user-customized configs such as embedding)
- [x] The Gateway has been restarted
- [x] The `[memory-tdai]` prefix appears in the logs
- [x] The data directory is intact and the data volume matches the pre-migration state
- [x] At least 1 conversation verified the memory pipeline works
- [x] Sensitive information in backup files has been cleaned up

## Delivery Message Template

> Memory plugin migration complete:
> - Old plugin `@tdai/memory-tdai` → new plugin `@tencentdb-agent-memory/memory-tencentdb`
> - Existing memory data fully preserved (conversations/records/scene blocks/vector store all unaffected)
> - Config fully restored from the old plugin (including custom configs such as embedding / extraction / persona)
> - Gateway restarted, memory pipeline verified working
