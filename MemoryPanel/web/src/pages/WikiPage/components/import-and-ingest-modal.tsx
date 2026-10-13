/**
 * ImportAndIngestModal -- the single import entry after the 2026-09-21 design merge.
 *
 * Replaces the original "Add" + "Ingest" two buttons in the detail page top bar:
 *   - One Modal hosts the tabs (file / markdown / external);
 *   - There is **only one** primary button at the bottom, whose text changes with the current tab and input:
 *       file / markdown with input -> "Upload and extract"
 *       external with pages checked    -> "Import and extract"
 *       no input at all              -> "Re-extract"
 *   - The loading text is uniformly "Processing..." (no distinction between cancel/upload/extract phases);
 *   - Interrupting an old task is the backend logic of onBusy:'replace'; the UI shows no hint and no Alert;
 *   - No secondary button (the two-phase "add materials only" capability is no longer kept).
 *
 * The external tab fully reuses the external-source flow of the original "Add" Modal (design section 4.3 "structure reuse"):
 * choose Provider -> fill credentials -> fill source address -> choose traversal strategy -> fetch document tree -> check pages;
 * state and actions (fetchWikiTree / ensureCredential etc.) all come from useWikiSources,
 * and are initialized by wiki-detail-view via openAddDocExternal when opening the Modal.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Modal, Select, TabPanel, Tabs, Text } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { AttachIcon } from 'tea-icons-react';
import { WIKI_ALLOWED_FILE_RE } from '../constants/wiki-constants';
import { WikiSourcePageTree } from './wiki-source-page-tree';
import type {
  SourceProviderFormField,
  SourceProviderMeta,
  WikiSourceListResult,
} from '@/lib/api/knowledge-api';

export type ImportMode = 'files' | 'markdown' | 'external' | 'reingest';

export interface ImportSubmitPayload {
  mode: ImportMode;
  files?: { filename: string; content: string }[];
  markdown?: { filename: string; content: string }[];
  source_url?: string;
  provider_id?: string;
  page_ids?: string[];
}

interface ExternalFlowProps {
  sourceProviders: SourceProviderMeta[];
  formSourceType: string;
  setFormSourceType: (v: string) => void;
  formCredential: Record<string, string>;
  setCredentialField: (name: string, v: string) => void;
  credConfigured: boolean;
  savingCred: boolean;
  fetchingTree: boolean;
  formSourceUrl: string;
  setFormSourceUrl: (v: string) => void;
  crawlMode: 'tree' | 'links';
  setCrawlMode: (v: 'tree' | 'links') => void;
  treeResult: WikiSourceListResult | null;
  selectedPageIds: string[];
  setSelectedPageIds: (v: string[]) => void;
  onFetchTree: () => void;
}

interface Props {
  visible: boolean;
  /** External source type (iWiki etc.); when set, only the external tab is shown. */
  sourceType?: string | null;
  submitting: boolean;
  external?: ExternalFlowProps;
  onClose: () => void;
  onSubmit: (payload: ImportSubmitPayload) => void | Promise<void>;
}

/** Primary button text: made semantic by tab (design section 2). */
function primaryLabel(mode: ImportMode, hasInput: boolean, t: (k: string) => string): string {
  if (!hasInput) return t('wiki.import.reingest');
  if (mode === 'external') return t('wiki.import.importAndIngest');
  return t('wiki.import.uploadAndIngest');
}

export function ImportAndIngestModal({
  visible,
  sourceType,
  submitting,
  external,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const isExternal = !!sourceType && !!external;
  const [tab, setTab] = useState<'file' | 'markdown' | 'external'>(
    isExternal ? 'external' : 'file',
  );
  const [files, setFiles] = useState<File[]>([]);
  const [mdFilename, setMdFilename] = useState('');
  const [mdContent, setMdContent] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset manual input on open (external state is initialized by openAddDocExternal on open)
  useEffect(() => {
    if (!visible) return;
    setTab(isExternal ? 'external' : 'file');
    setFiles([]);
    setMdFilename('');
    setMdContent('');
  }, [visible, isExternal]);

  const addFiles = (incoming: File[]) => {
    const allowed = incoming.filter((f) => WIKI_ALLOWED_FILE_RE.test(f.name));
    const rejected = incoming.length - allowed.length;
    if (rejected > 0) tea.notify.warning(t('wiki.detail.ignored', { count: rejected }));
    if (allowed.length > 0) setFiles((prev) => [...prev, ...allowed]);
  };

  const hasFileInput = files.length > 0;
  const hasMdInput = mdFilename.trim().length > 0 && mdContent.trim().length > 0;
  // external "has input" = pages checked (the tree must be fetched and checked first, same as the original flow)
  const ext = external;
  const hasExternalInput = isExternal ? (ext?.selectedPageIds.length ?? 0) > 0 : false;

  const mode: ImportMode = isExternal
    ? hasExternalInput
      ? 'external'
      : 'reingest'
    : tab === 'file'
      ? hasFileInput
        ? 'files'
        : 'reingest'
      : hasMdInput
        ? 'markdown'
        : 'reingest';
  const hasInput = isExternal ? hasExternalInput : tab === 'file' ? hasFileInput : hasMdInput;
  const canSubmit = !submitting && (hasInput || (!isExternal && !hasInput) || !hasInput);

  const handleSubmit = async () => {
    if (submitting) return;

    const payload: ImportSubmitPayload = { mode };
    if (mode === 'files') {
      const items = await Promise.all(
        files.map(async (f) => ({
          filename: f.name,
          content: await f.text(),
        })),
      );
      payload.files = items;
    } else if (mode === 'markdown') {
      payload.markdown = [{ filename: mdFilename.trim(), content: mdContent }];
    } else if (mode === 'external' && ext) {
      payload.source_url = ext.formSourceUrl.trim();
      payload.provider_id = ext.formSourceType;
      payload.page_ids = ext.selectedPageIds;
    }
    await onSubmit(payload);
  };

  return (
    <Modal
      visible={visible}
      caption={t('wiki.import.caption')}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <Tabs
          tabs={
            isExternal
              ? [{ id: 'external', label: t('wiki.detail.addDoc.external') }]
              : [
                  { id: 'file', label: t('wiki.detail.addDoc.file') },
                  { id: 'markdown', label: t('wiki.detail.addDoc.markdown') },
                ]
          }
          activeId={tab}
          onActive={(tb) => setTab(tb.id as 'file' | 'markdown' | 'external')}
        >
          <TabPanel id="file">
            <div className="_wiki-detail-upload-panel">
              <div
                className="_wiki-detail-dropzone"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addFiles(Array.from(e.dataTransfer.files));
                }}
              >
                <AttachIcon size={20} />
                <p>{t('wiki.detail.dropzone')}</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt,.markdown"
                multiple
                className="_wiki-detail-hidden-input"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {files.length > 0 && (
                <ul className="_wiki-detail-file-list">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`}>
                      {f.name}
                      <Button
                        type="link"
                        onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        {t('common.remove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabPanel>

          <TabPanel id="markdown">
            <Input
              placeholder={t('wiki.detail.mdName')}
              value={mdFilename}
              onChange={(v) => setMdFilename(String(v ?? ''))}
            />
            <textarea
              className="_wiki-detail-md-editor"
              placeholder={t('wiki.detail.mdContent')}
              value={mdContent}
              onChange={(e) => setMdContent(e.target.value)}
              rows={10}
            />
          </TabPanel>

          <TabPanel id="external">
            {ext && (
              <div className="_wiki-detail-external-panel" style={{ paddingTop: 8 }}>
                {/* Source selection */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ marginBottom: 4 }}>{t('wiki.register.source')}</div>
                  <Select
                    size="full"
                    value={ext.formSourceType}
                    onChange={(v) => {
                      ext.setFormSourceType(v);
                      // Switching source clears the checked pages
                      ext.setSelectedPageIds([]);
                    }}
                    options={[
                      { value: '', text: '—' },
                      ...ext.sourceProviders.map((p: SourceProviderMeta) => {
                        const key = `wiki.source.${p.id}`;
                        const localized = t(key);
                        return { value: p.id, text: localized === key ? p.id : localized };
                      }),
                    ]}
                  />
                </div>

                {/* Credential fields (rendered dynamically per form_fields) -- no need to re-enter when credentials are already stored */}
                {ext.formSourceType && !ext.credConfigured && (
                  <>
                    <Alert type="info">{t('wiki.register.credHint')}</Alert>
                    {(ext.sourceProviders.find((p) => p.id === ext.formSourceType)?.form_fields ?? []).map(
                      (field: SourceProviderFormField, idx: number, arr: readonly SourceProviderFormField[]) => {
                        const provider = ext.sourceProviders.find((p) => p.id === ext.formSourceType)!;
                        const isLast = idx === arr.length - 1;
                        const labelKey = `code.credField.${field.name}.label`;
                        const label = t(labelKey);
                        const phKey = `code.credField.${field.name}.placeholder`;
                        const ph = t(phKey);
                        return (
                          <div key={field.name} style={{ marginBottom: 12 }}>
                            <div style={{ marginBottom: 4 }}>
                              {label === labelKey ? field.name : label}
                              {field.required && <span style={{ color: '#d0021b' }}> *</span>}
                            </div>
                            <Input
                              size="full"
                              type={field.secret ? 'password' : 'text'}
                              value={ext.formCredential[field.name] ?? ''}
                              onChange={(v) => ext.setCredentialField(field.name, v)}
                              placeholder={ph === phKey ? '' : ph}
                            />
                            {isLast && provider.token_doc_url && (
                              <a
                                href={provider.token_doc_url}
                                target="_blank"
                                rel="noreferrer"
                                className="_wikilist-token-doc"
                              >
                                {t('code.register.tokenDoc')}
                              </a>
                            )}
                          </div>
                        );
                      },
                    )}
                  </>
                )}

                {/* Source address */}
                {ext.formSourceType && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>{t('wiki.register.sourceUrl')}</div>
                    <Input
                      size="full"
                      value={ext.formSourceUrl}
                      onChange={ext.setFormSourceUrl}
                      placeholder={t('wiki.register.sourceUrlPlaceholder')}
                    />
                    <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                      {t('wiki.register.sourceUrlExtra')}
                    </div>
                  </div>
                )}

                {/* Traversal strategy: decides how documents are discovered starting from the source address */}
                {ext.formSourceType && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>{t('wiki.register.crawlMode')}</div>
                    <Select
                      size="full"
                      value={ext.crawlMode ?? 'tree'}
                      options={[
                        { value: 'tree', text: t('wiki.register.crawlMode.tree') },
                        { value: 'links', text: t('wiki.register.crawlMode.links') },
                      ]}
                      onChange={(v) => ext.setCrawlMode((v || 'tree') as 'tree' | 'links')}
                    />
                    <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                      {ext.crawlMode === 'links'
                        ? t('wiki.register.crawlHint.links')
                        : t('wiki.register.crawlHint.tree')}
                    </div>
                  </div>
                )}

                {/* Fetch button: credentials not stored -> store first then fetch (storing credentials is a prerequisite for fetching the tree) */}
                {ext.formSourceType && (
                  <Button
                    type="primary"
                    onClick={ext.onFetchTree}
                    disabled={ext.fetchingTree || ext.savingCred || !ext.formSourceUrl.trim()}
                    loading={ext.fetchingTree || ext.savingCred}
                    style={{ marginBottom: 12 }}
                  >
                    {ext.fetchingTree || ext.savingCred
                      ? t('wiki.register.fetching')
                      : ext.credConfigured
                        ? t('wiki.register.fetch')
                        : t('wiki.register.saveAndFetch')}
                  </Button>
                )}

                {/* Document tree checking (restores hierarchy by parentId; directories are collapsible / support quick select-all) */}
                {ext.treeResult && (
                  <div>
                    <WikiSourcePageTree
                      pages={ext.treeResult.pages}
                      selectedPageIds={ext.selectedPageIds}
                      onToggleLeaf={(id, checked) =>
                        ext.setSelectedPageIds(
                          checked
                            ? [...ext.selectedPageIds, id]
                            : ext.selectedPageIds.filter((x) => x !== id),
                        )
                      }
                      onToggleDir={(ids, checked) =>
                        ext.setSelectedPageIds(
                          checked
                            ? [...new Set([...ext.selectedPageIds, ...ids])]
                            : ext.selectedPageIds.filter((x) => !ids.includes(x)),
                        )
                      }
                    />
                    <Text theme="weak" style={{ marginTop: 8, display: 'block' }}>
                      {t('wiki.import.selectedPages', { count: ext.selectedPageIds.length })}
                    </Text>
                  </div>
                )}
              </div>
            )}
          </TabPanel>
        </Tabs>
      </Modal.Body>
      <Modal.Footer>
        {/* Design section 2.3: the two-phase capability is no longer kept -- only this one primary button, no secondary button.
            The standalone "Import" button at the bottom of the tree is gone; submission is uniformly done by the footer primary button. */}
        <Button type="primary" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
          {primaryLabel(mode, hasInput, t)}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
