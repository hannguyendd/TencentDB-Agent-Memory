import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import moment, { type Moment } from 'moment';
import { Button, DatePicker, Dropdown, Input, List, Modal, Pagination } from 'tea-component';
import { type MemoryLayer, type MemoryBlock, type AtomicItem } from '../constants/types';
import { useLayers } from '../constants/constants';
import { getLayerCount, extractRole, formatDisplayTime } from '../utils/utils';
import { stripScenarioMeta, copyToClipboard } from '../utils/memory-utils';
import { useUserDisplayName } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { MarkdownView } from '@/components/MarkdownView';
import type { ChatMemorySearchHit } from '@/lib/teamApi';
import {
  AppIcon,
  UsergroupIcon,
  ChevronDownIcon,
  InfoCircleIcon,
  TimeIcon,
  SearchIcon,
  MoreIcon,
  RefreshIcon,
} from 'tea-icons-react';

const { RangePicker } = DatePicker;

/** L0 role -> display group: user on the right, system full-width, the rest (assistant/tool/...) on the left. */
type L0Tone = 'user' | 'assistant' | 'system' | 'tool';
function toneOfRole(role: string): L0Tone {
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return 'assistant';
}

/** Title row of a single atomic memory: tier badge + title + time + action menu (three dots) + optional chevron.
 *  Shared by L1 / L2 / L3. L2 additionally renders a chevron via expandable=true and makes the whole row a clickable expand area.
 *  The head always shows real content (it does not turn into a skeleton while loading); only the body area below shows a skeleton while the body loads. */
function AtomicHead({
  layer,
  tone,
  item,
  time,
  canEditItem,
  canCopyItem,
  onEdit,
  onCopy,
  expandable,
  expanded,
  loading,
  onToggle,
}: {
  layer: MemoryLayer;
  tone: string;
  item: AtomicItem;
  time: string;
  canEditItem: boolean;
  canCopyItem: boolean;
  onEdit?: (item: AtomicItem) => void;
  onCopy: () => void;
  /** True for L2: renders the chevron arrow and makes the whole row clickable to expand/collapse */
  expandable: boolean;
  /** Whether expanded (L2: hasBody) */
  expanded: boolean;
  loading: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const hasActions = canEditItem || canCopyItem;
  const withBody = expandable ? expanded || loading : true;

  const inner = (
    <>
      <span className={`_memory-detail-atomic-layer _memory-detail-atomic-layer--${tone}`}>
        {layer}
      </span>
      <span className="_memory-detail-atomic-title" title={item.title}>
        {item.title}
      </span>
      <span className="_memory-detail-atomic-head-right">
        {time && (
          <span className="_memory-detail-atomic-time" title={item.created_at}>
            {time}
          </span>
        )}
        {/* Action menu (three dots) placed to the right of the time. Clicking the dots opens it, supporting edit / copy.
            The L2 head is a clickable expand area, so propagation must be stopped to avoid accidentally triggering collapse. */}
        {hasActions && (
          <span className="_memory-detail-atomic-actions" onClick={(e) => e.stopPropagation()}>
            <Dropdown
              appearance="pure"
              clickClose
              placement="bottom-end"
              button={
                <Button
                  type="text"
                  className="_memory-detail-atomic-more"
                  tooltip={t('memory.detail.moreActions')}
                >
                  <MoreIcon />
                </Button>
              }
            >
              <List type="option">
                {canEditItem && (
                  <List.Item onClick={() => onEdit!(item)}>{t('memory.detail.edit')}</List.Item>
                )}
                {canCopyItem && (
                  <List.Item onClick={() => void onCopy()}>{t('common.copy')}</List.Item>
                )}
              </List>
            </Dropdown>
          </span>
        )}
        {expandable && (
          <span className="_memory-detail-atomic-chevron-btn" aria-hidden={loading}>
            {loading ? (
              /* Loading on expand: a spinner is shown in the chevron position, indicating the body is being downloaded */
              <span className="_memory-chat-more-spinner _memory-detail-atomic-spinner" />
            ) : (
              <span
                role="button"
                tabIndex={0}
                aria-label={t('memory.detail.moreActions')}
                onClick={(e) => {
                  // The chevron is independently clickable: stop propagation and trigger expand/collapse ourselves,
                  // to avoid landing in the stopPropagation area of the adjacent three-dot dropdown and "doing nothing".
                  e.stopPropagation();
                  onToggle?.();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggle?.();
                  }
                }}
              >
                <ChevronDownIcon
                  size={12}
                  className={`_memory-detail-atomic-chevron${
                    expanded ? ' _memory-detail-atomic-chevron--open' : ''
                  }`}
                />
              </span>
            )}
          </span>
        )}
      </span>
    </>
  );

  if (expandable) {
    // Use div[role=button] rather than <button>: the head contains a tea Button (a real button),
    // and nesting a button in a button is invalid HTML. Clicks are disabled while loading.
    // When not expanded (no body and not loading) --with-body is not added, so there is no bottom line; it is added when expanded or loading.
    return (
      <div
        role="button"
        tabIndex={loading ? -1 : 0}
        aria-disabled={loading}
        className={`_memory-detail-atomic-head _memory-detail-atomic-head--btn${
          withBody ? ' _memory-detail-atomic-head--with-body' : ''
        }`}
        onClick={() => {
          if (!loading) onToggle?.();
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !loading) {
            e.preventDefault();
            onToggle?.();
          }
        }}
      >
        {inner}
      </div>
    );
  }
  return (
    <div className="_memory-detail-atomic-head _memory-detail-atomic-head--with-body">{inner}</div>
  );
}

/** L1 / L3 atomic memory list: the body is shown directly (no collapse/expand). */
function AtomicList({
  layer,
  items,
  loadingItemId,
  timeFiltered,
  canEdit,
  onEdit,
}: {
  layer: MemoryLayer;
  items: AtomicItem[];
  loadingItemId?: string | null;
  /** Whether the current tier is affected by the time filter (L1 only): affects the context of the empty-state text */
  timeFiltered?: boolean;
  /** Whether to show each entry's edit entry point (asset Owner only) */
  canEdit?: boolean;
  /** Click to edit a single entry */
  onEdit?: (item: AtomicItem) => void;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const meta = LAYERS.find((l) => l.id === layer)!;
  if (items.length === 0) {
    return (
      <div className="_memory-detail-empty">
        {timeFiltered
          ? t('memory.detail.emptyLayerInRange', { layer: meta.short })
          : t('memory.detail.emptyLayer', { layer: meta.short })}
      </div>
    );
  }
  return (
    <ul className="_memory-detail-atomic-list">
      {items.map((it) => {
        const hasBody = it.body.trim().length > 0;
        const loading = loadingItemId === it.id;
        const time = formatDisplayTime(it.created_at);
        const canEditItem = !!(canEdit && onEdit);
        const canCopyItem = true;
        async function handleCopy() {
          const ok = await copyToClipboard(it.body);
          if (ok) {
            tea.notify.success(t('memory.notify.copied'));
          } else {
            tea.notify.error(t('memory.notify.copyFailed'));
          }
        }
        return (
          <li key={it.id} className="_memory-detail-atomic-item">
            <AtomicHead
              layer={layer}
              tone={meta.tone}
              item={it}
              time={time}
              canEditItem={canEditItem}
              canCopyItem={canCopyItem}
              onEdit={onEdit}
              onCopy={() => void handleCopy()}
              expandable={false}
              expanded={false}
              loading={loading}
            />
            {layer === 'L3' ? (
              hasBody ? (
                <MarkdownView bare className="_memory-detail-atomic-md">
                  {it.body}
                </MarkdownView>
              ) : loading ? (
                <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                  <div className="_memory-detail-atomic-body-skel-line" style={{ width: '88%' }} />
                  <div className="_memory-detail-atomic-body-skel-line" style={{ width: '70%' }} />
                </div>
              ) : (
                <div className="_memory-detail-atomic-no-body">{t('memory.detail.noBody')}</div>
              )
            ) : loading ? (
              <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '95%' }} />
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '72%' }} />
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '60%' }} />
              </div>
            ) : (
              <pre className="_memory-detail-atomic-body">{it.body}</pre>
            )}
            {it.refs?.length || it.tags?.length ? (
              <div className="_memory-detail-atomic-meta">
                {it.refs?.map((r) => (
                  <span key={r} className="_memory-detail-atomic-ref">
                    {r}
                  </span>
                ))}
                {it.tags?.map((tag) => (
                  <span key={tag} className="_memory-detail-atomic-tag">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** L2 scene memory list: body loaded on demand, click the title/chevron to collapse/expand (with a gradual expand animation). */
function L2AtomicList({
  items,
  onLoadItem,
  loadingItemId,
  canEdit,
  onEdit,
}: {
  items: AtomicItem[];
  onLoadItem?: (itemId: string) => void;
  loadingItemId?: string | null;
  /** Whether to show each entry's edit entry point (asset Owner only) */
  canEdit?: boolean;
  /** Click to edit a single entry */
  onEdit?: (item: AtomicItem) => void;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const meta = LAYERS.find((l) => l.id === 'L2')!;
  if (items.length === 0) {
    return (
      <div className="_memory-detail-empty">
        {t('memory.detail.emptyLayer', { layer: meta.short })}
      </div>
    );
  }
  return (
    <ul className="_memory-detail-atomic-list">
      {items.map((it) => {
        const hasBody = it.body.trim().length > 0;
        const loading = loadingItemId === it.id;
        const time = formatDisplayTime(it.created_at);
        // Edit entry point (Owner only). L2 must be expanded to load the body before editing, to avoid overwriting the file with an empty body.
        const canEditItem = !!(canEdit && onEdit && hasBody);
        // Copy entry point: L2 can be copied only when it has a body (no body when not expanded).
        const canCopyItem = hasBody;
        async function handleCopy() {
          // The L2 body carries a META header; strip it when copying and give only the plain body, consistent with what the edit box shows.
          const ok = await copyToClipboard(stripScenarioMeta(it.body));
          if (ok) {
            tea.notify.success(t('memory.notify.copied'));
          } else {
            tea.notify.error(t('memory.notify.copyFailed'));
          }
        }
        return (
          <li key={it.id} className="_memory-detail-atomic-item">
            <AtomicHead
              layer="L2"
              tone={meta.tone}
              item={it}
              time={time}
              canEditItem={canEditItem}
              canCopyItem={canCopyItem}
              onEdit={onEdit}
              onCopy={() => void handleCopy()}
              expandable
              expanded={hasBody}
              loading={loading}
              onToggle={() => onLoadItem?.(it.id)}
            />
            {/* L2 body is loaded on demand and collapsible: the outer layer uses a grid 0fr<->1fr transition for a gradual expand/collapse animation.
                The container stays in the DOM, and its height expands smoothly from 0 on expand, avoiding the sudden jump caused by conditional rendering.
                It also expands while loading (--open), showing multi-line skeleton bars that match the real shape after the body expands. */}
            <div
              className={`_memory-detail-atomic-expand${
                hasBody || loading ? ' _memory-detail-atomic-expand--open' : ''
              }`}
            >
              <div className="_memory-detail-atomic-expand-inner">
                {loading ? (
                  <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                    <div
                      className="_memory-detail-atomic-body-skel-line"
                      style={{ width: '92%' }}
                    />
                    <div
                      className="_memory-detail-atomic-body-skel-line"
                      style={{ width: '78%' }}
                    />
                    <div
                      className="_memory-detail-atomic-body-skel-line"
                      style={{ width: '88%' }}
                    />
                    <div
                      className="_memory-detail-atomic-body-skel-line"
                      style={{ width: '45%' }}
                    />
                  </div>
                ) : hasBody ? (
                  <MarkdownView bare className="_memory-detail-atomic-md">
                    {it.body}
                  </MarkdownView>
                ) : null}
              </div>
            </div>
            {it.refs?.length || it.tags?.length ? (
              <div className="_memory-detail-atomic-meta">
                {it.refs?.map((r) => (
                  <span key={r} className="_memory-detail-atomic-ref">
                    {r}
                  </span>
                ))}
                {it.tags?.map((tag) => (
                  <span key={tag} className="_memory-detail-atomic-tag">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function BlockDetail({
  block,
  layer,
  onLayerChange,
  agentLabel,
  layerPage,
  layerPageSize,
  layerTotal,
  layerLoading,
  onLayerPageChange,
  onLayerItemLoad,
  layerItemLoadingId,
  onL0LoadMore,
  l0MoreLoading,
  timeRange,
  onTimeRangeChange,
  rangeTooLarge,
  canEdit,
  onSaveLayerItem,
  onSearchLayer,
  onRefresh,
}: {
  block: MemoryBlock;
  layer: MemoryLayer;
  onLayerChange: (l: MemoryLayer) => void;
  agentLabel: (id?: string) => string;
  layerPage: number;
  layerPageSize: number;
  /** Total count of the current tier "within the current time window" (the in-window total returned by the backend when a time filter is applied, used for pagination) */
  layerTotal: number;
  layerLoading: boolean;
  onLayerPageChange: (page: number) => void;
  onLayerItemLoad?: (itemId: string) => void;
  layerItemLoadingId?: string | null;
  /** L0 load more (append earlier conversation); when not provided, the load entry point is not shown */
  onL0LoadMore?: () => void;
  l0MoreLoading?: boolean;
  /** Detail page time filter (effective for L0 / L1 only). start / end are ISO8601 strings */
  timeRange?: { start: string; end: string };
  onTimeRangeChange?: (range: { start: string; end: string }) => void;
  /** True when the backend detects that the filter range is too large (VDB cannot support it) */
  rangeTooLarge?: boolean;
  /** Whether to show the edit entry point (only the asset Owner can edit) */
  canEdit?: boolean;
  /** Save single-tier content (L1/L2/L3); when not provided, the edit entry point is not shown */
  onSaveLayerItem?: (l: 'L1' | 'L2' | 'L3', id: string, content: string) => Promise<void>;
  /** Tiered semantic search (L0 = conversation messages, L1 = atomic memories); when not provided, the search box is not shown */
  onSearchLayer?: (l: 'L0' | 'L1', query: string) => Promise<ChatMemorySearchHit[]>;
  /** Manually refresh the current tier data and the four tier counts; when not provided, the refresh button is not shown */
  onRefresh?: () => void;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  // Pagination applies only to entries "within the current time window": layerTotal is the in-window total (the parent takes it from the BFF's
  // res.total), and the list data is also in-window; only when the two agree is there no "full total page count flipping to an empty page".
  // The full total in layerCounts is used only for tier badge counts, not for pagination.
  const total = layerTotal ?? getLayerCount(block, layer);
  const pageCount = Math.max(1, Math.ceil(total / layerPageSize));
  // L0 uses a "pull down to load more" interaction; L1 / L2 / L3 use a pager
  const showPager = layer !== 'L0' && total > layerPageSize;
  const safePage = Math.min(layerPage, pageCount - 1);
  // The time filter takes effect only for L0 / L1, which are stored by time
  const showTimeFilter = (layer === 'L0' || layer === 'L1') && !!timeRange && !!onTimeRangeChange;
  const rangeValue: [Moment, Moment] | undefined =
    timeRange && timeRange.start && timeRange.end
      ? [moment(timeRange.start), moment(timeRange.end)]
      : undefined;
  // Uploader display name (falls back to user_id)
  const uploaderName = useUserDisplayName(block.uploaded_by_user_id);

  // ── Edit (L1/L2/L3) ──
  const [editing, setEditing] = useState<{
    layer: 'L1' | 'L2' | 'L3';
    id: string;
    title: string;
  } | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  function openEdit(item: AtomicItem) {
    if (layer === 'L0') return;
    // The L2 body carries a META header; the edit box shows only the plain body (on write-back the backend rebuilds it with the existing META).
    const draft = layer === 'L2' ? stripScenarioMeta(item.body) : item.body;
    setEditing({ layer: layer as 'L1' | 'L2' | 'L3', id: item.id, title: item.title });
    setEditContent(draft);
  }
  async function saveEdit() {
    if (!editing || !onSaveLayerItem) return;
    setSaving(true);
    try {
      await onSaveLayerItem(editing.layer, editing.id, editContent);
      // Search result state: the hook's optimistic update applies only to the paginated list, so here we also update the search result entry,
      // otherwise the body of the entry just edited in the search view would not refresh.
      setSearchResults((prev) =>
        prev ? prev.map((it) => (it.id === editing.id ? { ...it, body: editContent } : it)) : prev,
      );
      setEditing(null);
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.editFailed'));
    } finally {
      setSaving(false);
    }
  }

  // ── Browse / Search mode switch (L0 / L1 only) ──
  // Browse: view memories by time range (newest first, paginated / L0 chat stream).
  // Search: locate memories by content semantics (sorted by relevance). The two have different intents, so they are presented mutually exclusively via an explicit mode switch,
  // avoiding the cognitive split of "the time filter and the search box sit side by side but are not linked".
  type DetailMode = 'browse' | 'search';
  const [mode, setMode] = useState<DetailMode>('browse');

  // ── Tiered search (L0 conversation / L1 atomic memory, cross-session semantic recall) ──
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<ChatMemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchable = layer === 'L0' || layer === 'L1';
  // Only "search mode + results produced" enters the search result view; browse mode always uses pagination / the chat stream.
  const isSearching = searchable && mode === 'search' && searchResults !== null;

  // On switching block / tier, clear the search state and return to browse mode, to avoid carrying over the previous context's results / mode
  useEffect(() => {
    setSearchResults(null);
    setSearchInput('');
    setMode('browse');
  }, [block.id, layer]);

  async function doSearch() {
    const q = searchInput.trim();
    if (!q || !onSearchLayer || !searchable) return;
    setSearching(true);
    try {
      const hits = await onSearchLayer(layer as 'L0' | 'L1', q);
      setSearchResults(hits);
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.searchFailed'));
    } finally {
      setSearching(false);
    }
  }
  function clearSearch() {
    setSearchResults(null);
    setSearchInput('');
  }

  // ── L0 scroll container and anchor ──
  // l0HasMore: loaded count < backend total. On first entry / block switch, scroll to the bottom (latest message);
  // after loading more (older messages inserted at the top), keep the viewport position from jumping.
  const l0Total = getLayerCount(block, 'L0');
  // The termination condition is based on "whether loading earlier returns new data" (l0Ended), rather than merely comparing
  // loaded count vs full total -- under a time filter the full total is always greater than the in-window count,
  // and comparing lengths alone would make the button show forever and do nothing when clicked.
  const l0HasMore = !block.l0Ended && block.layers.L0.length < l0Total;
  const l0ScrollRef = useRef<HTMLDivElement>(null);
  const l0AnchorRef = useRef<'bottom' | number | null>(null);
  const l0KeyRef = useRef<string>('');
  const l0PrevScrollTopRef = useRef<number>(Infinity);

  const l0Key = `${block.id}|${layer}`;
  if (l0KeyRef.current !== l0Key) {
    l0KeyRef.current = l0Key;
    // On entering L0, set the anchor and scroll to the bottom (latest message); also update the ref when leaving L0,
    // so that the key differs when switching from L1 back to L0 and scroll-to-bottom is re-triggered.
    if (layer === 'L0') {
      l0AnchorRef.current = 'bottom';
    }
  }

  useLayoutEffect(() => {
    if (layer !== 'L0') return;
    const el = l0ScrollRef.current;
    if (!el) return;
    const anchor = l0AnchorRef.current;
    if (anchor === 'bottom') {
      el.scrollTop = el.scrollHeight;
      l0AnchorRef.current = null;
    } else if (typeof anchor === 'number') {
      el.scrollTop += el.scrollHeight - anchor;
      l0AnchorRef.current = null;
    }
  }, [layer, block.layers.L0.length, layerLoading]);

  function triggerL0LoadMore() {
    const el = l0ScrollRef.current;
    if (el) l0AnchorRef.current = el.scrollHeight;
    onL0LoadMore?.();
  }

  // Scrolling to the top auto-triggers "load earlier" -- so the user doesn't have to click the button every time.
  // A ref records the previous scrollTop position, and it triggers only when crossing the atTop threshold (atTop -> atTop does not repeat),
  // avoiding chained auto-loads caused by anchor correction.
  function handleL0Scroll() {
    const el = l0ScrollRef.current;
    if (!el) return;
    const atTop = el.scrollTop <= 24;
    if (atTop && l0PrevScrollTopRef.current > 24 && l0HasMore && !l0MoreLoading && !layerLoading) {
      triggerL0LoadMore();
    }
    l0PrevScrollTopRef.current = el.scrollTop;
  }

  return (
    <div className="_memory-detail">
      <div className="_memory-detail-header">
        <div className="_memory-detail-header-info">
          <div className="_memory-detail-title">
            <span className="_memory-detail-title-name">{block.title}</span>
            {/* name + id combination: the id is de-emphasized next to the name, so users can recognize assets with id-style names */}
            <span className="_memory-detail-title-id" title={block.id}>
              {block.id}
            </span>
          </div>
          <div className="_memory-detail-meta">
            {block.agent_id ? (
              <span
                className="_memory-badge"
                title={t('memory.detail.fixedTo', { name: agentLabel(block.agent_id) })}
              >
                <AppIcon size={10} />{' '}
                {t('memory.detail.fixedTo', { name: agentLabel(block.agent_id) })}
              </span>
            ) : (
              <span className="_memory-badge" title={t('memory.detail.teamPool')}>
                <UsergroupIcon size={10} /> {t('memory.detail.teamPool')}
              </span>
            )}
            {block.uploaded_by_user_id && (
              <span className="_memory-detail-meta-item">
                {t('memory.list.uploadedBy')}
                <span className="_memory-detail-mono" title={block.uploaded_by_user_id}>
                  {uploaderName || block.uploaded_by_user_id}
                </span>
              </span>
            )}
            <span className="_memory-detail-meta-item">
              {t('memory.detail.updated', { time: new Date(block.updated_at_ms).toLocaleString() })}
            </span>
          </div>
        </div>

        {/* Right action area: manual refresh + browse/search mode switch laid out horizontally.
            Refresh is available for all tiers and sits immediately left of the mode switch control; the mode switch appears only for L0 / L1. */}
        <div className="_memory-detail-header-actions">
          {/* Browse / search mode switch + the control for each mode (L0 / L1 only).
              Browse: time range filter; search: search box. The two are mutually exclusive, removing the misleading "control is there but does nothing". */}
          {searchable && (showTimeFilter || onSearchLayer) && (
            <div className="_memory-detail-mode">
              {/* Manual refresh: re-fetch the current tier data and the four tier counts. Available for all tiers. */}

              <div className="_memory-detail-mode-switch" role="tablist">
                {onRefresh && (
                  <Button
                    type="text"
                    className="_memory-detail-refresh"
                    tooltip={t('memory.detail.refresh')}
                    disabled={layerLoading}
                    onClick={() => onRefresh()}
                  >
                    <RefreshIcon size={14} />
                  </Button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'browse'}
                  className={`_memory-detail-mode-btn${mode === 'browse' ? ' _memory-detail-mode-btn--active' : ''}`}
                  onClick={() => setMode('browse')}
                >
                  <TimeIcon size={12} /> {t('memory.detail.modeBrowse')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'search'}
                  className={`_memory-detail-mode-btn${mode === 'search' ? ' _memory-detail-mode-btn--active' : ''}`}
                  onClick={() => setMode('search')}
                  disabled={!onSearchLayer}
                >
                  <SearchIcon size={12} /> {t('memory.detail.modeSearch')}
                </button>
              </div>

              {/* Browse mode: time range filter (effective for L0 / L1 only) */}
              {mode === 'browse' && showTimeFilter && (
                <div className="_memory-detail-timefilter">
                  <RangePicker
                    showTime={{ format: 'HH:mm' }}
                    format="YYYY-MM-DD HH:mm"
                    separator="~"
                    clearable={false}
                    disabledDate={(d) => d.isBefore(moment().endOf('day'))}
                    value={rangeValue}
                    onChange={(v) => {
                      if (v && v[0] && v[1]) {
                        onTimeRangeChange!({ start: v[0].toISOString(), end: v[1].toISOString() });
                      }
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="_memory-detail-layers">
        {LAYERS.map((l) => {
          const active = l.id === layer;
          const loadedLen =
            l.id === 'L0' ? block.layers.L0.length : block.layers[l.id as MemoryLayer].length;
          const known = block.layerCounts[l.id as MemoryLayer] !== undefined || loadedLen > 0;
          const cnt = getLayerCount(block, l.id as MemoryLayer);
          return (
            <button
              key={l.id}
              onClick={() => onLayerChange(l.id as MemoryLayer)}
              className={`_memory-detail-layer-btn${active ? ' _memory-detail-layer-btn--active' : ''}`}
            >
              <div className="_memory-detail-layer-btn-top">
                <span className="_memory-detail-layer-label">{l.label}</span>
                <span
                  className="_memory-detail-layer-count"
                  title={known ? undefined : t('memory.detail.clickToLoad')}
                >
                  {known ? cnt : '·'}
                </span>
              </div>
              <div className="_memory-detail-layer-desc">{l.desc}</div>
            </button>
          );
        })}
      </div>

      {/* Tiered semantic search: L0 conversation / L1 atomic memory (shown in search mode only) */}
      {searchable && onSearchLayer && mode === 'search' && (
        <div className="_memory-detail-search">
          <Input
            className="_memory-detail-search-input"
            value={searchInput}
            onChange={(v) => setSearchInput(v)}
            placeholder={t(
              layer === 'L0'
                ? 'memory.detail.searchPlaceholderL0'
                : 'memory.detail.searchPlaceholderL1',
            )}
            disabled={searching}
          />
          <Button
            type="primary"
            onClick={() => void doSearch()}
            loading={searching}
            disabled={!searchInput.trim()}
          >
            {t('memory.detail.search')}
          </Button>
          {searchResults !== null && (
            <>
              <Button type="weak" onClick={clearSearch} disabled={searching}>
                {t('memory.detail.clearSearch')}
              </Button>
              <span className="_memory-detail-search-count">
                {t('memory.detail.searchResultCount', { count: searchResults.length })}
              </span>
            </>
          )}
        </div>
      )}

      <div className="_memory-detail-body">
        {layerLoading ? (
          /* Loading state on entering a tier: give the skeleton matching the real shape of the current layer,
             so a one-size-fits-all gray bar switch doesn't feel jarring about what will appear next.
             L0 = IM chat bubbles; L1/L2/L3 = atomic memory entries (including the expand row). */
          <div className={`_memory-detail-skeleton _memory-detail-skeleton--${layer}`}>
            {layer === 'L0' ? (
              /* L0 chat stream: alternately show user (right) / assistant (left) bubble skeletons */
              <>
                {[0, 1, 2, 3, 4].map((i) => {
                  const isUser = i % 2 === 0;
                  const isSystem = i === 2;
                  if (isSystem) {
                    return (
                      <div key={i} className="_memory-detail-skel-chat-system">
                        <div className="_memory-detail-skel-line _memory-detail-skel-line--xs" />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={i}
                      className={`_memory-detail-skel-chat-row _memory-detail-skel-chat-row--${isUser ? 'user' : 'assistant'}`}
                    >
                      <div className="_memory-detail-skel-chat-avatar" />
                      <div className="_memory-detail-skel-chat-bubble">
                        <div className="_memory-detail-skel-line" />
                        <div
                          className="_memory-detail-skel-line"
                          style={{ width: isUser ? '40%' : '72%' }}
                        />
                      </div>
                    </div>
                  );
                })}
              </>
            ) : layer === 'L3' ? (
              /* L3 core memory: a single item fills the width, multi-line body skeleton, matching MarkdownView rich text */
              <>
                <div className="_memory-detail-skel-atomic">
                  <div className="_memory-detail-skel-atomic-head">
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--warning" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                  </div>
                  <div className="_memory-detail-skel-body">
                    {[96, 88, 92, 76, 84, 68, 50].map((w, i) => (
                      <div
                        key={i}
                        className="_memory-detail-skel-line"
                        style={{ width: `${w}%`, height: i === 0 ? 18 : 12 }}
                      />
                    ))}
                  </div>
                </div>
              </>
            ) : layer === 'L2' ? (
              /* Entering L2: the L2 body is loaded on demand (downloaded only on chevron click), so there is no body when not expanded.
                 The loading state draws only the title row head (badge / title / time / three dots / chevron),
                 and no body skeleton below, to avoid misleading users into thinking content is about to appear. */
              <div className="_memory-detail-skel-atomic _memory-detail-skel-atomic--l2 _memory-detail-skel-atomic--headonly">
                <div className="_memory-detail-skel-atomic-head">
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--success" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--chevron" />
                </div>
              </div>
            ) : (
              /* L1 atomic memory: multi-card skeleton, each = title head + 1-2 body lines */
              <>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="_memory-detail-skel-atomic _memory-detail-skel-atomic--l1"
                  >
                    <div className="_memory-detail-skel-atomic-head">
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--brand" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                    </div>
                    <div className="_memory-detail-skel-body">
                      <div
                        className="_memory-detail-skel-line"
                        style={{ width: `${88 - i * 6}%` }}
                      />
                      <div
                        className="_memory-detail-skel-line"
                        style={{ width: `${64 - i * 8}%` }}
                      />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : searchable && mode === 'search' && searchResults === null ? (
          /* Search mode but no search executed yet: show guidance, and do not fall through to the browse list (otherwise content not changing after a mode switch would mislead).
             Placed before rangeTooLarge -- search is not limited by time range and should not be hidden by "range too large". */
          <div className="_memory-detail-empty">{t('memory.detail.searchPrompt')}</div>
        ) : !isSearching && rangeTooLarge ? (
          <div className="_memory-detail-empty _memory-detail-empty--warn">
            {t('memory.detail.rangeTooLarge')}
          </div>
        ) : layer === 'L0' ? (
          isSearching ? (
            searchResults!.length === 0 ? (
              <div className="_memory-detail-empty">{t('memory.detail.searchEmpty')}</div>
            ) : (
              /* L0 search results: conversation message style (role + bubble + relevance) */
              <div className="_memory-chat-scroll">
                <div className="_memory-chat-list">
                  {searchResults!.map((msg, idx) => {
                    const role = extractRole(msg.role || msg.title || '');
                    const body = msg.body;
                    const tone = toneOfRole(role);
                    const time = formatDisplayTime(msg.created_at);
                    return (
                      <div
                        key={msg.id || idx}
                        className={`_memory-chat-row _memory-chat-row--${tone}`}
                      >
                        <div className="_memory-chat-main">
                          <div className="_memory-chat-meta">
                            <span className="_memory-chat-role">{role.toUpperCase()}</span>
                            {time && (
                              <span className="_memory-chat-time" title={msg.created_at}>
                                {time}
                              </span>
                            )}
                            {typeof msg.score === 'number' && (
                              <span className="_memory-detail-search-score">
                                {t('memory.detail.searchScore', { score: msg.score.toFixed(2) })}
                              </span>
                            )}
                          </div>
                          <div className={`_memory-chat-bubble _memory-chat-bubble--${tone}`}>
                            <pre className="_memory-chat-body">{body}</pre>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          ) : block.layers.L0.length > 0 ? (
            <div className="_memory-chat-scroll" ref={l0ScrollRef} onScroll={handleL0Scroll}>
              {/* Top: load earlier conversation (auto-triggered by scrolling to the top, also clickable).
                  The top hint area is kept when loading / more available / at the end (l0Ended) / more than one page */}
              {(l0HasMore ||
                l0MoreLoading ||
                block.l0Ended ||
                block.layers.L0.length > layerPageSize) && (
                <div className="_memory-chat-more">
                  {l0MoreLoading ? (
                    <span className="_memory-chat-more-loading">
                      <span className="_memory-chat-more-spinner" />
                      {t('memory.detail.loading')}
                    </span>
                  ) : l0HasMore ? (
                    <button
                      type="button"
                      className="_memory-chat-more-btn"
                      onClick={triggerL0LoadMore}
                    >
                      {t('memory.detail.loadMore')}
                    </button>
                  ) : (
                    <span className="_memory-chat-more-end">{t('memory.detail.allLoaded')}</span>
                  )}
                </div>
              )}
              <div className="_memory-chat-list">
                {/* The backend returns the newest conversation first from top to bottom; the chat view must reverse it to "old on top, new at the bottom" */}
                {[...block.layers.L0].reverse().map((msg, idx) => {
                  const role = extractRole(msg.role || msg.title || '');
                  const body = msg.body;
                  const tone = toneOfRole(role);
                  const time = formatDisplayTime(msg.created_at);

                  // system: centered full-width capsule hint, not using the avatar + bubble layout
                  if (tone === 'system') {
                    return (
                      <div key={msg.id || idx} className="_memory-chat-system">
                        <InfoCircleIcon size={12} />
                        <span className="_memory-chat-system-text">{body}</span>
                        {time && <span className="_memory-chat-system-time">{time}</span>}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={msg.id || idx}
                      className={`_memory-chat-row _memory-chat-row--${tone}`}
                    >
                      <div className="_memory-chat-main">
                        <div className="_memory-chat-meta">
                          <span className="_memory-chat-role">{role.toUpperCase()}</span>
                          {time && (
                            <span className="_memory-chat-time" title={msg.created_at}>
                              {time}
                            </span>
                          )}
                        </div>
                        <div className={`_memory-chat-bubble _memory-chat-bubble--${tone}`}>
                          <pre className="_memory-chat-body">{body}</pre>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="_memory-detail-empty">
              {showTimeFilter ? t('memory.detail.noL0InRange') : t('memory.detail.noL0')}
            </div>
          )
        ) : isSearching ? (
          searchResults!.length === 0 ? (
            <div className="_memory-detail-empty">{t('memory.detail.searchEmpty')}</div>
          ) : (
            /* L1 search results: atomic memory style (L0 search already renders chat style in the L0 branch) */
            <AtomicList
              layer={layer}
              items={searchResults!}
              loadingItemId={layerItemLoadingId}
              timeFiltered={layer === 'L1' && showTimeFilter && !isSearching}
              canEdit={canEdit && !!onSaveLayerItem}
              onEdit={openEdit}
            />
          )
        ) : layer === 'L2' ? (
          /* L2 scene memory: standalone component, body loaded on demand + collapse/expand animation */
          <L2AtomicList
            items={block.layers.L2}
            onLoadItem={onLayerItemLoad}
            loadingItemId={layerItemLoadingId}
            canEdit={canEdit && !!onSaveLayerItem}
            onEdit={openEdit}
          />
        ) : (
          <AtomicList
            layer={layer}
            items={block.layers[layer]}
            loadingItemId={layerItemLoadingId}
            timeFiltered={layer === 'L1' && showTimeFilter && !isSearching}
            canEdit={canEdit && !!onSaveLayerItem}
            onEdit={openEdit}
          />
        )}
        {showPager && !isSearching && (
          <div className="_memory-detail-pager">
            <Pagination
              pageIndex={safePage + 1}
              pageSize={layerPageSize}
              recordCount={total}
              pageSizeVisible={false}
              onPagingChange={(query) => {
                if (query.pageIndex) onLayerPageChange(query.pageIndex - 1);
              }}
            />
          </div>
        )}
      </div>

      {/* Edit Modal (shared by L1/L2/L3): the body is overwritten via a multi-line input */}
      {editing && (
        <Modal
          visible
          caption={t('memory.detail.editTitle', { layer: editing.layer })}
          size="xl"
          onClose={() => {
            if (!saving) setEditing(null);
          }}
          disableEscape={saving}
        >
          <Modal.Body>
            <div className="_memory-detail-edit-name" title={editing.title}>
              {editing.title}
            </div>
            <Input.TextArea
              size="full"
              className="_memory-detail-edit-textarea"
              value={editContent}
              onChange={(v) => setEditContent(v)}
              disabled={saving}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button type="primary" onClick={() => void saveEdit()} loading={saving}>
              {t('memory.detail.save')}
            </Button>
            <Button onClick={() => setEditing(null)} disabled={saving}>
              {t('memory.detail.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
