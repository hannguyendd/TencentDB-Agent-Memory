/**
 * Local file storage for the default Agent template (stored locally in Panel).
 *
 * Path: {dir}/{instanceId}/{team_id}/template.json
 * - writes are overwrite-style upsert (JSON with 2-space indentation);
 * - a read with ENOENT returns null (no template).
 * - team_id is guarded against path traversal.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentTemplateAssetIds {
  skills?: string[];
  code_graphs?: string[];
  wikis?: string[];
}

/** Template config (= JSON file content, aligned with the agent/create input). */
export interface AgentTemplateConfig {
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: string;
  metadata_json?: string;
  asset_ids?: AgentTemplateAssetIds;
}

function templateFilePath(dir: string, instanceId: string, teamId: string): string {
  if (/[/\\]|\.\./.test(teamId)) {
    throw new Error(`invalid team_id for template path: ${teamId}`);
  }
  return path.join(dir, instanceId, teamId, 'template.json');
}

export function saveAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
  config: AgentTemplateConfig,
): void {
  const filePath = templateFilePath(dir, instanceId, teamId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

export function getAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
): AgentTemplateConfig | null {
  const filePath = templateFilePath(dir, instanceId, teamId);
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as AgentTemplateConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}
