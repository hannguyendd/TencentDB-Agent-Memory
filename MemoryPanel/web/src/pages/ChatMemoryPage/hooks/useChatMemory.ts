/**
 * useChatMemory -- all state and data logic of the Chat Memory page.
 * The component layer keeps only JSX rendering; state / data logic is centralized here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgents, useTeams } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea, confirmThenRun } from '@/lib/tea-bridge';
import { chatMemoryApi, type ChatMemoryBlock, type ChatMemorySearchHit } from '@/lib/teamApi';
import { type MemoryBlock, type MemoryLayer, type ScopeTab } from '../constants/types';
import { useScopeTabLabels } from '../constants/constants';
import {
  buildInitialLayerCounts,
  defaultTimeRange,
  isRangeTooLargeError,
  layerPageSize,
  mapLayerItem,
  type TimeRange,
} from '../utils/memory-utils';
import { getLayerCount } from '../utils/utils';

export function useChatMemory(props: { activeTeamId?: string | null } = {}) {
  const { t } = useTranslation();
  const scopeTabLabels = useScopeTabLabels();
  const auth = readAuth();
  const { activeTeamId: storeActiveTeamId, activeTeam } = useTeams();
  const currentUserId = auth?.user_id ?? '';
  const activeTeamId = props.activeTeamId ?? storeActiveTeamId;
  const { agents: teamAgents } = useAgents(activeTeamId);
  const ownedTeamAgents = useMemo(
    () => teamAgents.filter((a) => a.owner_user_id === currentUserId),
    [teamAgents, currentUserId],
  );

  const [blocks, setBlocks] = useState<MemoryBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layer, setLayer] = useState<MemoryLayer>('L1');
  const [layerPages, setLayerPages] = useState<
    Record<string, Partial<Record<MemoryLayer, number>>>
  >({});
  // Total entry count of each tier "within the current time window" (key: `${blockId}|${layer}`).
  // layerCounts stores the full total (obtained with limit=1 when a block is selected); with a time filter (L0/L1),
  // the BFF's res.total is the in-window count, and pagination must use it, otherwise the page count is inflated.
  const [windowTotals, setWindowTotals] = useState<
    Record<string, Partial<Record<MemoryLayer, number>>>
  >({});
  const [layerLoading, setLayerLoading] = useState(false);
  const [layerItemLoadingId, setLayerItemLoadingId] = useState<string | null>(null);
  // Manual refresh counter: incrementing re-triggers current-tier data loading and the four tier count fetches (driven by effect dependencies).
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Detail page time filter (effective for L0 / L1 only), defaults to "previous day ~ now"
  const [timeRange, setTimeRange] = useState<TimeRange>(() => defaultTimeRange());
  // True when the backend detects that the filter range is too large; BlockDetail shows a hint instead of the empty state
  const [rangeTooLarge, setRangeTooLarge] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAllocate, setShowAllocate] = useState(false);
  // Show Agent assets (fixed) by default, so users don't mistakenly think their assets are in "Team assets"
  const [scopeTab, setScopeTab] = useState<ScopeTab>('fixed');
  const [agentFilter, setAgentFilter] = useState<string>('');

  useEffect(() => {
    if (ownedTeamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !ownedTeamAgents.some((a) => a.agent_id === agentFilter)) {
      setAgentFilter(ownedTeamAgents[0].agent_id);
    }
  }, [ownedTeamAgents, agentFilter]);

  // ── Data loading ──
  // Request sequence number against races: when switching tabs quickly, an earlier request may return later,
  // and the old tab's data would overwrite the new tab's data. Each fetch increments the sequence number,
  // and when the response returns, check whether the number is still the latest; if not, discard it.
  const fetchSeqRef = useRef(0);
  // The team of the previous fetch, used to distinguish "switch team" from "switch tab / switch agent".
  // On team switch, refresh silently (keep the old list until new data arrives), with no empty flash or skeleton;
  // on tab / agent switch, clear + loading as before.
  const prevTeamIdRef = useRef(activeTeamId);
  // Upper limit on consecutive L0 "auto-extend time range" attempts: when reaching the earliest within the window, automatically extend back 24h,
  // until the backend confirms the memory block has no records at earlier times either (reload returns empty -> l0Ended is set).
  // This counter is an extreme-case safeguard (to prevent infinite loops in abnormal situations); a manual filter adjustment resets it as the component remounts.
  const l0AutoExpandCountRef = useRef(0);

  const fetchBlocks = useCallback(async () => {
    if (!activeTeamId) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    // When the fixed tab has no agent selected, no request is sent, but make sure loading is turned off
    if (scopeTab === 'fixed' && !agentFilter) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    // On team switch, refresh silently (keep the old list until new data arrives), with no empty flash or skeleton;
    // on tab / agent switch, still clear + loading.
    const teamChanged = prevTeamIdRef.current !== activeTeamId;
    prevTeamIdRef.current = activeTeamId;
    if (!teamChanged) {
      setBlocksLoading(true);
      // Clear old data immediately -- otherwise when switching tabs the previous tab's list is seen first,
      // then suddenly replaced when new data arrives, which visually looks like a "flash".
      setBlocks([]);
    }
    try {
      let res: { items: ChatMemoryBlock[]; total?: number };
      if (scopeTab === 'fixed') {
        res = await chatMemoryApi.agentFixed(agentFilter);
      } else {
        res = await chatMemoryApi.teamAssets(activeTeamId);
      }
      if (seq !== fetchSeqRef.current) return; // Superseded by a later request
      const mapped: MemoryBlock[] = res.items.map((b) => ({
        id: b.id,
        title: b.title,
        summary: b.summary ?? '',
        tags: [],
        updated_at_ms: b.updated_at_ms,
        agent_id: b.agent_id ?? undefined,
        uploaded_by_user_id: b.uploaded_by_user_id,
        scope: b.scope,
        layer_counts: b.layer_counts,
        bound_agent_count: b.bound_agent_count,
        layers: { L0: [], L1: [], L2: [], L3: [] },
        // Initially fill only the **real** counts (>0) returned by the backend; tiers that are 0 / not yet landed stay undefined = "unknown".
        // The badge of an unknown tier shows a placeholder, and the real count is requested on demand only when the user switches to that layer tab,
        // avoiding pinging the other 3 tiers just because a block was selected (pure prefetching of things the user hasn't viewed).
        layerCounts: buildInitialLayerCounts(b.layer_counts),
      }));
      setBlocks(mapped);
    } catch (e: unknown) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.loadFailed'));
      setBlocks([]);
    } finally {
      if (seq === fetchSeqRef.current) setBlocksLoading(false);
    }
    // Note: setSelectedId is no longer called here -- previously fetchBlocks's useCallback depended
    // on selectedId, so every block selection re-fetched the whole list (the main cause of lag).
    // The default-selection logic is now handled by the separate effect below.
  }, [activeTeamId, scopeTab, agentFilter, t]);

  // Trigger fetchBlocks: depends on the raw params + fetchBlocks, and dedupes with a key to prevent repeated triggers in a short time.
  // Previously a direct `useEffect(() => fetchBlocks(), [fetchBlocks])` would be triggered multiple times as the fetchBlocks reference changed
  // (async sync of dependencies such as agentFilter), causing the same endpoint to be requested repeatedly.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    // Only the fixed tab fetches by agentFilter; the team tab's data source (teamAssets) is unrelated to the selected
    // agent. If agentFilter were included in the team key, after ownedTeamAgents finishes loading asynchronously
    // agentFilter would change from '' to the first agent, changing the key and triggering a **completely duplicate**
    // teamAssets request again (one extra API call on page entry).
    const key =
      scopeTab === 'fixed'
        ? `${activeTeamId}|${scopeTab}|${agentFilter}`
        : `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchBlocks();
  }, [activeTeamId, scopeTab, agentFilter, fetchBlocks]);

  // After the list changes, clear the selection only if the currently selected memory block is no longer in the list.
  // Entering the page does not auto-select the first one (consistent with skill behavior); details load after the user clicks.
  useEffect(() => {
    if (selectedId && !blocks.some((b) => b.id === selectedId)) {
      setSelectedId(null);
    }
  }, [blocks, selectedId]);

  // ── Tier paginated loading ──
  const selected = useMemo(
    () => (selectedId ? (blocks.find((b) => b.id === selectedId) ?? null) : null),
    [selectedId, blocks],
  );
  const layerPage = selected?.id ? (layerPages[selected.id]?.[layer] ?? 0) : 0;
  const pageSize = layerPageSize(layer);
  /** Total entry count of the current tier "within the current time window"; falls back to the full total when there is no window cache (L2/L3 always equal the full total) */
  const windowTotal = selected?.id
    ? (windowTotals[selected.id]?.[layer] ?? getLayerCount(selected, layer))
    : 0;

  // ── Tier counts: fetch all four tier counts in parallel when a block is selected ──
  // Business confirmation: the layer_counts returned by teamAssets / agentFixed / myAgents are unreliable,
  // and accurate counts require calling the four layer endpoints L0/L1/L2/L3 for the selected block.
  // This was removed during an earlier endpoint optimization, causing incorrect badge counts.
  const layerCountSeqRef = useRef(0);
  // Record the last processed refreshNonce, to distinguish "selected block changed" from "manual refresh":
  // only on a manual refresh (nonce change) is the layerCounts cache ignored and the four tier counts forcibly re-fetched.
  const layerCountNonceRef = useRef(refreshNonce);
  useEffect(() => {
    if (!selected?.id) return;
    const blockId = selected.id;
    const seq = ++layerCountSeqRef.current;
    const forceRefresh = layerCountNonceRef.current !== refreshNonce;
    layerCountNonceRef.current = refreshNonce;

    const layers: MemoryLayer[] = ['L0', 'L1', 'L2', 'L3'];
    layers.forEach((l) => {
      // Tiers that already have a real count are not re-requested; forced re-fetch on manual refresh.
      if (!forceRefresh && selected.layerCounts[l] !== undefined) return;

      chatMemoryApi
        .layer(blockId, l, 1, 0)
        .then((res) => {
          if (seq !== layerCountSeqRef.current) return; // Superseded by a later selection
          setBlocks((prev) =>
            prev.map((b) =>
              b.id === blockId ? { ...b, layerCounts: { ...b.layerCounts, [l]: res.total } } : b,
            ),
          );
        })
        .catch(() => {
          // A single tier count failure does not block other tiers; ignore silently
        });
    });
  }, [selected?.id, refreshNonce]);

  // When switching memory blocks, reset the time filter to the default "previous day ~ now" (business confirmation: reset on every open)
  useEffect(() => {
    setTimeRange(defaultTimeRange());
    setRangeTooLarge(false);
  }, [selected?.id]);

  // When the block / time range changes, the in-window total cache is invalidated (pagination and total must be recomputed for the new window)
  useEffect(() => {
    setWindowTotals({});
  }, [selected?.id, timeRange.start, timeRange.end]);

  useEffect(() => {
    if (!selected?.id) {
      setLayerLoading(false);
      return;
    }
    let cancelled = false;
    setLayerLoading(true);
    // The time filter takes effect only for L0 / L1; L2 / L3 are aggregated products and take no time parameters
    const useTimeFilter = layer === 'L0' || layer === 'L1';
    const timeStart = useTimeFilter ? timeRange.start || undefined : undefined;
    const timeEnd = useTimeFilter ? timeRange.end || undefined : undefined;
    chatMemoryApi
      .layer(
        selected.id,
        layer,
        pageSize,
        layerPage * pageSize,
        undefined,
        undefined,
        timeStart,
        timeEnd,
      )
      .then((res) => {
        if (cancelled) return;
        setRangeTooLarge(false);
        // With a time filter, res.total is the count "within the current time window", saved separately for pagination
        // (layerCounts is still the full total and must not be touched). L2/L3 have no time dimension, so window total = full total.
        setWindowTotals((prev) => ({
          ...prev,
          [selected.id]: { ...(prev[selected.id] ?? {}), [layer]: res.total },
        }));
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            const updated = {
              ...b,
              layers: { ...b.layers },
              // Note: for a query with a time range, res.total is the count "within the range", not the full total.
              // The full total was already obtained via a limit=1 request when the block was selected and stored in layerCounts,
              // and must not be overwritten here, otherwise badge counts / the L0 load-more check would be wrong.
              // Sync the full total only when there is no time filter (L2/L3, or L0/L1 after the time range is cleared).
              ...(!useTimeFilter
                ? { layerCounts: { ...b.layerCounts, [layer]: res.total } }
                : {}),
            };
            if (res.layer === 'L0') {
              updated.layers.L0 = res.items;
              // On first load / reload after a time filter change: records within the window -> reset "reached earliest",
              // no records -> set it (meaning the memory block has no data at earlier times either, auto-extension stops here).
              // This is the convergence condition for auto-extending the time range, avoiding infinite backward extension.
              updated.l0Ended = res.items.length === 0;
            } else if (res.layer === 'L1') updated.layers.L1 = res.items.map(mapLayerItem);
            else if (res.layer === 'L2') updated.layers.L2 = res.items.map(mapLayerItem);
            else if (res.layer === 'L3') updated.layers.L3 = res.items.map(mapLayerItem);
            return updated;
          }),
        );
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Range too large: show no error toast, and let BlockDetail render the "too many memory entries" guidance
        if (isRangeTooLargeError(e)) {
          setRangeTooLarge(true);
          return;
        }
        tea.notify.error(e instanceof Error ? e.message : t('memory.notify.layerFailed'));
      })
      .finally(() => {
        if (!cancelled) setLayerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, layer, layerPage, pageSize, timeRange.start, timeRange.end, refreshNonce, t]);

  const handleLayerPageChange = useCallback(
    (nextPage: number) => {
      if (!selected?.id) return;
      setLayerPages((prev) => ({
        ...prev,
        [selected.id]: { ...(prev[selected.id] ?? {}), [layer]: Math.max(0, nextPage) },
      }));
    },
    [selected?.id, layer],
  );

  // ── L0 load more (triggered by pulling down / scrolling to the top) ──
  // L0 always consumes page 0 (the newest batch); "load more" uses the timestamp of the last message as a cursor
  // (before_ts) to request earlier messages, rather than using the array length as an offset.
  // Reason: VDB's scan+skip cost for a large offset is high, and filtering by timestamp reduces the query from O(offset+limit)
  // to O(limit). The array keeps the backend's new->old order, the render layer reverses it to old->new, and appended items appear at the top.
  const [l0MoreLoading, setL0MoreLoading] = useState(false);
  const handleL0LoadMore = useCallback(async () => {
    if (!selected?.id || layer !== 'L0' || l0MoreLoading) return;
    const items = selected.layers.L0;
    const total = selected.layerCounts.L0 ?? items.length;
    // Already confirmed earliest within the current time window: send no request (double safety; normally BlockDetail hides the entry point)
    if (selected.l0Ended) return;
    if (items.length >= total) return;
    // Cursor: the array is ordered new->old, so the last item is the oldest loaded message
    const lastItem = items[items.length - 1];
    const beforeTs = lastItem?.created_at;
    setL0MoreLoading(true);
    try {
      // When beforeTs has a value, pass offset 0 (the backend filters by time_end); on first load without beforeTs, use offset=0.
      // Pass through the timeStart lower bound: loading earlier messages must not go beyond the user's filter range, consistent with the first load.
      const timeStart = timeRange.start || undefined;
      const res = await chatMemoryApi.layer(
        selected.id,
        'L0',
        pageSize,
        0,
        undefined,
        beforeTs,
        timeStart,
      );
      const noMore = res.items.length === 0;
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== selected.id) return b;
          // Defensive dedupe: don't render the same message twice when concurrency/refresh makes pages overlap
          const existing = new Set(b.layers.L0.map((m) => m.id));
          const more = res.items.filter((m) => !existing.has(m.id));
          // Note: under cursor pagination the total returned by the backend is the filtered remaining count (time_end < beforeTs),
          // not the full total. Keep the full total obtained on first load, to avoid the false impression that "the total decreases after loading more".
          return {
            ...b,
            layers: { ...b.layers, L0: [...b.layers.L0, ...more] },
            // No new items this time (empty after dedupe) = reached earliest within the current time window; set it to hide the "Load earlier" entry point
            l0Ended: b.l0Ended || more.length === 0,
          };
        }),
      );
      // Reached earliest within the window -> automatically extend the time range backward (24h earlier) and trigger an L0 reload,
      // so users can keep seeing earlier memories without manually editing the filter (design intent: the time filter shouldn't be
      // an obstacle to tracing back history). If there is still no data after reloading, the effect sets l0Ended to stop the extension.
      // count is only an extreme-case safeguard against infinite loops; in the normal path convergence is natural via "load empty after extension -> l0Ended".
      if (noMore && timeRange.start && l0AutoExpandCountRef.current < 30) {
        l0AutoExpandCountRef.current += 1;
        const newStart = new Date(new Date(timeRange.start).getTime() - 24 * 60 * 60 * 1000);
        setL0MoreLoading(false);
        setTimeRange((prev) => ({ ...prev, start: newStart.toISOString() }));
        return;
      }
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.layerFailed'));
    } finally {
      setL0MoreLoading(false);
    }
  }, [selected, layer, l0MoreLoading, pageSize, timeRange.start, t]);

  const handleLayerItemLoad = useCallback(
    async (itemId: string) => {
      if (!selected?.id || layer !== 'L2') return;
      const current = selected.layers.L2.find((item) => item.id === itemId);
      if (!current) return;
      if (current.body.trim()) {
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            return {
              ...b,
              layers: {
                ...b.layers,
                L2: b.layers.L2.map((item) =>
                  item.id === itemId ? { ...item, body: '', tags: [] } : item,
                ),
              },
            };
          }),
        );
        return;
      }
      setLayerItemLoadingId(itemId);
      try {
        const res = await chatMemoryApi.layer(selected.id, 'L2', 1, 0, itemId);
        const loaded = res.items[0] ? mapLayerItem(res.items[0]) : null;
        if (!loaded) return;
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            return {
              ...b,
              layers: {
                ...b.layers,
                L2: b.layers.L2.map((item) => (item.id === itemId ? { ...item, ...loaded } : item)),
              },
            };
          }),
        );
      } catch (e: unknown) {
        tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.l2Failed'));
      } finally {
        setLayerItemLoadingId(null);
      }
    },
    [selected?.id, selected?.layers.L2, layer, t],
  );

  // ── Edit: save single-tier content (Owner-only; on success optimistically update the corresponding entry body) ──
  // L1 = content overwrite; L2 = whole scenario body overwrite (the BFF strips META before writing, the kernel rebuilds META);
  // L3 = whole core persona overwrite. Throws on failure, leaving the caller (edit dialog) to keep the input and show a message.
  const handleSaveLayerItem = useCallback(
    async (targetLayer: 'L1' | 'L2' | 'L3', itemId: string, content: string) => {
      if (!selected?.id) return;
      await chatMemoryApi.updateLayer(selected.id, targetLayer, {
        id: itemId,
        content,
      });
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== selected.id) return b;
          return {
            ...b,
            layers: {
              ...b.layers,
              [targetLayer]: b.layers[targetLayer].map((item) =>
                item.id === itemId ? { ...item, body: content } : item,
              ),
            },
          };
        }),
      );
      tea.notify.success(t('memory.notify.editSuccess'));
    },
    [selected?.id, t],
  );

  // ── Search: L0 (conversation) / L1 (atomic memory) semantic / keyword retrieval ──
  // Cross-session recall, returns hits with score; the result state is managed by BlockDetail,
  // and only the request function is provided here (depends on the currently selected block).
  const searchLayer = useCallback(
    async (targetLayer: 'L0' | 'L1', query: string): Promise<ChatMemorySearchHit[]> => {
      if (!selected?.id) return [];
      const res = await chatMemoryApi.searchLayer(selected.id, targetLayer, query, 30);
      return res.items ?? [];
    },
    [selected?.id],
  );

  // ── Filtering and helpers ──
  const filtered = useMemo(() => {
    if (scopeTab === 'fixed')
      return agentFilter ? blocks.filter((b) => b.agent_id === agentFilter) : [];
    return blocks;
  }, [blocks, scopeTab, agentFilter]);

  function agentLabel(id?: string): string {
    if (!id) return '';
    const a = teamAgents.find((x) => x.agent_id === id);
    return a ? a.name : id;
  }

  function selfChatMemoryAgentId(b: MemoryBlock): string | undefined {
    if (!activeTeamId) return undefined;
    const prefix = `chat_memory-${activeTeamId}-`;
    if (b.id.startsWith(prefix)) return b.id.slice(prefix.length) || undefined;
    return b.agent_id;
  }

  function isSelfChatMemory(b: MemoryBlock): boolean {
    // It counts as self only when "this chat_memory is the own memory of the **agent currently being viewed**" -- unbinding is not allowed.
    // Earlier bug: any asset named `chat_memory-{team}-{agentX}` was judged self,
    // so after another agent's memory was borrowed into the current agent (e.g. test3 borrowed test-bugfix's),
    // it was also misjudged as self, and the "Unbind" button was never shown.
    // Under the fixed tab agentFilter is the current agent; the team/personal tab has no "unbind" semantics,
    // so the original prefix check is kept as a fallback.
    if (!activeTeamId) return false;
    if (scopeTab === 'fixed' && agentFilter) {
      return b.id === `chat_memory-${activeTeamId}-${agentFilter}`;
    }
    const ownerAgentId = selfChatMemoryAgentId(b);
    return !!ownerAgentId && b.id === `chat_memory-${activeTeamId}-${ownerAgentId}`;
  }

  function allocatableAgents(b: MemoryBlock) {
    // Doc section 4.5 allocate permission rules:
    //   1. agent.owner = me (can only allocate to agents I own, otherwise 403 NOT_YOUR_AGENT)
    //   3. an agent's own chat_memory cannot be allocated to itself
    // So the data source is ownedTeamAgents, excluding the memory block's own agent.
    const ownerAgentId = selfChatMemoryAgentId(b);
    return ownedTeamAgents
      .filter((a) => a.agent_id !== ownerAgentId)
      .map((a) => ({ agent_id: a.agent_id, name: a.name }));
  }

  // ── Actions ──
  async function handleDeleteBlock(id: string) {
    const block = blocks.find((b) => b.id === id);
    const teamId = activeTeamId;
    const agentId = block?.agent_id;
    if (!teamId || !agentId) return;
    await confirmThenRun(
      {
        message: t('memory.confirm.unbind'),
        description: t('memory.confirm.unbind.desc'),
        okText: t('memory.confirm.unbind.ok'),
      },
      async () => {
        await chatMemoryApi.unbind(teamId, id, agentId);
        setBlocks((prev) => prev.filter((b) => b.id !== id));
        if (selectedId === id) setSelectedId(null);
        tea.notify.success(t('memory.notify.unbound'));
      },
      (e) => tea.notify.error((e as Error)?.message || t('memory.notify.unbindFailed')),
    );
  }

  async function handleImport({
    agent_id,
    messages,
  }: {
    agent_id: string;
    messages: Array<{ role: string; content: string }>;
  }) {
    try {
      if (!activeTeamId || !agent_id) {
        tea.notify.warning(t('memory.notify.selectAgent'));
        return;
      }
      await chatMemoryApi.import({ teamId: activeTeamId, agentId: agent_id, messages });
      tea.notify.success(t('memory.notify.importSuccess', { count: messages.length }));
      setShowImport(false);
      fetchBlocks();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.importFailed'));
    }
  }

  // Share/private toggle: formerly a capability unique to the personal tab; after the personal tab was removed it moved
  // to the asset items of the "Agent assets (fixed)" tab (only the owner can toggle, see where ChatMemoryPanel renders it).
  async function handleToggleScope(block: MemoryBlock, newScope: 'team' | 'private') {
    if (block.scope === newScope) return;
    // On switching to private, confirm first: other agents that already borrowed this memory can no longer use it.
    // The note is only for awareness and does not list the affected agents (the kernel doesn't actively prune, so no exact number is needed).
    if (newScope === 'private') {
      const ok = await tea.confirm({
        message: t('memory.confirm.private'),
        description: t('memory.confirm.private.desc'),
        okText: t('memory.confirm.private.ok'),
      });
      if (!ok) return;
    }
    try {
      await chatMemoryApi.patchScope(block.id, newScope);
      tea.notify.success(
        newScope === 'team' ? t('memory.notify.scopeTeam') : t('memory.notify.scopePrivate'),
      );
      fetchBlocks();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.scopeFailed'));
    }
  }

  // Manually refresh the current tier of the currently selected block: invalidate the window total cache and increment the nonce,
  // triggering the main loading effect to re-fetch the current tier data and the four-tier count effect to force re-fetching counts.
  const refreshLayer = useCallback(() => {
    if (!selected?.id) return;
    // Invalidate the current block's window total cache (let windowTotal fall back to the full total until the main loading effect refills it)
    setWindowTotals((prev) => {
      if (!(selected.id in prev)) return prev;
      const next = { ...prev };
      delete next[selected.id];
      return next;
    });
    // On refresh, reset the time filter to "now ~ previous day": otherwise newly written L0/L1 memories would be filtered out because
    // timeRange.end stays at the page load time, appearing as "clicked refresh but see no new data".
    setTimeRange(defaultTimeRange());
    setRangeTooLarge(false);
    // Increment the nonce: triggers the main loading effect (re-fetch current tier data) and the four-tier count effect (force re-fetching counts)
    setRefreshNonce((n) => n + 1);
  }, [selected?.id]);

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUserId,
    ownedTeamAgents,
    teamAgents,
    scopeTabLabels,
    // state
    blocks,
    blocksLoading,
    selectedId,
    setSelectedId,
    layer,
    setLayer,
    layerPages,
    layerLoading,
    layerItemLoadingId,
    l0MoreLoading,
    timeRange,
    setTimeRange,
    rangeTooLarge,
    showImport,
    setShowImport,
    showAllocate,
    setShowAllocate,
    scopeTab,
    setScopeTab,
    agentFilter,
    setAgentFilter,
    // computed
    selected,
    layerPage,
    pageSize,
    windowTotal,
    filtered,
    // handlers
    fetchBlocks,
    refreshLayer,
    handleLayerPageChange,
    handleL0LoadMore,
    handleLayerItemLoad,
    handleSaveLayerItem,
    searchLayer,
    handleDeleteBlock,
    handleImport,
    handleToggleScope,
    // helpers
    agentLabel,
    allocatableAgents,
    isSelfChatMemory,
  };
}

export type ChatMemoryStore = ReturnType<typeof useChatMemory>;
