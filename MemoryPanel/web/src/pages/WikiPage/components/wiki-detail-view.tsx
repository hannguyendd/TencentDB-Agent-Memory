/**
 * WikiDetailView -- Wiki detail view (Overview / Graph / Pages / Search four Tabs + add-document Modal).
 * All data and callbacks come from the object returned by useWikiSources; the component only renders.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Input, MetricsBoard, Modal, Progress, SearchBox, Select, StatusTip, TabPanel, Tabs, Tag, Text } from 'tea-component';
import {
  ArrowLeftIcon,
  AttachIcon,
  BooksIcon,
  ChartBarIcon,
  CheckCircleIcon,
  CheckIcon,
  CloseCircleIcon,
  CloseIcon,
  FileIcon,
  LayersIcon as ArchitectureIcon,
  LoadingIcon,
  SearchIcon,
} from 'tea-icons-react';
import { knowledgeApi, type SourceProviderMeta, type SourceProviderFormField } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { WIKI_ALLOWED_FILE_RE, TYPE_COLORS, TYPE_COLOR_FALLBACK, type DetailTab } from '../constants/wiki-constants';
import { WikiStatusBadge } from './wiki-ui';
import { GraphTabContent, PagesTabContent } from './wiki-detail-components';
import { WikiSourcePageTree } from './wiki-source-page-tree';
import { ImportAndIngestModal } from './import-and-ingest-modal';
import type { WikiSourcesStore } from '../hooks/useWikiSources';

export function WikiDetailView({ store }: { store: WikiSourcesStore }) {
  const { t } = useTranslation();
  // Design 2026-09-21: the merged single import entry (formerly "Add" + "Ingest")
  const [showImportModal, setShowImportModal] = useState(false);
  const {
    sources,
    selectedWikiId,
    setSubView,
    fetchSources,
    displayIngestState,
    ingestCardCleared,
    setIngestCardCleared,
    activeTab,
    setActiveTab,
    pages,
    types,
    typeCounts,
    edgeCount,
    handleReadPage,
    filteredPages,
    pageTypeFilter,
    setPageTypeFilter,
    selectedPage,
    readLoading,
    displayContent,
    metadata,
    rawRefreshKey,
    handleDeletePage,
    handleDeleteRaw,
    setSelectedPage,
    setReadContent,
    setReadLoading,
    searchQuery,
    setSearchQuery,
    handleSearch,
    searching,
    searchResults,
    pendingFiles,
    setPendingFiles,
    uploadProgress,
    submitting,
    mdDocs,
    setMdDocs,
    handleUploadMdBatch,
    handleBatchUpload,
    fileInputRef,
    openAddDocExternal,
    // External source (iWiki etc.) import
    sourceProviders,
    formSourceType,
    setFormSourceType,
    formCredential,
    setCredentialField,
    formSourceUrl,
    setFormSourceUrl,
    treeResult,
    selectedPageIds,
    setSelectedPageIds,
    fetchingTree,
    importing,
    credConfigured,
    savingCred,
    crawlMode,
    setCrawlMode,
    fetchWikiTree,
    importWikiPages,
    loadWikiProviders,
    ensureCredential,
  } = store;

  const source = sources.find((s) => s.wiki_id === selectedWikiId);
  const wikiName = source?.name ?? '';
  // The progress card shows only while "processing"; once finished (ready) it collapses automatically, same as the behavior before the merge change
  // (the terminal state is reflected by the title bar's status badge + page count, so no progress card needs to remain).
  // Exception for failed: the error reason must be explicitly shown to the user, so the card is kept until the user clicks "Clear".
  const showIngestCard =
    !ingestCardCleared &&
    displayIngestState.wiki === wikiName &&
    (displayIngestState.active || displayIngestState.status === 'failed');
  const isIngestingNow = displayIngestState.active;

  // When the selected Wiki no longer exists (deleted or refresh failed), give an empty state that can be returned from, avoiding a dead end
  if (!source) {
    return (
      <Card>
        <Card.Body>
          <Button type="text" onClick={() => { fetchSources(); setSubView('list'); }}>
            <ArrowLeftIcon size={12} /> {t('wiki.breadcrumb')}
          </Button>
          <StatusTip status="empty" emptyText={t('wiki.detail.notFound')} />
        </Card.Body>
      </Card>
    );
  }

  return (
    <div className="_wiki-detail-root">
      <Card>
        <Card.Body className="_wiki-detail-header-body">
          <div className="_wiki-detail-breadcrumb">
            <Button type="link" onClick={() => { fetchSources(); setSubView('list'); }}>
              <ArrowLeftIcon size={12} /> {t('wiki.breadcrumb')}
            </Button>
            <span className="_wiki-detail-breadcrumb-sep">/</span>
            <span className="_wiki-detail-breadcrumb-current">{wikiName}</span>
          </div>
          <div className="_wiki-detail-header-row">
            <div className="_wiki-detail-header-info">
              <BooksIcon size={20} />
              <span className="_wiki-detail-title">{wikiName}</span>
              {/* The status badge and progress card share the same source: both use displayIngestState (which masks "the terminal
                  state left over from the previous task"), ensuring the badge and card are always consistent, never one showing ready while
                  the other shows processing. */}
              {displayIngestState.status && (
                <WikiStatusBadge status={displayIngestState.status} />
              )}
            </div>
            <div className="_wiki-detail-header-actions">
              {/* Design 2026-09-21: "Add" + "Ingest" merged into a single entry. */}
              <Button
                type="primary"
                onClick={() => {
                  // On open, initialize the external flow: backfill the source address, check credentials, and if already configured fetch the tree directly
                  if (source?.source_type && !showImportModal) {
                    void openAddDocExternal(source);
                  }
                  setShowImportModal(true);
                }}
                // Design 2026-09-21 section 3.3: the merged entry allows "import again while extracting" -- KS's
                // onBusy:'replace' atomically does "cancel the old task + queue the new one", and the UI does not disable the button.
                // The previous disabled based on isCurrentWikiIngesting contradicted the replace semantics,
                // and would block the legitimate flow of "switch to another file and try again".
              >
                <AttachIcon size={14} /> {t('wiki.detail.import')}
              </Button>
            </div>
          </div>
          <div className="_detail-meta-row">
            {/* Do not show the page count while extraction is in progress: under replace semantics the old page count has not yet been rebuilt by the new task,
                and showing "0 pages" or the old count would mislead users; fetchDetail refreshes it once ready. */}
            {!isIngestingNow && (
              <span>{t('wiki.detail.pages', { count: pages.length })}</span>
            )}
          </div>
        </Card.Body>
      </Card>

      {showIngestCard && (
          <Card className="_wiki-detail-ingest-card">
            <Card.Body>
              <div className="_wiki-detail-ingest">
                <div className="_wiki-detail-ingest-head">
                  <Text className="_wiki-detail-ingest-title">
                    {displayIngestState.active ? (
                      <LoadingIcon size={14} />
                    ) : (
                      <CheckCircleIcon size={14} />
                    )}{' '}
                    {t('wiki.detail.ingestTitle', { name: displayIngestState.wiki })}
                  </Text>
                  {!displayIngestState.active && (
                    <Button
                      type="text"
                      onClick={() => setIngestCardCleared(true)}
                    >
                      {t('wiki.detail.clear')}
                    </Button>
                  )}
                </div>
                {displayIngestState.total > 0 && (
                  <>
                    <Progress
                      percent={Math.round(
                        (displayIngestState.done / displayIngestState.total) * 100,
                      )}
                    />
                    <div className="_wiki-detail-ingest-meta">
                      <Text theme="label">{displayIngestState.detail}</Text>
                      <Text theme="label">
                        {displayIngestState.done}/{displayIngestState.total}
                      </Text>
                    </div>
                    {displayIngestState.active && (
                      <Text theme="label">
                        {t('wiki.detail.queryCount', { count: displayIngestState.checkCount })}
                        {displayIngestState.lastCheckedAt
                          ? t('wiki.detail.lastQuery', { time: displayIngestState.lastCheckedAt })
                          : ''}
                      </Text>
                    )}
                  </>
                )}
                {displayIngestState.active && displayIngestState.currentFile && (
                  <Text theme="label" className="_wiki-detail-ingest-file">
                    <FileIcon size={12} /> {displayIngestState.currentFile}
                  </Text>
                )}
                {displayIngestState.log.length > 0 && (
                  <div className="_wiki-detail-ingest-log">
                    {displayIngestState.log.map((item, index) => (
                      <div key={`${item.file}-${index}`} className="_wiki-detail-ingest-log-item">
                        {item.status === 'done' ? (
                          <CheckCircleIcon size={12} />
                        ) : (
                          <CloseCircleIcon size={12} />
                        )}
                        <span className="_wiki-detail-ingest-log-file">{item.file}</span>
                        {item.error && (
                          <span className="_wiki-detail-ingest-log-error">{item.error}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card.Body>
          </Card>
        )}

      <Tabs
        activeId={activeTab}
        onActive={(tab) => setActiveTab(tab.id as DetailTab)}
        disableTabScrolling
        className="_wiki-detail-tabs"
        tabs={[
          {
            id: 'overview',
            label: (
              <span className="_wiki-detail-tab-label">
                <ChartBarIcon size={14} />
                {t('wiki.detail.tab.overview')}
              </span>
            ),
          },
          {
            id: 'graph',
            label: (
              <span className="_wiki-detail-tab-label">
                <ArchitectureIcon size={14} />
                {t('wiki.detail.tab.graph')}
              </span>
            ),
          },
          {
            id: 'pages',
            label: (
              <span className="_wiki-detail-tab-label">
                <FileIcon size={14} />
                {t('wiki.detail.tab.pages')}
              </span>
            ),
          },
          {
            id: 'search',
            label: (
              <span className="_wiki-detail-tab-label">
                <SearchIcon size={14} />
                {t('wiki.detail.tab.search')}
              </span>
            ),
          },
        ]}
      >
        <TabPanel id="overview">
          <div className="_wiki-detail-overview">
            <div className="_wiki-detail-overview-stats">
              <MetricsBoard title={t('wiki.detail.overview.totalPages')} value={pages.length} />
              <MetricsBoard title={t('wiki.detail.overview.pageTypes')} value={types.length} />
              <MetricsBoard title={t('wiki.detail.overview.edges')} value={edgeCount} />
            </div>
            <Card bordered>
              <Card.Body title={t('wiki.detail.overview.typeDist')}>
                {types.length === 0 ? (
                  <StatusTip status="empty" emptyText={t('wiki.detail.overview.emptyPages')} />
                ) : (
                  <div className="_wiki-detail-type-dist">
                    {types.map((type) => {
                      const count = typeCounts[type];
                      const pct = pages.length ? Math.round((count / pages.length) * 100) : 0;
                      return (
                        <div key={type} className="_wiki-detail-type-row">
                          <span className="_wiki-detail-type-label">
                            <span
                              className="_wiki-detail-type-dot"
                              style={{ background: TYPE_COLORS[type] || TYPE_COLOR_FALLBACK }}
                            />
                            {type}
                          </span>
                          <span className="_wiki-detail-type-bar">
                            <span
                              className="_wiki-detail-type-bar-fill"
                              style={{
                                width: `${pct}%`,
                                background: TYPE_COLORS[type] || TYPE_COLOR_FALLBACK,
                              }}
                            />
                          </span>
                          <Text theme="label" className="_wiki-detail-type-count">
                            {t('wiki.detail.typePct', { count, pct })}
                          </Text>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card.Body>
            </Card>
            <Card bordered>
              <Card.Body title={t('wiki.detail.overview.pageList')}>
                {pages.length === 0 ? (
                  <StatusTip status="empty" emptyText={t('wiki.detail.overview.emptyPageList')} />
                ) : (
                  <div className="_wiki-detail-overview-grid">
                    {pages.slice(0, 9).map((page) => (
                      <button
                        key={(page as any).id || page.path}
                        onClick={() => {
                          handleReadPage(page);
                          setActiveTab('pages');
                        }}
                        className="_wiki-detail-overview-item"
                      >
                        <span
                          className="_wiki-detail-type-dot"
                          style={{ background: TYPE_COLORS[page.type] || TYPE_COLOR_FALLBACK }}
                        />
                        <span className="_wiki-detail-overview-item-title">{page.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </Card.Body>
            </Card>
          </div>
        </TabPanel>

        <TabPanel id="graph">
          <GraphTabContent
            graphData={store.graphData}
            graphLoading={store.graphLoading}
            selectedPage={selectedPage}
            readLoading={readLoading}
            displayContent={displayContent}
            metadata={metadata}
            onNodeClick={(node) => {
              const page =
                pages.find((item) => ((item as any).id || item.path) === node.id) ||
                ({ path: node.id, title: node.label, type: node.type } as any);
              handleReadPage(page);
            }}
            onClearSelection={() => setSelectedPage(null)}
          />
        </TabPanel>
        <TabPanel id="pages">
          <PagesTabContent
            pages={filteredPages}
            allPages={pages}
            types={types}
            typeCounts={typeCounts}
            pageTypeFilter={pageTypeFilter}
            setPageTypeFilter={setPageTypeFilter}
            selectedPage={selectedPage}
            readLoading={readLoading}
            displayContent={displayContent}
            metadata={metadata}
            wikiId={selectedWikiId}
            rawRefreshKey={rawRefreshKey}
            onReadPage={handleReadPage}
            onDeletePage={handleDeletePage}
            onDeleteRaw={handleDeleteRaw}
            onReadRaw={(filename) => {
              const rawPage = {
                path: `raw/${filename}`,
                title: filename,
                type: 'raw',
              } as any;
              setSelectedPage(rawPage);
              setReadContent('');
              setReadLoading(true);
              knowledgeApi.wiki
                .rawRead(selectedWikiId, [filename])
                .then((result: any) => setReadContent(result?.items?.[0]?.content || ''))
                .catch((error: any) => {
                  setReadContent('');
                  tea.notify.error(error?.message || t('wiki.notify.readRawFailed'));
                })
                .finally(() => setReadLoading(false));
            }}
          />
        </TabPanel>
        <TabPanel id="search">
          <div className="_wiki-detail-search">
            <SearchBox
              value={searchQuery}
              onChange={setSearchQuery}
              onSearch={handleSearch}
              placeholder={t('wiki.detail.search.placeholder')}
            />
            {searching && <StatusTip status="loading" />}
            {!searching && searchResults.length > 0 && (
              <>
                <Text theme="label">{t('wiki.detail.search.results', { count: searchResults.length })}</Text>
                <div className="_wiki-detail-search-results">
                  {searchResults.map((result, index) => (
                    <button
                      key={`${result.path}-${index}`}
                      type="button"
                      className="_wiki-detail-search-item"
                      onClick={() => {
                        const page =
                          pages.find((item) => ((item as any).id || item.path) === result.path) ||
                          ({
                            path: result.path,
                            title: result.title,
                            type: result.type,
                          } as any);
                        handleReadPage(page);
                        setActiveTab('pages');
                      }}
                    >
                      <span className="_wiki-detail-search-item-head">
                        <span
                          className="_wiki-detail-type-dot"
                          style={{ background: TYPE_COLORS[result.type] || TYPE_COLOR_FALLBACK }}
                        />
                        <span className="_wiki-detail-search-item-title">{result.title}</span>
                        <Tag size="sm">{result.type}</Tag>
                        <Text theme="label" className="_wiki-detail-search-item-score">
                          {result.score.toFixed(1)}
                        </Text>
                      </span>
                      {result.snippet && (
                        <Text theme="label" className="_wiki-detail-search-item-snippet">
                          {result.snippet}
                        </Text>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
            {!searching && searchResults.length === 0 && searchQuery && (
              <StatusTip status="empty" emptyText={t('wiki.detail.search.empty')} />
            )}
          </div>
        </TabPanel>
      </Tabs>

      {/* Add Doc Modal */}
      {store.showAddDoc && (() => {
        // For wikis from external sources such as iWiki: show only "Fetch from external", and not the "Upload file / Markdown" two tabs.
        // Otherwise (manually uploaded wiki) keep the original two tabs; the source comes from wiki_detail.source_type (null = manual).
        const isExternal = !!source?.source_type;
        // On open, if it is an external source, force-switch to the external tab and prefetch the source list.
        const modalTabId: 'file' | 'markdown' | 'external' = isExternal
          ? 'external'
          : (store.addDocTab === 'external' ? 'file' : store.addDocTab);
        return (
        <Modal
          visible
          caption={t('wiki.detail.addDoc.caption', { name: wikiName })}
          size="m"
          onClose={() => store.setShowAddDoc(false)}
          disableEscape={submitting}
        >
          <Modal.Body>
            <Alert type="info">{t('wiki.detail.addDoc.hint')}</Alert>
            <Tabs
              tabs={isExternal
                ? [{ id: 'external', label: t('wiki.detail.addDoc.external') }]
                : [
                    { id: 'file', label: t('wiki.detail.addDoc.file') },
                    { id: 'markdown', label: t('wiki.detail.addDoc.markdown') },
                  ]}
              activeId={modalTabId}
              onActive={(tab) => {
                const id = tab.id as 'file' | 'markdown' | 'external';
                store.setAddDocTab(id);
                // On first switching to "External source", prefetch the source list
                if (id === 'external' && sourceProviders.length === 0) void loadWikiProviders();
              }}
            >
              <TabPanel id="file">
                <div className="_wiki-detail-upload-panel">
                  <div
                    className="_wiki-detail-dropzone"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const all = Array.from(e.dataTransfer.files);
                      const allowed = all.filter((f) => WIKI_ALLOWED_FILE_RE.test(f.name));
                      const rejected = all.length - allowed.length;
                      if (rejected > 0) {
                        tea.notify.warning(
                          t('wiki.detail.ignored', { count: rejected }),
                        );
                      }
                      if (allowed.length > 0) setPendingFiles((prev) => [...prev, ...allowed]);
                    }}
                  >
                    <Text theme="weak">{t('wiki.detail.dropzone')}</Text>
                  </div>
                  {pendingFiles.length > 0 && (
                    <div className="_wiki-detail-upload-files">
                      {pendingFiles.map((f, i) => (
                        <div key={i} className="_wiki-detail-upload-file">
                          <span className="_wiki-detail-upload-file-name">{f.name}</span>
                          <span className="_wiki-detail-upload-file-size">
                            {(f.size / 1024).toFixed(1)}K
                          </span>
                          {uploadProgress[f.name] === 'done' && (
                            <span className="_wiki-detail-upload-file-success">
                              <CheckIcon size={12} />
                            </span>
                          )}
                          {uploadProgress[f.name] === 'error' && (
                            <span className="_wiki-detail-upload-file-error">
                              <CloseIcon size={12} />
                            </span>
                          )}
                          {uploadProgress[f.name] === 'pending' && (
                            <span className="_wiki-detail-upload-file-pending">…</span>
                          )}
                          {!submitting && (
                            <Button
                              type="text"
                              onClick={() =>
                                setPendingFiles((prev) => prev.filter((_, j) => j !== i))
                              }
                            >
                              {t('common.delete')}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {pendingFiles.length > 0 && (
                    <div className="_wiki-detail-upload-footer">
                      <Text theme="weak">{t('wiki.detail.upload.footer', { count: pendingFiles.length })}</Text>
                      <Button
                        type="primary"
                        onClick={handleBatchUpload}
                        disabled={submitting}
                        loading={submitting}
                      >
                        {submitting ? t('wiki.detail.upload.submitting') : t('wiki.detail.upload.confirm')}
                      </Button>
                    </div>
                  )}
                </div>
              </TabPanel>
              <TabPanel id="markdown">
                <div className="_wiki-detail-upload-panel">
                  {mdDocs.map((doc, i) => (
                    <div key={i} className="_wiki-detail-markdown-doc">
                      <div className="_wiki-detail-markdown-doc-head">
                        <Input
                          size="full"
                          value={doc.filename}
                          onChange={(v) =>
                            setMdDocs((prev) =>
                              prev.map((d, j) => (j === i ? { ...d, filename: v } : d)),
                            )
                          }
                          width={100}
                          placeholder="filename.md"
                        />
                        {mdDocs.length > 1 && (
                          <Button
                            type="text"
                            onClick={() => setMdDocs((prev) => prev.filter((_, j) => j !== i))}
                          >
                            {t('common.delete')}
                          </Button>
                        )}
                      </div>
                      <Input.TextArea
                        size="full"
                        rows={6}
                        value={doc.content}
                        onChange={(v) =>
                          setMdDocs((prev) =>
                            prev.map((d, j) => (j === i ? { ...d, content: v } : d)),
                          )
                        }
                        placeholder={t('wiki.detail.md.placeholder')}
                      />
                    </div>
                  ))}
                  <Button
                    onClick={() => setMdDocs((prev) => [...prev, { filename: '', content: '' }])}
                  >
                    {t('wiki.detail.md.add')}
                  </Button>
                  <div className="_wiki-detail-upload-footer">
                    <Text theme="weak">
                      {t('wiki.detail.md.pending', { count: mdDocs.filter((d) => d.filename.trim() && d.content.trim()).length })}
                    </Text>
                    <Button
                      type="primary"
                      onClick={handleUploadMdBatch}
                      disabled={
                        submitting || mdDocs.every((d) => !d.filename.trim() || !d.content.trim())
                      }
                      loading={submitting}
                    >
                      {submitting ? t('wiki.detail.upload.submitting') : t('wiki.detail.upload.confirm')}
                    </Button>
                  </div>
                </div>
              </TabPanel>
              <TabPanel id="external">
                <div className="_wiki-detail-external-panel" style={{ paddingTop: 8 }}>
                  {/* Source selection */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>{t('wiki.register.source')}</div>
                    <Select
                      size="full"
                      value={formSourceType}
                      onChange={(v) => {
                        setFormSourceType(v);
                        // Switching source clears the entered credentials and the fetched tree
                        setSelectedPageIds([]);
                      }}
                      options={[
                        { value: '', text: '—' },
                        ...sourceProviders.map((p: SourceProviderMeta) => {
                          const key = `wiki.source.${p.id}`;
                          const localized = t(key);
                          return { value: p.id, text: localized === key ? p.id : localized };
                        }),
                      ]}
                    />
                  </div>

                  {/* Credential fields (rendered dynamically per form_fields) -- no need to re-enter when credentials are already stored */}
                  {formSourceType && !credConfigured && (
                    <>
                      <Alert type="info">{t('wiki.register.credHint')}</Alert>
                      {(sourceProviders.find((p) => p.id === formSourceType)?.form_fields ?? []).map(
                        (field: SourceProviderFormField, idx: number, arr: readonly SourceProviderFormField[]) => {
                          const provider = sourceProviders.find((p) => p.id === formSourceType)!;
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
                                value={formCredential[field.name] ?? ''}
                                onChange={(v) => setCredentialField(field.name, v)}
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
                  {formSourceType && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ marginBottom: 4 }}>{t('wiki.register.sourceUrl')}</div>
                      <Input
                        size="full"
                        value={formSourceUrl}
                        onChange={setFormSourceUrl}
                        placeholder={t('wiki.register.sourceUrlPlaceholder')}
                      />
                      <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                        {t('wiki.register.sourceUrlExtra')}
                      </div>
                    </div>
                  )}

                  {/* Traversal strategy: decides how documents are discovered starting from the source address */}
                  {formSourceType && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ marginBottom: 4 }}>{t('wiki.register.crawlMode')}</div>
                      <Select
                        size="full"
                        value={crawlMode ?? 'tree'}
                        options={[
                          { value: 'tree', text: t('wiki.register.crawlMode.tree') },
                          { value: 'links', text: t('wiki.register.crawlMode.links') },
                        ]}
                        onChange={(v) => setCrawlMode((v || 'tree') as typeof crawlMode)}
                      />
                      <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                        {crawlMode === 'links'
                          ? t('wiki.register.crawlHint.links')
                          : t('wiki.register.crawlHint.tree')}
                      </div>
                    </div>
                  )}

                  {/* Fetch button: credentials not stored -> store first then fetch (storing credentials is a prerequisite for fetching the tree) */}
                  {formSourceType && (
                    <Button
                      type="primary"
                      onClick={() => {
                        const wikiId = selectedWikiId ?? undefined;
                        if (credConfigured) void fetchWikiTree(wikiId);
                        else void ensureCredential(wikiId ?? '');
                      }}
                      disabled={
                        fetchingTree || savingCred || !formSourceUrl.trim() || !selectedWikiId
                      }
                      loading={fetchingTree || savingCred}
                      style={{ marginBottom: 12 }}
                    >
                      {fetchingTree || savingCred
                        ? t('wiki.register.fetching')
                        : credConfigured
                          ? t('wiki.register.fetch')
                          : t('wiki.register.saveAndFetch')}
                    </Button>
                  )}

                  {/* Document tree checking (restores hierarchy by parentId; directories are collapsible / support quick select-all) */}
                  {treeResult && (
                    <div>
                      <WikiSourcePageTree
                        pages={treeResult.pages}
                        selectedPageIds={selectedPageIds}
                        onToggleLeaf={(id, checked) =>
                          setSelectedPageIds((prev) =>
                            checked ? [...prev, id] : prev.filter((x) => x !== id),
                          )
                        }
                        onToggleDir={(ids, checked) =>
                          setSelectedPageIds((prev) =>
                            checked
                              ? [...new Set([...prev, ...ids])]
                              : prev.filter((x) => !ids.includes(x)),
                          )
                        }
                      />
                      <Button
                        type="primary"
                        style={{ marginTop: 12 }}
                        onClick={() => void importWikiPages(selectedWikiId ?? undefined)}
                        disabled={importing || selectedPageIds.length === 0}
                        loading={importing}
                      >
                        {importing ? t('wiki.register.importing') : t('wiki.register.import')}
                      </Button>
                    </div>
                  )}
                </div>
              </TabPanel>
            </Tabs>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.markdown"
              multiple
              className="_wiki-detail-hidden-input"
              onChange={(e) => {
                // The accept attribute is only a browser suggestion; users can bypass it by switching to "All files" in the picker,
                // so a second validation is done here, consistent with the drag-and-drop entry, to avoid binary files being read as garbled text and uploaded.
                const all = Array.from(e.target.files ?? []);
                const allowed = all.filter((f) => WIKI_ALLOWED_FILE_RE.test(f.name));
                const rejected = all.length - allowed.length;
                if (rejected > 0) {
                  tea.notify.warning(
                    t('wiki.detail.ignored', { count: rejected }),
                  );
                }
                if (allowed.length > 0) setPendingFiles((prev) => [...prev, ...allowed]);
                e.target.value = '';
              }}
            />
          </Modal.Body>
        </Modal>
        );
      })()}

      {/* Design 2026-09-21: the merged single import entry (replaces the former "Add" + "Ingest" two buttons) */}
      <ImportAndIngestModal
        visible={showImportModal}
        sourceType={source?.source_type}
        // The Modal's submitting is only used to show the button loading and block repeated clicks; since we
        // fire-and-forget and close the Modal immediately in onSubmit (progress is taken over at the top of the page),
        // there is no "submission not yet returned" window while the Modal exists, so a constant false is fine.
        submitting={false}
        external={{
          sourceProviders,
          formSourceType,
          setFormSourceType: (v) => {
            setFormSourceType(v);
            setSelectedPageIds([]);
          },
          formCredential,
          setCredentialField,
          credConfigured,
          savingCred,
          fetchingTree,
          formSourceUrl,
          setFormSourceUrl,
          crawlMode: crawlMode ?? 'tree',
          setCrawlMode,
          treeResult,
          selectedPageIds,
          setSelectedPageIds,
          onFetchTree: () => {
            const wikiId = selectedWikiId ?? undefined;
            if (credConfigured) void fetchWikiTree(wikiId);
            else void ensureCredential(wikiId ?? '');
          },
        }}
        onClose={() => setShowImportModal(false)}
        onSubmit={(payload) => {
          // Design 2026-09-21 section 2.2: close the Modal immediately after submission, and the progress bar at the top of the page takes over progress.
          // submitAddAndIngest has already completed the error toast / progress callback / refresh internally, so there is no need to await here
          // the whole extraction flow (otherwise the Modal would keep spinning until ingest ends).
          void store.submitAddAndIngest({ wikiId: selectedWikiId, ...payload });
          setShowImportModal(false);
        }}
      />
    </div>
  );
}
