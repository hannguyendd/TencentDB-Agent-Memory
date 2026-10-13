/**
 * TaskImportDialog -- "Import Task" dialog.
 *
 * Structure:
 *   1. When unauthenticated, a **token mini-dialog** (CredentialGate) pops up first; the main page appears only after authentication passes.
 *   2. Main page = filter bar (project / type / title / assignee) -> table (select / title / status) -> pagination -> submit / cancel.
 *
 * Key conventions:
 *   - The token lives only in component memory, lost on close, never entering localStorage or being persisted.
 *   - **Cross-page selection is preserved**: Map<`${item_type}:${external_id}`, CandidateItem>.
 *     The three kinds of work items have ids of the same shape (19-digit strings); without a type prefix they would overwrite each other.
 *   - **Batch failure isolation**: the backend processes item by item, and results are split into created / failed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Checkbox,
  ExternalLink,
  Form,
  Input,
  Justify,
  Modal,
  Pagination,
  Segment,
  Select,
  Space,
  Table,
  Text,
} from 'tea-component';
import {
  taskSourceApi,
  type CandidateItem,
  type Credential,
  type TaskSourceProvider,
  type TaskWorkspace,
} from '../../../lib/api/taskSource';
import { useSourceLabel } from '../utils/workbench-utils';
import { invalidateBackendCache } from '@/stores/backend';
import { tea } from '@/lib/tea-bridge';
import { getPanelSession } from '@/lib/panelSession';

const { autotip, selectable } = Table.addons;

const DEFAULT_PAGE_SIZE = 10;

/**
 * Selectable page sizes.
 *
 * The upper limit of 100 is a **server-side constraint**, enforced in both places:
 *   - Core input validation `limit: z.coerce.number().int().min(1).max(100)`;
 *   - the TAPD provider's `clampLimit()` also truncates at MAX_LIMIT=100.
 * Going any higher would only be silently truncated, turning "200 per page" into a deceptive option.
 */
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/**
 * Key for cross-page selection: it must carry a type prefix, because the three kinds of work items have ids of the same shape.
 *
 * If external_id / item_type is missing (happens when the backend field naming is inconsistent with the frontend),
 * `undefined:undefined` would make **all rows share the same key** -- manifesting as "check one, all get checked".
 * Therefore rowKey is injected when the data lands: when the fields are complete use `type:id`, when missing add the array index as a fallback,
 * ensuring any two rows have different keys.
 */
function withRowKey(items: CandidateItem[]): Row[] {
  return items.map((it, idx) => ({
    ...it,
    rowKey: it.item_type && it.external_id ? `${it.item_type}:${it.external_id}` : `__row_${idx}`,
  }));
}

/** Candidate item carrying a stable row identifier. */
type Row = CandidateItem & { rowKey: string };

/**
 * Build the token to submit according to the provider's declared auth scheme.
 *
 * The header name of the custom scheme **must come from the AuthScheme.headerName sent by the backend** --
 * hard-coding a specific source's header would make a second custom source send the wrong header (a real bug).
 */
function buildCredential(
  kind: 'bearer' | 'basic' | 'custom',
  secret: string,
  headerName?: string,
): Credential {
  if (kind === 'custom') {
    return { kind, secret, extra: headerName ? { header: headerName } : undefined };
  }
  return { kind, secret };
}

/** Minimum length of a TAPD token (both Taihu tokens and personal tokens are far longer than this). */
const MIN_TOKEN_LEN = 20;

/**
 * Frontend pre-validation.
 *
 * A real token cannot be this short, nor contain an ellipsis -- these two traits indicate the user treated the
 * **example text in the UI** as what to fill in (it has happened: the example literal was filled in directly).
 * Blocking before submission is much easier than letting the server return an empty project list and then investigating.
 *
 * The validation relies only on the two **source-independent** traits of "length / ellipsis",
 * and does not judge the token prefix or format -- that is the source side's authentication detail.
 */
function validateToken(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'empty';
  // Inside a character class `.` is already a literal and needs no escaping (escaping would trigger no-useless-escape).
  if (/[….]{2,}|…/.test(v)) return 'placeholder';
  if (v.length < MIN_TOKEN_LEN) return 'tooShort';
  return null;
}

/**
 * Token collection mini-dialog.
 *
 * "List projects" also serves as connectivity validation: an invalid token errors out here,
 * and no separate verify endpoint is set up (one fewer endpoint, one fewer round trip).
 */
function CredentialGate(props: {
  provider: TaskSourceProvider;
  /** Source display name (already localized), used for the dialog title. */
  sourceLabel: string;
  teamId: string;
  onAuthed: (credential: Credential, workspaces: TaskWorkspace[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const schemes = props.provider.auth_schemes;
  const [kind, setKind] = useState<'bearer' | 'basic' | 'custom'>(schemes[0]?.kind ?? 'bearer');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The currently selected auth method (both the hint text and the request page change with it). */
  const activeScheme = schemes.find((s) => s.kind === kind);

  async function submit() {
    const problem = validateToken(value);
    if (problem) {
      setError(t(`taskImport.tokenInvalid.${problem}`));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const scheme = schemes.find((s) => s.kind === kind);
      const credential = buildCredential(
        kind,
        value.trim(),
        scheme?.kind === 'custom' ? scheme.headerName : undefined,
      );
      const res = await taskSourceApi.workspaces(props.teamId, props.provider.id, credential);
      const ws = res.workspaces ?? [];
      // The token is valid but the account has no projects -- show a clear notice, to avoid the misconception that "the panel didn't load".
      if (!ws.length) {
        setError(t('taskImport.noWorkspaces'));
        return;
      }
      props.onAuthed(credential, ws);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      visible
      caption={t('taskImport.captionFrom', { source: props.sourceLabel })}
      size="s"
      onClose={props.onCancel}
      disableEscape={loading}
    >
      <Modal.Body>
        {error && <Alert type="error">{error}</Alert>}
        {/* vertical layout: the control area is block-level, so Input size="full" is needed to fill the dialog width
            (tea 2.8.0's Space is inline-flex + align-items:center and doesn't pass through style, so it can't stretch) */}
        <Form layout="vertical" style={{ width: '100%' }}>
          {/* Auth methods as a mutually exclusive radio: no need to make the user choose when there is only one method */}
          {schemes.length > 1 && (
            <Form.Item>
              <Segment
                value={kind}
                onChange={(next) => setKind(next as typeof kind)}
                options={schemes.map((s) => ({ value: s.kind, text: s.label }))}
              />
            </Form.Item>
          )}
          {/*
            Token request/view guide: the address is issued by deployment config (one per auth method).
            Like the iWiki / Gongfeng source registration dialogs, it is attached to the Form.Item's extra -- not rendered when unconfigured,
            **no built-in fallback address** (the domain is deployment information, and hard-coding would point at the wrong environment).
            External links go through ExternalLink (forced _blank), and rel must be passed explicitly to prevent tabnabbing.
          */}
          <Form.Item
            extra={
              activeScheme?.token_doc_url ? (
                <ExternalLink href={activeScheme.token_doc_url} rel="noopener noreferrer">
                  {t('taskImport.tokenDoc')}
                </ExternalLink>
              ) : undefined
            }
          >
            <Input
              type="password"
              size="full"
              placeholder={t('taskImport.tokenPlaceholder')}
              value={value}
              onChange={(v) => setValue(v)}
            />
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={props.onCancel}>{t('common.cancel')}</Button>
        <Button type="primary" disabled={!value.trim() || loading} onClick={() => void submit()}>
          {t('taskImport.connect')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export default function TaskImportDialog(props: {
  teamId: string;
  providers: TaskSourceProvider[];
  /** The source id to import now (passed in from the item selected in the "Import Task" dropdown). */
  providerId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const sourceLabel = useSourceLabel();
  // Locate the source by id (no longer "take the first one"): in the multi-source case, whichever is chosen is used.
  const provider = props.providers.find((p) => p.id === props.providerId);
  const providerLabel = provider ? sourceLabel(provider.id) : '';

  /** Auth state: non-null means the token validation has passed. */
  const [credential, setCredential] = useState<Credential | null>(null);
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);

  // Filter conditions
  const [workspaceId, setWorkspaceId] = useState('');
  const [itemTypes, setItemTypes] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  /**
   * "Assignee" defaults to the current user's **username**.
   *
   * Note it is not user_id: `user_id` looks like `usr-xxx`, while TAPD's assignee accounts are
   * like `wlleiiwang` -- filling it wrong yields 0 results and is hard to notice.
   * When username cannot be obtained (not logged in, etc.) leave it empty and let the user fill it in.
   */
  const [owner, setOwner] = useState(() => getPanelSession()?.user?.username ?? '');

  /**
   * Whether this source supports "To-do" (declared by the backend capabilities, not assumed by the frontend).
   * Sources that don't support it show no toggle and don't send only_todo.
   */
  const supportsTodo = provider?.capabilities?.todo === true;

  /**
   * "To-do" toggle: on by default for sources that support the capability.
   *
   * Checked -> use the source's to-do endpoint (only the current token user's to-do items);
   * Unchecked -> use the regular endpoint (can filter by title / assignee).
   * The to-do endpoint does not support title and assignee parameters (passing them gets rejected by the server), so these two inputs are disabled when checked.
   */
  const [onlyTodo, setOnlyTodo] = useState(supportsTodo);

  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<Map<string, Row>>(new Map());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxBatch = provider?.max_batch_size ?? 50;
  const selectedList = useMemo(() => [...selected.values()], [selected]);
  const selectedKeys = useMemo(() => [...selected.keys()], [selected]);
  const overLimit = selectedList.length > maxBatch;

  /**
   * All rows seen (accumulated across pages).
   *
   * The selectable plugin's onChange only passes back the **key array**, while submission needs the whole row data
   * (external_id / item_type / scope). After paging, the previous page's rows are no longer in `items`,
   * and the current page alone cannot restore the previously checked old rows, so a ref accumulates a key -> Row dictionary.
   */
  const seenRowsRef = useRef<Map<string, Row>>(new Map());

  const loadCandidates = useCallback(async () => {
    if (!provider || !credential) return;
    // workspace_id is a required input only for the regular list endpoint; optional for the to-do endpoint
    // (not passing = all to-dos across projects), so selecting no project is allowed in to-do mode.
    if (!onlyTodo && !workspaceId) {
      setError(t('taskImport.needWorkspace'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await taskSourceApi.candidates(props.teamId, provider.id, credential, {
        workspace_id: workspaceId || undefined,
        item_types: itemTypes.length ? itemTypes : undefined,
        // The server does not accept these two parameters in to-do mode, so they are simply not sent.
        keyword: !onlyTodo && keyword.trim() ? keyword.trim() : undefined,
        owner: !onlyTodo && owner.trim() ? owner.trim() : undefined,
        page,
        limit: pageSize,
        only_todo: onlyTodo,
      });
      const rows = withRowKey(res.items ?? []);
      // First register in "rows seen", then hand to the table -- ensuring the row data can always be found when selectable passes back keys
      for (const row of rows) seenRowsRef.current.set(row.rowKey, row);
      setItems(rows);
      setTotal(res.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [
    provider,
    credential,
    workspaceId,
    itemTypes,
    keyword,
    owner,
    onlyTodo,
    page,
    pageSize,
    props.teamId,
    t,
  ]);

  /**
   * Trigger timing of auto query: **authentication complete** + **page change / page size change** + **toggling the to-do switch**.
   *
   * Changes to the other filter conditions (project / type / title / assignee) do **not** automatically send requests --
   * a single TAPD query involves multiple type endpoints + a status mapping table, and triggering character by character would overwhelm the gateway.
   *
   * The to-do toggle is an exception: it is "switching to a different data source" rather than "adding a filter condition",
   * and to-do mode has no usable filter parameters (title/assignee are disabled), so clicking "Filter" gives no extra information,
   * and making the user click again is pure redundancy. Toggling queries immediately.
   */
  useEffect(() => {
    if (!credential) return;
    void loadCandidates();
    // loadCandidates serves only as a stable reference; the trigger timing is controlled by the three above + the "Filter" button.
    // workspaceId / keyword / owner are deliberately not in the dependencies: changing them does not automatically send a request, and "Filter" must be clicked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential, page, pageSize, onlyTodo]);

  /**
   * "Filter" button: after the filter conditions change, return to page 1 and then query.
   * If already on page 1, it must be triggered manually once (the useEffect dependencies are unchanged so it won't re-run).
   */
  function applyFilter() {
    if (page === 1) void loadCandidates();
    else setPage(1);
  }

  function onAuthed(cred: Credential, ws: TaskWorkspace[]) {
    setCredential(cred);
    setWorkspaces(ws);
    // By default **no specific project is selected** (= "All projects"): to-do is the default-on data source,
    // and the to-do endpoint's workspace_id is optional, so not passing it means across projects, with the widest coverage.
    // In regular mode the project is required; unchecking "To-do" automatically falls back to the first project (see the checkbox onChange).
    setWorkspaceId('');
  }

  /**
   * The selectable plugin's selection callback.
   *
   * The plugin only recognizes keys: the returned `keys` is "this page's result after changes + the existing keys of other pages"
   * (CheckTree adds/removes inside based on the full set of the passed value, and keeps unrecognized keys as they are),
   * so cross-page selection is naturally not lost. Here the Map is rebuilt by key, and row data is taken from seenRowsRef.
   */
  function handleSelectChange(keys: string[]) {
    setSelected((prev) => {
      const next = new Map<string, Row>();
      for (const key of keys) {
        const row = seenRowsRef.current.get(key) ?? prev.get(key);
        if (row) next.set(key, row);
      }
      return next;
    });
  }

  async function submit() {
    if (!provider || !credential || overLimit || !selectedList.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await taskSourceApi.import(
        props.teamId,
        provider.id,
        credential,
        selectedList.map((i) => ({
          external_id: i.external_id,
          item_type: i.item_type,
          scope: i.scope,
        })),
      );
      tea.notify.success(
        t('taskImport.result', {
          created: res.created?.length ?? 0,
          failed: res.failed?.length ?? 0,
        }),
      );
      props.onImported();
      invalidateBackendCache();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (!provider) return null;

  // Unauthenticated: show only the token mini-dialog.
  if (!credential) {
    return (
      <CredentialGate
        provider={provider}
        sourceLabel={providerLabel}
        teamId={props.teamId}
        onAuthed={onAuthed}
        onCancel={props.onClose}
      />
    );
  }

  return (
    <Modal
      visible
      caption={t('taskImport.captionFrom', { source: providerLabel })}
      size="l"
      onClose={props.onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        {error && <Alert type="error">{error}</Alert>}
        {overLimit && <Alert type="warning">{t('taskImport.overLimit', { max: maxBatch })}</Alert>}

        {/* Filter bar: inline form, wraps automatically when there are many items (Justify is not used to split left and right
            -- the 4 conditions on the left would squeeze the right column's width and squash the "To-do" text into vertical layout) */}
        <Table.ActionPanel>
          <Form layout="inline">
            {/*
              The project is **required** in regular mode: stories_get / tasks_get / bugs_get all require
              workspace_id, and omitting it directly errors with "workspace_id is missing from the current parameters".
              Optional in to-do mode: not passing it takes all of the current user's to-dos across projects.
            */}
            <Form.Item label={t('taskImport.workspace')}>
              <Select
                appearance="button"
                matchButtonWidth
                searchable
                value={workspaceId}
                onChange={(v) => setWorkspaceId(v)}
                disabled={!workspaces.length}
                placeholder={t('taskImport.selectWorkspace')}
                options={[
                  ...(supportsTodo && onlyTodo
                    ? [{ value: '', text: t('taskImport.allWorkspaces') }]
                    : []),
                  ...workspaces.map((w) => ({ value: w.id, text: w.name })),
                ]}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.type')}>
              <Select
                appearance="button"
                matchButtonWidth
                value={itemTypes[0] ?? ''}
                onChange={(v) => setItemTypes(v ? [v] : [])}
                options={[
                  { value: '', text: t('taskImport.allTypes') },
                  ...provider.item_types.map((it) => ({ value: it.id, text: it.label })),
                ]}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.title')}>
              <Input
                placeholder={t('taskImport.titlePlaceholder')}
                value={keyword}
                onChange={(v) => setKeyword(v)}
                disabled={onlyTodo}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.owner')}>
              <Input
                placeholder={t('taskImport.ownerPlaceholder')}
                value={owner}
                onChange={(v) => setOwner(v)}
                disabled={onlyTodo}
              />
            </Form.Item>

            {/* To-do toggle: shown only when the source declares support (capabilities.todo) */}
            {supportsTodo && (
              <Form.Item>
                <Checkbox
                  value={onlyTodo}
                  tooltip={t('taskImport.onlyTodoHint')}
                  onChange={(next) => {
                    setOnlyTodo(next);
                    // Regular mode requires a project, while "All projects" only makes sense in to-do mode --
                    // when switching back to regular mode, if still on an empty value, fall back to the first project, otherwise the endpoint reports missing workspace_id.
                    if (!next && !workspaceId && workspaces.length) {
                      setWorkspaceId(workspaces[0].id);
                    }
                    // The data source changed and the previous results no longer apply -- clear the selection to avoid mixing in items from the old mode.
                    setSelected(new Map());
                    setPage(1);
                  }}
                >
                  {t('taskImport.onlyTodo')}
                </Checkbox>
              </Form.Item>
            )}

            {/* Explicit trigger entry: changes to filter conditions don't automatically send requests; the query runs only after clicking.
                The project is optional in to-do mode (none selected = across projects), so it can't be disabled based on workspaceId. */}
            <Form.Item>
              <Button
                type="primary"
                disabled={loading || (!onlyTodo && !workspaceId)}
                onClick={applyFilter}
              >
                {t('taskImport.filter')}
              </Button>
            </Form.Item>
          </Form>
        </Table.ActionPanel>

        {/* Table: the selection column is injected by the selectable plugin (including header select-all, indeterminate state, whole row clickable) */}
        <Table<Row>
          records={items}
          recordKey={(r) => r.rowKey}
          columns={[
            { key: 'title', header: t('taskImport.title'), render: (i: CandidateItem) => i.title },
            {
              key: 'status',
              header: t('taskImport.status'),
              width: 120,
              render: (i: CandidateItem) =>
                i.status ? <Text>{i.status}</Text> : <Text theme="weak">-</Text>,
            },
          ]}
          addons={[
            // Only wire isLoading: `error` also carries submit failures, and using it to drive the table's "load failed" state would misreport
            autotip({ isLoading: loading }),
            selectable({
              value: selectedKeys,
              onChange: handleSelectChange,
              rowSelect: true,
            }),
          ]}
        />

        {/* Server-side pagination: both page number and page size are controlled, and the page size dropdown is the limit.
            tea 2.8.0's Pagination has no disabled prop, so operations are blocked in the callback while loading. */}
        <Pagination
          recordCount={total}
          pageIndex={page}
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          stateText={t('taskImport.total', { count: total })}
          onPagingChange={({ pageIndex, pageSize: nextSize }) => {
            if (loading) return;
            // When the page size changes the component has already reset pageIndex to 1 (isPagingReset defaults to true),
            // so sending both values down together suffices, with no need to distinguish page change from page size change.
            if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
            if (pageIndex) setPage(pageIndex);
          }}
        />
      </Modal.Body>
      <Modal.Footer>
        <Justify
          left={<Text reset>{t('taskImport.selected', { count: selectedList.length })}</Text>}
          right={
            <Space>
              <Button onClick={props.onClose}>{t('common.cancel')}</Button>
              <Button
                type="primary"
                disabled={!selectedList.length || overLimit || submitting}
                onClick={() => void submit()}
              >
                {t('taskImport.submit')}
              </Button>
            </Space>
          }
        />
      </Modal.Footer>
    </Modal>
  );
}
