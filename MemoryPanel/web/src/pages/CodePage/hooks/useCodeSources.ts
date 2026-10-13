/**
 * useCodeSources -- all state and data logic of the Code asset page.
 * The component layer keeps only JSX rendering; state / data logic is centralized here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  knowledgeApi,
  type CodeGraphDetail,
  type SourceProviderMeta,
} from '@/lib/api/knowledge-api';
import { useTeams, useAgents } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { isValidGitHttpUrl, formatRepoName, type ScopeTab, type StatusFilter, type SubView, type ViewMode } from '../constants/code-constants';

export function useCodeSources() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<CodeGraphDetail[]>([]);
  const [loading, setLoading] = useState(false);
  // Show Agent assets (fixed) by default, so users don't mistakenly think their assets are in "Team assets"
  const [scopeTab, setScopeTab] = useState<ScopeTab>('fixed');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [inFlight, setInFlight] = useState<CodeGraphDetail[]>([]);

  // Detail view state
  const [subView, setSubView] = useState<SubView>('list');
  const [selectedCgId, setSelectedCgId] = useState('');

  // Register dialog state
  const [showRegister, setShowRegister] = useState(false);
  const [formRepo, setFormRepo] = useState('');
  const [formBranch, setFormBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);

  // External source (e.g. Gongfeng): '' = public repo
  const [formSourceType, setFormSourceType] = useState('');
  const [sourceProviders, setSourceProviders] = useState<SourceProviderMeta[]>([]);
  /**
   * Credential field values temporarily entered in the dialog (stored dynamically per provider.form_fields);
   * in memory only, cleared immediately after submission, never written to localStorage.
   * key = field name (`secret` / `username` / others in future).
   */
  const [formCredential, setFormCredential] = useState<Record<string, string>>({});
  const setCredentialField = (name: string, value: string) =>
    setFormCredential((prev) => ({ ...prev, [name]: value }));

  // Allocate-to-agent dialog state
  const [allocateTarget, setAllocateTarget] = useState<{
    cgId: string;
    repo: string;
    branch: string;
  } | null>(null);
  const [selectedCodeAsset, setSelectedCodeAsset] = useState<{
    cgId: string;
    repo: string;
    branch: string;
  } | null>(null);
  const { activeTeamId, activeTeam } = useTeams();
  const auth = readAuth();
  const currentUser = auth?.user_id ?? '';
  // The fixed-asset tab lists only agents the user owns (consistent with the ChatMemory / Skills panels,
  // and also matching doc section 4.2 permission rules: agent-fixed only allows viewing agents the caller owns).
  const { agents: allAgents } = useAgents(activeTeamId);
  const teamAgents = useMemo(
    () =>
      allAgents
        .filter((a) => a.owner_user_id === currentUser)
        .map((a) => ({ id: a.agent_id, name: a.name })),
    [allAgents, currentUser],
  );
  // The agent_id selected under the fixed tab
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [fixedBoundIds, setFixedBoundIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (teamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !teamAgents.some((a) => a.id === agentFilter)) {
      setAgentFilter(teamAgents[0].id);
    }
  }, [teamAgents, agentFilter]);

  const fetchFixedBindings = useCallback(async () => {
    if (!agentFilter) {
      setFixedBoundIds(new Set());
      return;
    }
    try {
      const items = await knowledgeApi.code.agentFixed(agentFilter);
      setFixedBoundIds(new Set(items.map((it) => it.knowledge_id)));
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('code.notify.loadFixedFailed'));
      setFixedBoundIds(new Set());
    }
  }, [agentFilter, t]);

  useEffect(() => {
    if (scopeTab === 'fixed') void fetchFixedBindings();
  }, [scopeTab, fetchFixedBindings]);

  const displaySources = useMemo(() => {
    // inFlight = repos just registered or just clicked "Sync", whose status is refreshed live by code.get polling.
    // For the same id, inFlight takes precedence over sources: otherwise the detail header would only show the status in the
    // teamAssets snapshot at the moment of the 202, and polling results would never be reflected in the UI.
    if (inFlight.length === 0) return sources;
    const inFlightMap = new Map(inFlight.map((x) => [x.code_graph_id, x]));
    const sourceIds = new Set(sources.map((s) => s.code_graph_id));
    // Those not yet in teamAssets (just registered, meta not yet recorded) are placed first as placeholders
    const extras = inFlight.filter((x) => x.code_graph_id && !sourceIds.has(x.code_graph_id));
    return [...extras, ...sources.map((s) => inFlightMap.get(s.code_graph_id) ?? s)];
  }, [sources, inFlight]);

  const scopeSources = useMemo(() => {
    if (scopeTab === 'team') return displaySources;
    if (scopeTab === 'fixed') {
      if (!agentFilter) return [];
      return displaySources.filter(
        (source) => source.code_graph_id && fixedBoundIds.has(source.code_graph_id),
      );
    }
    return displaySources;
  }, [displaySources, scopeTab, agentFilter, fixedBoundIds]);

  // Stats follow only the current asset scope, so search or status filters don't distort the overview data.
  const stats = useMemo(
    () => ({
      total: scopeSources.length,
      ready: scopeSources.filter((source) => source.status === 'ready').length,
      processing: scopeSources.filter(
        (source) => source.status === 'pending' || source.status === 'processing',
      ).length,
      totalFiles: scopeSources.reduce((total, source) => total + (source.stats?.files ?? 0), 0),
    }),
    [scopeSources],
  );

  const filteredSources = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return scopeSources.filter((source) => {
      const isProcessing = source.status === 'pending' || source.status === 'processing';
      const isError = source.status === 'failed' || source.status === 'missing';
      if (statusFilter === 'ready' && source.status !== 'ready') return false;
      if (statusFilter === 'processing' && !isProcessing) return false;
      if (statusFilter === 'error' && !isError) return false;
      if (!normalizedKeyword) return true;
      return [
        source.repo_name,
        source.repo_url,
        source.branch,
        source.code_graph_id,
        source.owner_user_id ?? '',
        source.commit_hash ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedKeyword));
    });
  }, [scopeSources, keyword, statusFilter]);

  // Detail: search & explore
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState('');
  const [exploreQuery, setExploreQuery] = useState('');
  const [exploring, setExploring] = useState(false);
  const [exploreResult, setExploreResult] = useState('');

  // Request sequence number against races: when switching tabs quickly, an earlier request may return later,
  // and the old tab's data would overwrite the new tab's data. Each fetch increments the sequence number,
  // and when the response returns, check whether the number is still the latest; if not, discard it.
  const fetchSeqRef = useRef(0);

  const fetchSources = useCallback(async () => {
    if (!activeTeamId) {
      setSources([]);
      setLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    // Clear old data immediately -- otherwise when switching tabs the previous tab's list is seen first,
    // then suddenly replaced when new data arrives, which visually looks like a "flash".
    setSources([]);
    try {
      // Assets are uniformly team-scoped (visibility=team), with no private / "my assets" concept.
      // The fixed tab also fetches all team assets, then filters by fixedBoundIds.
      const data = await knowledgeApi.code.teamAssets(activeTeamId);
      if (seq !== fetchSeqRef.current) return; // Superseded by a later request
      setSources(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error(e);
      setSources([]);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [activeTeamId, scopeTab]);

  // Trigger fetchSources: depends on the raw params + fetchSources, and dedupes with a key to prevent repeated triggers in a short time.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    const key = `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchSources();
  }, [activeTeamId, scopeTab, fetchSources]);

  // Ref mirror of inFlight: the poll closure reads the latest value via the ref,
  // avoiding putting inFlight in the effect dependencies -- otherwise every setInFlight (even if the content is unchanged and
  // only the array reference changed) would re-trigger the effect -> immediate poll -> setInFlight again -> infinite loop.
  const inFlightRef = useRef<CodeGraphDetail[]>([]);
  inFlightRef.current = inFlight;
  const hasInFlight = inFlight.length > 0;

  useEffect(() => {
    if (!activeTeamId || !hasInFlight) return;
    const poll = async () => {
      const items = inFlightRef.current;
      if (items.length === 0) return;
      const toRemove: string[] = [];
      const updates: CodeGraphDetail[] = [];
      for (const item of items) {
        if (!item.code_graph_id) continue;
        try {
          const detail = await knowledgeApi.code.get(item.code_graph_id);
          if (detail.status === 'ready') {
            try {
              await knowledgeApi.code.registerMeta(activeTeamId, detail.code_graph_id);
            } catch (e: unknown) {
              // Idempotent: asset already exists / 409 -> ignore; report other real errors for troubleshooting
              // (the callback S2S is the main path, this is only a fallback, but failures must be visible)
              const msg = e instanceof Error ? e.message : String(e);
              if (!/already|exist|409|registered|ok/i.test(msg)) {
                tea.notify.error(t('code.notify.metaFailed', { msg }));
              }
            }
            toRemove.push(detail.code_graph_id);
            void fetchSources();
          } else {
            // Record an update only when the status actually changes, avoiding a pointless setInFlight triggering a re-render
            if (detail.status !== item.status) updates.push(detail);
          }
        } catch {
          /* ignore transient poll errors */
        }
      }
      if (toRemove.length > 0 || updates.length > 0) {
        setInFlight((prev) => {
          let next = prev;
          if (toRemove.length > 0) {
            const removeSet = new Set(toRemove);
            next = next.filter((x) => !removeSet.has(x.code_graph_id));
          }
          if (updates.length > 0) {
            const updMap = new Map(updates.map((u) => [u.code_graph_id, u]));
            next = next.map((x) => updMap.get(x.code_graph_id) ?? x);
          }
          return next;
        });
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 8000);
    return () => clearInterval(timer);
  }, [hasInFlight, activeTeamId, fetchSources, t]);

  async function handleUnbindCode(codeGraphId: string) {
    if (!agentFilter) return;
    const ok = await tea.confirm({
      message: t('code.confirm.unbind'),
      description: t('code.confirm.unbind.desc'),
      okText: t('code.confirm.unbind.ok'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.code.unbind(codeGraphId, agentFilter);
      tea.notify.success(t('code.notify.unbound'));
      if (selectedCodeAsset?.cgId === codeGraphId) setSelectedCodeAsset(null);
      await fetchFixedBindings();
      await fetchSources();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('code.notify.unbindFailed'));
    }
  }

  /**
   * Load the source list when the register dialog opens. Failures degrade silently (the form falls back to public repos only).
   *
   * No longer queries "the sources the current user has configured" -- credentials hang on the **resource**, and there is no resource_id before registration,
   * so that concept no longer holds; if registration fails, the user can reconfigure for a specific resource on the list page.
   */
  const openRegister = useCallback(async () => {
    setShowRegister(true);
    if (!activeTeamId) return;
    try {
      const providers = await knowledgeApi.source.providers(activeTeamId);
      setSourceProviders(providers);
    } catch {
      setSourceProviders([]);
    }
  }, [activeTeamId]);

  const handleRegister = async () => {
    const repo = formRepo.trim();
    if (!repo || !formBranch.trim() || !activeTeamId) return;
    if (!isValidGitHttpUrl(repo)) {
      tea.notify.error(t('code.register.invalidUrl'));
      return;
    }
    // Private repo: validate required fields per provider.form_fields
    const provider = sourceProviders.find((p) => p.id === formSourceType);
    if (provider) {
      for (const f of provider.form_fields) {
        if (f.required && !(formCredential[f.name] ?? '').trim()) {
          tea.notify.error(t('code.register.tokenRequired'));
          return;
        }
      }
    }
    setSubmitting(true);
    try {
      // Private repo: pass the credentials along at create time, so KS persists them before enqueuing graph building,
      // avoiding the timing window of "create clones immediately while credentials are not yet written" (otherwise a private repo always gets 401).
      const secret = (formCredential.secret ?? '').trim();
      const username = (formCredential.username ?? '').trim();
      const detail = await knowledgeApi.code.create({
        teamId: activeTeamId,
        repoUrl: repo,
        branch: formBranch.trim(),
        repoName: repo,
        ...(provider && secret
          ? {
              providerId: formSourceType,
              secret,
              ...(username ? { username } : {}),
            }
          : {}),
      });

      setShowRegister(false);
      setFormRepo('');
      setFormBranch('main');
      setFormSourceType('');
      setFormCredential({});
      setScopeTab('team');
      setInFlight((prev) => [
        ...prev.filter((x) => x.code_graph_id !== detail.code_graph_id),
        detail,
      ]);
      tea.notify.info(t('code.notify.registered'));
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSync = async (cgId: string) => {
    try {
      await knowledgeApi.code.sync(cgId);
      // sync is asynchronous, and 202 only means enqueued. Here the repo is put back into inFlight (aligned with handleRegister),
      // leaving the GET polling above to run until status returns to ready; otherwise only one teamAssets snapshot would be pulled,
      // and the detail header would stay forever on the "Building" status of that moment.
      const current =
        sources.find((s) => s.code_graph_id === cgId) ??
        inFlightRef.current.find((x) => x.code_graph_id === cgId);
      if (current) {
        setInFlight((prev) => [
          ...prev.filter((x) => x.code_graph_id !== cgId),
          { ...current, status: 'processing' },
        ]);
      }
      void fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    }
  };

  const handleDelete = async (cgId: string) => {
    const source = sources.find((s) => s.code_graph_id === cgId);
    if (!source) return;
    const ok = await tea.confirm({
      message: t('code.confirm.delete', {
        name: formatRepoName(source.repo_name, source.repo_url),
        branch: source.branch,
      }),
      okText: t('code.action.delete'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.code.delete(cgId);
      // Optimistic update: remove from the local list immediately. Backend deletion is eventually consistent, and fetching teamAssets right after a successful delete
      // may still return the repo, so the list wouldn't change and the page would need a manual refresh. Here we remove it locally first,
      // and fetchSources serves only as a fallback alignment.
      setSources((prev) => prev.filter((x) => x.code_graph_id !== cgId));
      setInFlight((prev) => prev.filter((x) => x.code_graph_id !== cgId));
      if (selectedCodeAsset?.cgId === cgId) setSelectedCodeAsset(null);
      if (selectedCgId === cgId) setSubView('list');
      tea.notify.success(t('code.notify.deleted'));
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    }
  };

  const openDetail = (cgId: string) => {
    setSelectedCgId(cgId);
    setSearchQuery('');
    setSearchResult('');
    setExploreQuery('');
    setExploreResult('');
    setSubView('detail');
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResult('');
    try {
      const res = await knowledgeApi.code.search({ codeGraphId: selectedCgId, query: searchQuery, kind: 'any', limit: 20 });
      setSearchResult(res?.text || JSON.stringify(res, null, 2));
    } catch (e: unknown) {
      setSearchResult('');
      tea.notify.error(e);
    } finally {
      setSearching(false);
    }
  };

  const handleExplore = async () => {
    if (!exploreQuery.trim()) return;
    setExploring(true);
    setExploreResult('');
    try {
      const res = await knowledgeApi.code.explore(selectedCgId, exploreQuery);
      setExploreResult(res?.text || JSON.stringify(res, null, 2));
    } catch (e: unknown) {
      setExploreResult('');
      tea.notify.error(e);
    } finally {
      setExploring(false);
    }
  };

  const selected = displaySources.find((source) => source.code_graph_id === selectedCgId);

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUser,
    teamAgents,
    // list view
    sources,
    displaySources,
    loading,
    scopeTab,
    setScopeTab,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    viewMode,
    setViewMode,
    inFlight,
    setInFlight,
    subView,
    setSubView,
    selectedCgId,
    setSelectedCgId,
    // register
    showRegister,
    setShowRegister,
    formRepo,
    setFormRepo,
    formBranch,
    setFormBranch,
    submitting,
    setSubmitting,
    // External sources
    formSourceType,
    setFormSourceType,
    sourceProviders,
    formCredential,
    setCredentialField,
    setFormCredential,
    openRegister,
    // allocate
    allocateTarget,
    setAllocateTarget,
    selectedCodeAsset,
    setSelectedCodeAsset,
    agentFilter,
    setAgentFilter,
    // detail
    searchQuery,
    setSearchQuery,
    searching,
    searchResult,
    setSearchResult,
    exploreQuery,
    setExploreQuery,
    exploring,
    exploreResult,
    setExploreResult,
    selected,
    // fetch & handlers
    fetchSources,
    fetchFixedBindings,
    handleUnbindCode,
    handleRegister,
    handleSync,
    handleDelete,
    openDetail,
    handleSearch,
    handleExplore,
    // computed
    scopeSources,
    stats,
    filteredSources,
  };
}

export type CodeSourcesStore = ReturnType<typeof useCodeSources>;
