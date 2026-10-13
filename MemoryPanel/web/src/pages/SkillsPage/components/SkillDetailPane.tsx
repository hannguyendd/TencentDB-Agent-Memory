/**
 * SkillDetailPane -- right column of SkillsPanel, showing a single skill's frontmatter, body
 * Markdown and resource file tree; the owner can also edit in place here.
 *
 * Editing capability (only open when canEdit=owner; all write operations carry an expected_version optimistic lock):
 *   - Body: edit the full SKILL.md (updateSkill)
 *   - Resource files: create / edit / delete (writeSkillFiles / removeSkillFiles)
 *   - Version history: load on demand and view any historical version read-only (listSkillVersions + getSkill@version)
 *
 * After any write operation succeeds, version is incremented by 1, so reload() is called uniformly to re-fetch details and notify the parent to refresh the list,
 * ensuring the expected_version carried by the next edit is the latest value.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Card, Copy, Input, Modal, Table, Text } from 'tea-component';
import { MarkdownView } from '@/components/MarkdownView';
import { tea } from '@/lib/tea-bridge';
import {
  getSkill,
  readSkillFile,
  updateSkill,
  writeSkillFiles,
  removeSkillFiles,
  listSkillVersions,
  type SkillDetail,
  type SkillSummary,
  type ReadFileResult,
} from '@/lib/api/skill-api';
import '../styles/skill-detail.css';

interface FileTreeNode {
  name: string;
  fullPath: string | null; // null for directories
  children: FileTreeNode[];
}

/**
 * Build a tree from an array of "scripts/foo.sh" / "templates/x/y.txt" paths.
 * Sorts directories before files at each level for stable layout.
 */
function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', fullPath: null, children: [] };
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const segName = parts[i];
      let child = cursor.children.find((c) => c.name === segName);
      if (!child) {
        child = {
          name: segName,
          fullPath: isLeaf ? p : null,
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }
  // Sort: dirs first, then files; alphabetical within each group.
  const sortRec = (node: FileTreeNode): void => {
    node.children.sort((a, b) => {
      const aDir = a.fullPath === null;
      const bDir = b.fullPath === null;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function FileTreeView(props: { nodes: FileTreeNode[]; onPick: (path: string) => void }) {
  // Indentation relies on the fixed padding of nested ul (see css); no dynamic inline style is written on li.
  return (
    <ul className="_memory-skill-filetree">
      {props.nodes.map((n) => (
        <li key={n.name}>
          {n.fullPath ? (
            <button
              type="button"
              onClick={() => props.onPick(n.fullPath!)}
              className="_memory-skill-file-btn"
            >
              {n.name}
            </button>
          ) : (
            <>
              <div className="_memory-skill-dir">{n.name}/</div>
              <FileTreeView nodes={n.children} onPick={props.onPick} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function SkillDetailPane(props: {
  /** Currently selected skill_id -- the authoritative selection identifier, coming directly from selectedSkillId (an independent state),
   *  not derived via the list, so it is unaffected by the timing of agent/skill list loading or refreshing. */
  skillId?: string;
  /** Known skill name from the list (used as the title); may be null temporarily while the list hasn't finished loading, falling back to view.name once details return */
  skillName: string | null;
  /** Current team (write operation input); falls back to the team_id in the details when absent */
  teamId?: string;
  /** Current logged-in user id (write operation input user_id) */
  userId?: string;
  /** Whether the current user can edit this skill (owner); when false all edit entry points are hidden */
  canEdit?: boolean;
  /** Callback to the parent to refresh the list after a successful edit (version/time changed) */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<SkillDetail | null>(null);
  // Initially true: when there is a skillId the first frame is already in "loading", avoiding a blank frame flash before the loading state on first entry
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<ReadFileResult | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  // Body edit state
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');
  const [savingBody, setSavingBody] = useState(false);

  // File edit state (inside the preview Modal)
  const [fileEditing, setFileEditing] = useState(false);
  const [fileDraft, setFileDraft] = useState('');
  const [fileSaving, setFileSaving] = useState(false);

  // Create-file Modal
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [newFileSaving, setNewFileSaving] = useState(false);

  // Version history
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<SkillSummary[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionView, setVersionView] = useState<SkillDetail | null>(null);
  const [versionViewLoading, setVersionViewLoading] = useState(false);
  // File preview inside the historical version view Modal
  const [versionFile, setVersionFile] = useState<ReadFileResult | null>(null);
  const [versionFileLoading, setVersionFileLoading] = useState(false);

  const stickyRef = useRef<{ id: string; name: string } | null>(null);
  if (props.skillId && props.skillName) {
    stickyRef.current = { id: props.skillId, name: props.skillName };
  }
  const skillId = props.skillId ?? stickyRef.current?.id ?? '';
  const skillName = props.skillName ?? stickyRef.current?.name ?? null;
  const canEdit = !!props.canEdit;

  const loadDetail = useCallback(() => {
    if (!skillId) {
      setView(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getSkill({ skill_id: skillId, include_content: true, include_manifest: true })
      .then((v) => setView(v))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [skillId]);

  useEffect(() => {
    // On switching skill, reset all edit/version state to avoid leftover drafts from the previous one
    setView(null);
    setEditingBody(false);
    setVersions(null);
    setShowVersions(false);
    setVersionView(null);
    setVersionFile(null);
    setFilePreview(null);
    loadDetail();
  }, [loadDetail]);

  // view is cleared at switch time; during render first verify ownership by skill_id: if it doesn't belong to the current skillId,
  // treat it as "not yet loaded", avoiding a flash of the previous skill's body / description on switching.
  const stale = !!view && view.skill_id !== skillId;
  const currentView = stale ? null : view;
  const showLoading = !!skillId && (loading || stale);

  const fileTree = useMemo(
    () => buildFileTree(currentView?.manifest?.map((e) => e.path) ?? []),
    [currentView],
  );

  // Unified write operation inputs: team_id prefers props, falls back to details; agent_id = owner_agent_id
  const writeCtx = useMemo(() => {
    if (!currentView) return null;
    const teamId = props.teamId || currentView.team_id;
    const agentId = currentView.owner_agent_id;
    if (!teamId || !agentId || !props.userId) return null;
    return { user_id: props.userId, team_id: teamId, agent_id: agentId };
  }, [currentView, props.teamId, props.userId]);

  const editable = canEdit && !!writeCtx;

  // After a successful write: re-fetch details to get the latest version, and notify the parent to refresh the list
  const reload = useCallback(() => {
    loadDetail();
    props.onChanged?.();
  }, [loadDetail, props]);

  async function pickFile(path: string): Promise<void> {
    if (!skillId) return;
    setFileEditing(false);
    setFilePreviewLoading(true);
    try {
      const f = await readSkillFile({ skill_id: skillId, path, encoding: 'utf-8' });
      setFilePreview(f);
    } catch (err) {
      setFilePreview({
        path,
        content: t('skills.detail.readFailed', {
          msg: err instanceof Error ? err.message : String(err),
        }),
        encoding: 'utf-8',
        size_bytes: 0,
        mime_type: 'text/plain',
        version: 0,
      });
    } finally {
      setFilePreviewLoading(false);
    }
  }

  // ── Body editing ──
  function startEditBody() {
    if (!currentView) return;
    setBodyDraft(currentView.content);
    setEditingBody(true);
  }

  async function saveBody() {
    if (!currentView || !writeCtx) return;
    if (!bodyDraft.trim()) {
      tea.notify.error({ description: t('skills.detail.emptyContent') });
      return;
    }
    setSavingBody(true);
    try {
      await updateSkill({
        ...writeCtx,
        skill_id: currentView.skill_id,
        expected_version: currentView.version,
        content: bodyDraft,
      });
      tea.notify.success(t('skills.detail.saveSuccess'));
      setEditingBody(false);
      reload();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSavingBody(false);
    }
  }

  // ── File editing (inside the preview Modal) ──
  function startEditFile() {
    if (!filePreview) return;
    setFileDraft(filePreview.content);
    setFileEditing(true);
  }

  async function saveFile() {
    if (!currentView || !writeCtx || !filePreview) return;
    setFileSaving(true);
    try {
      await writeSkillFiles({
        ...writeCtx,
        skill_id: currentView.skill_id,
        expected_version: currentView.version,
        files: [{ path: filePreview.path, content: fileDraft, encoding: 'utf-8' }],
      });
      tea.notify.success(t('skills.detail.fileSaved'));
      setFilePreview({ ...filePreview, content: fileDraft });
      setFileEditing(false);
      reload();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setFileSaving(false);
    }
  }

  async function deleteFile(path: string) {
    if (!currentView || !writeCtx) return;
    const ok = await tea.confirm({
      message: t('skills.detail.deleteFileConfirm', { path }),
      description: t('skills.detail.deleteFileDesc'),
      okText: t('skills.detail.deleteFileOk'),
      cancelText: t('skills.detail.deleteFileCancel'),
    });
    if (!ok) return;
    try {
      await removeSkillFiles({
        ...writeCtx,
        skill_id: currentView.skill_id,
        expected_version: currentView.version,
        paths: [path],
      });
      tea.notify.success(t('skills.detail.fileDeleted'));
      setFilePreview(null);
      reload();
    } catch (err) {
      tea.notify.error(err);
    }
  }

  // ── Create file ──
  async function createFile() {
    if (!currentView || !writeCtx) return;
    if (!newFilePath.trim()) {
      tea.notify.error({ description: t('skills.detail.filePathRequired') });
      return;
    }
    setNewFileSaving(true);
    try {
      await writeSkillFiles({
        ...writeCtx,
        skill_id: currentView.skill_id,
        expected_version: currentView.version,
        files: [{ path: newFilePath.trim(), content: newFileContent, encoding: 'utf-8' }],
      });
      tea.notify.success(t('skills.detail.fileSaved'));
      setShowNewFile(false);
      setNewFilePath('');
      setNewFileContent('');
      reload();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setNewFileSaving(false);
    }
  }

  // ── Version history ──
  async function loadVersions() {
    if (!currentView) return;
    setVersionsLoading(true);
    try {
      const res = await listSkillVersions({
        skill_id: currentView.skill_id,
        team_id: props.teamId || currentView.team_id,
      });
      setVersions(res.items);
    } catch (err) {
      tea.notify.error(err);
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }

  async function viewVersion(version: number) {
    if (!currentView) return;
    setVersionViewLoading(true);
    try {
      const v = await getSkill({
        skill_id: currentView.skill_id,
        team_id: props.teamId || currentView.team_id,
        version,
        include_content: true,
        include_manifest: true,
      });
      setVersionView(v);
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setVersionViewLoading(false);
    }
  }

  // File preview inside the historical version view Modal (read-only, reading historical file content by version)
  async function viewVersionFile(path: string) {
    if (!versionView) return;
    setVersionFileLoading(true);
    setVersionFile({
      path,
      content: '',
      encoding: 'utf-8',
      size_bytes: 0,
      mime_type: 'text/plain',
      version: versionView.version,
    });
    try {
      const f = await readSkillFile({
        skill_id: versionView.skill_id,
        path,
        version: versionView.version,
        encoding: 'utf-8',
      });
      setVersionFile(f);
    } catch (err) {
      setVersionFile({
        path,
        content: t('skills.detail.readFailed', {
          msg: err instanceof Error ? err.message : String(err),
        }),
        encoding: 'utf-8',
        size_bytes: 0,
        mime_type: 'text/plain',
        version: versionView.version,
      });
    } finally {
      setVersionFileLoading(false);
    }
  }

  if (!skillName) {
    return (
      <Card className="_memory-skill-detail-card">
        <Card.Body className="_memory-skill-detail-empty">
          <Text theme="weak">{t('skills.detail.empty')}</Text>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card className="_memory-skill-detail-card">
      <Card.Body className="_memory-skill-detail-body">
        {/* Fixed floating header: skill name + description + action bar (does not scroll with content, so users don't have to scroll far to reach features) */}
        <div className="_memory-skill-detail-head">
          <div className="_memory-skill-detail-head-main">
            <div className="_memory-skill-detail-head-info">
              <div className="_memory-skill-detail-name">{skillName ?? currentView?.name ?? ''}</div>
              {/* skill_id (= asset_id): gives a copyable asset identifier, for referencing when integrating with the API /
                  troubleshooting. Use skillId (the authoritative selection) rather than currentView,
                  so it can show immediately even while details are still loading. */}
              {skillId && (
                <div className="_memory-skill-detail-id">
                  <span className="_memory-skill-detail-id-text" title={skillId}>
                    {skillId}
                  </span>
                  <Copy text={skillId} />
                </div>
              )}
              {currentView?.description && (
                <Text theme="weak" parent="div" className="_memory-skill-detail-desc">
                  {currentView.description}
                </Text>
              )}
            </div>
            {currentView && (
              <div className="_memory-skill-detail-actions">
                {editable && !editingBody && (
                  <Button type="primary" onClick={startEditBody}>
                    {t('skills.detail.edit')}
                  </Button>
                )}
                {editable && (
                  <Button onClick={() => setShowNewFile(true)}>{t('skills.detail.addFile')}</Button>
                )}
                <Button
                  onClick={() => {
                    setShowVersions(true);
                    if (versions === null) void loadVersions();
                  }}
                >
                  {t('skills.detail.versions')}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Scrolling content area. During refresh (reload after an edit/create save, when currentView is still present)
            overlay a semi-transparent mask + loading to give clear loading feedback; on first load (no currentView) show plain loading text. */}
        <div
          className={`_memory-skill-detail-scroll${showLoading && currentView ? ' _memory-skill-detail-scroll--refreshing' : ''}`}
        >
          {showLoading && currentView && (
            <div className="_memory-skill-detail-refresh-mask">
              <Text theme="weak">{t('skills.detail.loading')}</Text>
            </div>
          )}
          {!stale && error && (
            <Text theme="danger" parent="div" className="_memory-skill-detail-error">
              {error}
            </Text>
          )}
          {showLoading && !currentView && (
            <Text theme="weak" parent="div">
              {t('skills.detail.loading')}
            </Text>
          )}
          {currentView && (
            <>
              {/* Metadata */}
              <div className="_memory-skill-detail-section">
                <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
                  {t('skills.detail.frontmatter')}
                </Text>
                <pre className="_memory-skill-detail-json">
                  {JSON.stringify(
                    {
                      name: currentView.name,
                      description: currentView.description,
                      version: currentView.version,
                      owner_user_id: currentView.owner_user_id,
                      owner_agent_id: currentView.owner_agent_id,
                      created_at_ms: currentView.created_at_ms,
                      updated_at_ms: currentView.updated_at_ms,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>

              {/* Body (the full SKILL.md can be edited; the edit entry is in the top fixed action bar) */}
              <div className="_memory-skill-detail-section">
                <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
                  {t('skills.detail.body')}
                </Text>
                {editingBody ? (
                  <div className="_memory-skill-edit-box">
                    <Input.TextArea
                      size="full"
                      className="_memory-skill-edit-textarea"
                      value={bodyDraft}
                      onChange={(v) => setBodyDraft(v)}
                      disabled={savingBody}
                    />
                    <Text theme="weak" parent="div" className="_memory-skill-edit-hint">
                      {t('skills.detail.editBodyHint')}
                    </Text>
                    <div className="_memory-skill-edit-actions">
                      <Button type="primary" onClick={saveBody} loading={savingBody}>
                        {t('skills.detail.save')}
                      </Button>
                      <Button onClick={() => setEditingBody(false)} disabled={savingBody}>
                        {t('skills.detail.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <MarkdownView>{extractBody(currentView.content)}</MarkdownView>
                )}
              </div>
            </>
          )}
        </div>

        {/* Attached resources are fixed at the bottom: the middle body can scroll while attached resources are always visible, with no need to scroll to the bottom to find them.
            The create entry is in the top fixed action bar. */}
        {currentView && (
          <div className="_memory-skill-detail-footer">
            <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
              {t('skills.detail.files', { count: currentView.manifest?.length ?? 0 })}
            </Text>
            {!currentView.manifest || currentView.manifest.length === 0 ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.noFiles')}
              </Text>
            ) : (
              <div className="_memory-skill-files-box _memory-skill-files-box--footer">
                <FileTreeView nodes={fileTree} onPick={pickFile} />
              </div>
            )}
          </div>
        )}
      </Card.Body>

      {/* Inline file-preview modal (supports edit / delete) */}
      {filePreview && (
        <Modal
          visible
          caption={filePreview.path}
          size="xl"
          onClose={() => {
            setFilePreview(null);
            setFileEditing(false);
          }}
        >
          <Modal.Body>
            {filePreviewLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : filePreview.encoding === 'base64' ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.binaryFile', { size: filePreview.size_bytes })}
              </Text>
            ) : fileEditing ? (
              <Input.TextArea
                size="full"
                className="_memory-skill-edit-textarea"
                value={fileDraft}
                onChange={(v) => setFileDraft(v)}
                disabled={fileSaving}
              />
            ) : (
              <pre className="_memory-skill-file-content">{filePreview.content}</pre>
            )}
          </Modal.Body>
          {editable && !filePreviewLoading && (
            <Modal.Footer>
              {filePreview.encoding === 'base64' ? (
                <Text theme="weak">{t('skills.detail.binaryEditHint')}</Text>
              ) : fileEditing ? (
                <>
                  <Button type="primary" onClick={saveFile} loading={fileSaving}>
                    {t('skills.detail.save')}
                  </Button>
                  <Button onClick={() => setFileEditing(false)} disabled={fileSaving}>
                    {t('skills.detail.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <Button type="primary" onClick={startEditFile}>
                    {t('skills.detail.editFile')}
                  </Button>
                  <Button onClick={() => deleteFile(filePreview.path)}>
                    {t('skills.detail.deleteFile')}
                  </Button>
                </>
              )}
            </Modal.Footer>
          )}
        </Modal>
      )}

      {/* Create file Modal */}
      {showNewFile && (
        <Modal
          visible
          caption={t('skills.detail.newFileTitle')}
          size="l"
          onClose={() => setShowNewFile(false)}
        >
          <Modal.Body>
            <div className="_memory-skill-newfile-field">
              <Text theme="label" parent="div">
                {t('skills.detail.filePathLabel')}
              </Text>
              <Input
                size="full"
                value={newFilePath}
                onChange={(v) => setNewFilePath(v)}
                placeholder={t('skills.detail.filePathPlaceholder')}
                className="_memory-skill-newfile-path"
                disabled={newFileSaving}
              />
            </div>
            <div className="_memory-skill-newfile-field">
              <Text theme="label" parent="div">
                {t('skills.detail.fileContentLabel')}
              </Text>
              <Input.TextArea
                size="full"
                className="_memory-skill-edit-textarea"
                value={newFileContent}
                onChange={(v) => setNewFileContent(v)}
                disabled={newFileSaving}
              />
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button type="primary" onClick={createFile} loading={newFileSaving}>
              {t('skills.detail.save')}
            </Button>
            <Button onClick={() => setShowNewFile(false)} disabled={newFileSaving}>
              {t('skills.detail.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* Version history list Modal */}
      {showVersions && currentView && (
        <Modal
          visible
          caption={t('skills.detail.versions')}
          size="l"
          onClose={() => setShowVersions(false)}
        >
          <Modal.Body>
            {versionsLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : !versions || versions.length === 0 ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.versionsEmpty')}
              </Text>
            ) : (
              <Table
                records={versions}
                recordKey="version"
                columns={[
                  {
                    key: 'version',
                    header: t('skills.detail.versionColVersion'),
                    width: 140,
                    render: (v) => (
                      <span className="_memory-skill-version-label">
                        v{v.version}
                        {v.version === currentView.version && (
                          <span className="_memory-skill-version-current">
                            （{t('skills.detail.versionCurrent')}）
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'updated_at_ms',
                    header: t('skills.detail.versionColTime'),
                    render: (v) => new Date(v.updated_at_ms).toLocaleString(),
                  },
                  {
                    key: 'actions',
                    header: t('skills.detail.versionColActions'),
                    width: 100,
                    render: (v) => (
                      <Button type="link" onClick={() => viewVersion(v.version)}>
                        {t('skills.detail.versionView')}
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Modal.Body>
        </Modal>
      )}

      {/* Historical version view Modal (read-only: body + attached resources) */}
      {(versionView || versionViewLoading) && (
        <Modal
          visible
          caption={
            versionView
              ? t('skills.detail.versionCaption', { version: versionView.version })
              : t('skills.detail.loading')
          }
          size="xl"
          onClose={() => {
            setVersionView(null);
            setVersionFile(null);
          }}
        >
          <Modal.Body>
            {versionViewLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : versionView ? (
              <>
                <MarkdownView>{extractBody(versionView.content)}</MarkdownView>
                {/* Attached resources of this historical version (read-only) */}
                <div className="_memory-skill-detail-section _memory-skill-version-files">
                  <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
                    {t('skills.detail.files', { count: versionView.manifest?.length ?? 0 })}
                  </Text>
                  {!versionView.manifest || versionView.manifest.length === 0 ? (
                    <Text theme="weak" parent="div">
                      {t('skills.detail.noFiles')}
                    </Text>
                  ) : (
                    <div className="_memory-skill-files-box">
                      <FileTreeView
                        nodes={buildFileTree(versionView.manifest.map((e) => e.path))}
                        onPick={viewVersionFile}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </Modal.Body>
        </Modal>
      )}

      {/* Historical version file preview Modal (read-only) */}
      {(versionFile || versionFileLoading) && (
        <Modal
          visible
          caption={versionFile?.path ?? t('skills.detail.loading')}
          size="xl"
          onClose={() => setVersionFile(null)}
        >
          <Modal.Body>
            {versionFileLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : versionFile?.encoding === 'base64' ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.binaryFile', { size: versionFile.size_bytes })}
              </Text>
            ) : versionFile ? (
              <pre className="_memory-skill-file-content">{versionFile.content}</pre>
            ) : null}
          </Modal.Body>
        </Modal>
      )}
    </Card>
  );
}

/** Extract the body from SKILL.md (strip the YAML frontmatter) */
function extractBody(content: string): string {
  const m = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
  return m ? content.slice(m[0].length) : content;
}
