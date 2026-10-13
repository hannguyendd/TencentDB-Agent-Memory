/**
 * ImportSkillDialog -- Import Skill dialog. Supports only two import methods:
 *
 *   1. Directory import (directory)
 *      The user picks a local directory, and the frontend splits the Files in it into a "main file" (SKILL.md,
 *      which must be in the root directory or under <skill-name>/) and "resource files" (all other files, keeping
 *      relative paths). It goes through v3 create to persist in one shot (including resources, a new skill is v1).
 *      The browser directory picker has no Tea component equivalent, so a native <input type="file"
 *      webkitdirectory> is kept, hidden and triggered by a Tea Button.
 *
 *   2. Conversation import (session)
 *      The user pastes a conversation with that agent (the JSON input of the skill/extract endpoint,
 *      containing a messages array). The frontend only does JSON validation + overrides the
 *      identity fields with the current context IDs, then calls extractSkills. The server-side LLM automatically distills
 *      the skill's name / description / content from the conversation and persists it directly via tool calls
 *      (through the same path as SkillCore.create/update), without review.
 *      Supports sync (returns the result directly) and async (returning a task_id counts as accepted;
 *      the user is told the expected time for results and the dialog is closed, with no blocking polling on the frontend -- the result is
 *      asynchronously deposited into that agent's skill list, which the user can see after a manual refresh later).
 *
 * Removal note: the former "paste SKILL.md text" mode has been taken offline -- directory import already covers
 * that scenario, and hand-written frontmatter by users is very error-prone (missing name/description,
 * YAML syntax errors); having directory import guide users to place SKILL.md properly is more reliable.
 */

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createSkill,
  extractSkills,
  type SkillResourcePayload,
  type ExtractParams,
} from '@/lib/api/skill-api';
import { Alert, Button, Form, Input, Modal, Segment, Select } from 'tea-component';
import { FolderOpenIcon } from 'tea-icons-react';
import i18n from '@/i18n';
import '../styles/import-skill-dialog.css';

type Mode = 'directory' | 'session';

/**
 * Read a File as base64. Used for binary/executable resources where we
 * can't safely treat bytes as utf8.
 */
async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // Browser-side base64: chunked to avoid stack-overflow on big files.
  let bin = '';
  const arr = new Uint8Array(buf);
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function readAsUtf8(file: File): Promise<string> {
  return file.text();
}

/**
 * Heuristic: extension-based + small-size = text. The gateway already
 * enforces a 5MB cap, but we want to send big binaries as base64 not
 * as a 5MB-of-mojibake string.
 */
function looksLikeText(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (/\.(md|markdown|txt|json|yaml|yml|sh|js|ts|tsx|py|go|rs|toml|html|css|csv|conf|cfg)$/.test(lower)) {
    return true;
  }
  if (file.size < 64 * 1024) return true;
  return false;
}

/**
 * Walk webkitRelativePath like "my-skill/SKILL.md" or "my-skill/files/scripts/x.sh".
 * Returns { skillName, mainFile, resources }; resource paths are
 * normalised relative to `<skill-name>/files/`.
 */
function partitionFiles(files: File[]): {
  skillName: string | null;
  mainFile: File | null;
  resources: Array<{ path: string; file: File }>;
  warning?: string;
} {
  let mainFile: File | null = null;
  let mainRelPath = '';
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const segments = rel.split('/');
    const lastSegment = segments[segments.length - 1] ?? '';
    if (lastSegment === 'SKILL.md') {
      // Prefer the shallowest SKILL.md (depth = number of segments).
      if (!mainFile || segments.length < mainRelPath.split('/').length) {
        mainFile = f;
        mainRelPath = rel;
      }
    }
  }
  if (!mainFile) {
    return {
      skillName: null,
      mainFile: null,
      resources: [],
      warning: i18n.t('importSkill.directory.warning'),
    };
  }
  const mainSegments = mainRelPath.split('/');
  const baseDir = mainSegments.slice(0, -1).join('/');
  const skillName = mainSegments.length >= 2 ? mainSegments[mainSegments.length - 2] : null;

  const resources: Array<{ path: string; file: File }> = [];
  for (const f of files) {
    if (f === mainFile) continue;
    let rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    if (baseDir && rel.startsWith(baseDir + '/')) {
      rel = rel.slice(baseDir.length + 1);
    }
    if (rel.startsWith('files/')) rel = rel.slice('files/'.length);
    if (!rel) continue;
    resources.push({ path: rel, file: f });
  }
  return { skillName, mainFile, resources };
}

export default function ImportSkillDialog(props: {
  onClose: () => void;
  onImported: () => void;
  /** Currently active team (skill ownership, required by create) */
  teamId: string;
  /** Import target: 'team' = team pool (default), 'fixed' = agent fixed assets. */
  target?: 'team' | 'fixed';
  /** Agent roster (for fixed-target agent selector). */
  agents?: Array<{ id: string; name: string }>;
  /** Pre-selected agent id (when target='fixed'). */
  agentId?: string;
  /** Current user ID (required by the v3 API) */
  userId: string;
}) {
  const [mode, setMode] = useState<Mode>('directory');
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  // session-import: the user pastes the skill/extract endpoint input (containing a messages array).
  // The server-side LLM distills the skill's name / description / content from messages by itself.
  const [sessionPayload, setSessionPayload] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(props.agentId ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const partition = useMemo(() => (mode === 'directory' ? partitionFiles(pickedFiles) : null), [
    mode,
    pickedFiles
  ]);

  async function submit(): Promise<void> {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const agentId = props.target === 'fixed' ? (selectedAgentId || props.agentId || '') : '';
      if (props.target === 'fixed' && !agentId) {
        throw new Error(t('importSkill.error.noAgent'));
      }
      if (!props.teamId) throw new Error(t('importSkill.error.noTeam'));

      // ==== Conversation import: call skill/extract directly ====
      if (mode === 'session') {
        const raw = sessionPayload.trim();
        if (!raw) throw new Error(t('importSkill.error.noPayload'));
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          throw new Error(t('importSkill.error.jsonParse', { msg: e instanceof Error ? e.message : String(e) }));
        }
        if (!Array.isArray((parsed as { messages?: unknown }).messages)) {
          throw new Error(t('importSkill.error.noMessages'));
        }
        const msgs = (parsed as { messages: unknown[] }).messages;
        if (msgs.length === 0) {
          throw new Error(t('importSkill.error.emptyMessages'));
        }
        // The backend extract endpoint limits messages to at most 500 (see iWiki §3.13),
        if (msgs.length > 500) {
          throw new Error(t('importSkill.error.tooManyMessages', { count: msgs.length }));
        }

        // Assemble the extract input. Identity fields (user_id/team_id/agent_id) are forcibly overridden with the current UI
        // context, to avoid users pasting the wrong team / forging another's identity -- see <security_rules> §3.
        // space_id need not be passed explicitly: consistent with other skill endpoints, the backend takes it from the X-Tdai-Service-Id
        // header (= panelSession.instanceId). session_id / task_id are not passed either,
        // letting the backend generate them -- avoiding frontend hard-coded "default" / "import-${Date.now()}" polluting the archive path.
        // The extract endpoint itself does not accept name/description fields (the skill name and description are distilled by the LLM
        // from messages), so even if the JSON carries these two fields they are not passed through to the server.
        const extractParams: ExtractParams = {
          user_id: props.userId,
          team_id: props.teamId,
          agent_id: agentId || props.userId,
          task_id: typeof parsed.task_id === 'string' && parsed.task_id ? parsed.task_id : undefined,
          session_id:
            typeof parsed.session_id === 'string' && parsed.session_id
              ? parsed.session_id
              : undefined,
          messages: parsed.messages as ExtractParams['messages'],
          reason:
            typeof parsed.reason === 'string' && parsed.reason
              ? parsed.reason
              : 'manual import from console',
          options:
            typeof parsed.options === 'object' && parsed.options !== null
              ? (parsed.options as ExtractParams['options'])
              : undefined,
        };

        // The backend extract always goes through the archive -> agent queue -> worker async chain,
        // and always returns a task_id (there is no sync candidates branch any more). Once the frontend gets the task_id it
        // treats it as "accepted", tells the user the expected time for results, and closes the dialog; the result is written asynchronously
        // into the skill table by SkillCoreSink, and the user can see it after refreshing the list.
        //
        // Frontend soft-timeout fallback (5s): the archive chain involves sequential COS reads/writes (read _tasks.json ->
        // write data-xxx.jsonl -> write _tasks.json), and when COS is slow the overall time easily exceeds
        // the Panel backend's 15s hard timeout (KERNEL_TIMEOUT/504), falsely reporting failure in the UI.
        // In fact the request is already queued on the server, and the backend will finish the archive. So here
        // if the backend responds within 5s, the real result is used; if 5s elapse with no reply, the "accepted" text is shown directly,
        // no longer blocking the user -- the backend call keeps running at the browser fetch layer (no abort); in the worst
        // case the Panel returns 504 after 15s, and our catch silently swallows it (the user has already seen success).
        const TIMEOUT_MS = 5000;
        let softTimedOut = false;
        const extractPromise = extractSkills(extractParams).catch((e) => {
          // If the soft timeout has already shown the success text, subsequent errors (504, etc.) are silently swallowed here.
          if (softTimedOut) return null;
          throw e;
        });
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), TIMEOUT_MS),
        );
        const raced = await Promise.race([extractPromise, timeoutPromise]);
        if (raced === 'timeout') {
          softTimedOut = true;
          setResult(t('importSkill.result.session.accepted'));
        } else if (raced) {
          setResult(t('importSkill.result.session', { taskId: raced.task_id }));
        } else {
          // The branch where extractPromise is caught as null after the soft timeout (normally not reached here,
          // since the soft timeout has already set result first), the fallback keeps the same text.
          setResult(t('importSkill.result.session.accepted'));
        }
        setTimeout(() => props.onImported(), 1500);
        return;
      }

      // ==== Directory import: go through v3 create + files/write ====
      if (!partition?.mainFile) {
        throw new Error(partition?.warning ?? t('importSkill.error.noMainFile'));
      }
      const content = await readAsUtf8(partition.mainFile);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const nameMatch = fmMatch?.[1].match(/^name:\s*(.+)$/m);
      const name = nameMatch?.[1].trim().replace(/^["']|["']$/g, '') || partition.skillName || '';
      if (!name) {
        throw new Error(t('importSkill.error.noName'));
      }
      const resourceFiles: { path: string; file: File; isBinary: boolean }[] = partition.resources.map(
        ({ path, file }) => ({ path, file, isBinary: !looksLikeText(file) }),
      );

      // Ensure content starts with `---\n` (required by the v3 frontmatter format).
      const safeContent = content.trimStart().startsWith('---') ? content : `---\nname: ${name}\n---\n\n${content}`;

      // Resource files are persisted in one shot with create (single version v1).
      // Fix: the original implementation was create(resources=[] -> v1) + files/write(-> v2) in two steps,
      // so any imported skill with resources was already v2 once persisted (version semantics were muddled).
      // v3 create itself supports a resources array; merging into one call guarantees a new skill = v1.
      const resources: SkillResourcePayload[] = resourceFiles.length > 0
        ? await Promise.all(
            resourceFiles.map(async ({ path, file, isBinary }) =>
              isBinary
                ? { path, content: await readAsBase64(file), encoding: 'base64' as const }
                : { path, content: await readAsUtf8(file), encoding: 'utf-8' as const },
            ),
          )
        : [];

      await createSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: agentId || props.userId, // v3 requires agent_id: in fixed mode use the selected one, otherwise fall back to userId
        name,
        content: safeContent,
        resources: resources.length ? resources : undefined,
      });

      setResult(t('importSkill.result.directory', { name, count: resourceFiles.length }));
      setTimeout(() => props.onImported(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Whether to show the "Owner Agent" selector in the dialog:
  //   - only fixed-target has the agent ownership concept
  //   - the dropdown can render only if agents was passed
  const showAgentPicker = props.target === 'fixed' && !!props.agents;

  return (
    <Modal visible caption={t('importSkill.caption')} size="l" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">{t('importSkill.hint')}</Alert>
      {/* Owner Agent -- required. Always shown above the import method,
          consistent with ChatMemoryPanel.ImportBlockDialog: even if the outer layer already passed agentId,
          reselecting in the dialog is allowed. */}
      {showAgentPicker && (
        <Form layout="vertical" style={{ width: '100%' }}>
          <Form.Item
            label={t('importSkill.agent')}
            extra={t('importSkill.agent.extra')}
          >
            {props.agents!.length === 0 ? (
              <Alert type="warning">{t('importSkill.agent.noAgent')}</Alert>
            ) : (
              <Select
                size="full"
                value={selectedAgentId}
                onChange={setSelectedAgentId}
                placeholder={t('importSkill.agent.placeholder')}
                options={props.agents!.map((a) => ({ value: a.id, text: `${a.name}（${a.id}）` }))}
              />
            )}
          </Form.Item>
        </Form>
      )}

      {/* Mode tabs: keep only directory (directory import) / session (conversation import) */}
      <Segment
        className="_memory-isd-mode-segment"
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        options={[
          { value: 'directory', text: t('importSkill.mode.directory') },
          { value: 'session', text: t('importSkill.mode.session') },
        ]}
      />

      {mode === 'directory' && (
        <div className="_memory-isd-section">
          <div className="_memory-isd-label">{t('importSkill.directory.label')}</div>
          {/*
            The directory picker has no Tea component equivalent, so the native input is kept as the sole exemption, hidden and triggered by the Tea
            Button below. webkitdirectory/directory are non-standard but widely supported browser
            attributes not covered by React's type definitions, so they are passed through via spread + any rather than per-attribute @ts-expect-error.
          */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              setPickedFiles(Array.from(list));
            }}
            className="_memory-isd-hidden-file-input"
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          />
          <Button onClick={() => fileInputRef.current?.click()}>
            <FolderOpenIcon size={14} /> {t('importSkill.directory.selectFile')}
          </Button>
          {pickedFiles.length > 0 && (
            <span className="_memory-isd-picked-count">{t('importSkill.directory.picked', { count: pickedFiles.length })}</span>
          )}
          {pickedFiles.length > 0 && partition && (
            <div className="_memory-isd-partition-box">
              <div>
                {t('importSkill.directory.mainFile')}
                {partition.mainFile ? (
                  <span className="_memory-isd-main-file">
                    {partition.mainFile.webkitRelativePath || partition.mainFile.name}
                  </span>
                ) : (
                  <span className="_memory-isd-error-text">{t('importSkill.directory.noSkillMd')}</span>
                )}
              </div>
              <div>{t('importSkill.directory.resources', { count: partition.resources.length })}</div>
              {partition.resources.length > 0 && (
                <ul className="_memory-isd-resource-list">
                  {partition.resources.map((r) => (
                    <li key={r.path}>· {r.path} ({Math.round(r.file.size / 1024)}KB)</li>
                  ))}
                </ul>
              )}
              {partition.warning && (
                <div className="_memory-isd-warning-text">{partition.warning}</div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'session' && (
        <div className="_memory-isd-section">
          <Alert type="info">
            {t('importSkill.session.hintPrefix')}
            <span className="_memory-isd-mono-inline">messages</span>
            {t('importSkill.session.hintSuffix')}
          </Alert>
          <Form layout="vertical" style={{ width: '100%' }}>
            <Form.Item label={t('importSkill.session.label')}>
              <Input.TextArea
                size="full"
                value={sessionPayload}
                onChange={setSessionPayload}
                rows={16}
                placeholder={JSON.stringify(
                  {
                    session_id: 'demo-user-extract-demo-1',
                    task_id: 'default',
                    messages: [
                      { role: 'user', content: t('importSkill.sample.user') },
                      { role: 'assistant', content: t('importSkill.sample.assistant') },
                      { role: 'tool_call', content: t('importSkill.sample.toolCall') },
                      { role: 'tool_result', content: t('importSkill.sample.toolResult') },
                      { role: 'assistant', content: t('importSkill.sample.assistant2') },
                    ],
                  },
                  null,
                  2,
                )}
                className="_memory-isd-mono-input"
              />
            </Form.Item>
          </Form>
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}
      {result && <Alert type="success"><span className="_memory-isd-result-text">{result}</span></Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          onClick={() => void submit()}
          disabled={
            submitting
            || (mode === 'directory' ? !partition?.mainFile : !sessionPayload.trim())
            || (props.target === 'fixed' && !selectedAgentId)
          }
          title={props.target === 'fixed' && !selectedAgentId ? t('importSkill.error.noAgentHint') : ''}
          loading={submitting}
        >
          {mode === 'session' ? t('importSkill.session.submit') : t('importSkill.submit')}
        </Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('importSkill.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
