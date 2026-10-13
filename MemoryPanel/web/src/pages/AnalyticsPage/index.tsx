/**
 * AnalyticsPage -- "Observability" usage dashboard (visible to system_admin only).
 *
 * Data source: Panel /api/v1/analytics/* transparent proxy -> kernel /v3/analytics/* (iwiki 4036925405),
 * where the kernel reads the MemoryProxy-side ClickHouse (context_proxy) instrumentation tables. This iteration excludes LLM / Langfuse
 * effectiveness analysis (adoption rate, impact on task results, etc. need semantic judgment that SQL cannot express).
 *
 * The two Tabs correspond to two perspectives, each lazily loaded (requests are only sent once the Tab is opened, avoiding
 * 10+ CH queries on first paint):
 *   - Usage: session penetration / asset category / member / trace details (tool_call + session_init tables)
 *   - Cost: token / credit / model distribution / billing archive (usage_logs + usage_raw tables)
 *
 * Drill-down interaction: drill-downs by member / asset category / model all open DrillDownDrawer; the page body no longer
 * handles linked filtering (the old "click card -> change the table filter below" required users to scroll for results, a poor experience).
 *
 * Data flow constraint (do not change back to "probe config again inside load"): config is probed once and reduced to a
 * chReady boolean; calling setConfig inside load would form a self-triggering loop with an effect that depends on the config object
 * (each fetch returns a new reference), causing infinite requests.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Select, Status, TabPanel, Tabs, Text } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { useCurrentRole } from '@/services/useCurrentRole';
import { usePanelAnalyticsEnabled } from '@/services/usePanelCapabilities';
import { useAuthStore } from '@/stores/auth';
import type { AnalyticsRangeDays } from '@/lib/api/analytics';
import { BehaviorPanel } from './components/BehaviorPanel';
import { UsagePanel } from './components/UsagePanel';
import { DrillDownDrawer } from './components/DrillDownDrawer';
import { useAnalyticsMetrics } from './hooks/useAnalyticsMetrics';
import { useMemberStats } from './hooks/useMemberStats';
import { useCallDetail } from './hooks/useCallDetail';
import { useUsageStats } from './hooks/useUsageStats';
import { useUserNames } from './hooks/useUserNames';
import { UNASSIGNED_USER } from './utils/member-stats';
import type { AssetCategory } from './utils/asset-category';
import type { DrillTarget } from './utils/drill-target';
import './styles/analytics.css';

const DAYS: AnalyticsRangeDays[] = [1, 7, 30, 90];

type ViewTab = 'behavior' | 'cost';

export function AnalyticsPage() {
  const { t } = useTranslation();
  const isAdmin = useCurrentRole() === 'admin';

  const [tab, setTab] = useState<ViewTab>('behavior');
  const [days, setDays] = useState<AnalyticsRangeDays>(7);
  // Data-plane instance isolation: Space is fixed to the currently logged-in instance (auth.instance_id = kernel
  // x-tdai-service-id = space_id written by CH instrumentation); "All Spaces"
  // and cross-instance switching are no longer offered, so data of other instances in the shared CH database is not aggregated and shown.
  const [spaceId, setSpaceId] = useState(() => useAuthStore.getState().auth?.instance_id ?? '');
  const [endpointFilter, setEndpointFilter] = useState('');
  const [expandedRawKeys, setExpandedRawKeys] = useState<string[]>([]);
  const [drill, setDrill] = useState<DrillTarget | null>(null);

  // The config probe and Space list are shared by both Tabs, so they are unaffected by tab
  const metrics = useAnalyticsMetrics({ enabled: isAdmin, days, spaceId });
  const { chReady } = metrics;

  const behaviorEnabled = isAdmin && chReady && tab === 'behavior';
  const costEnabled = isAdmin && chReady && tab === 'cost';

  const memberStats = useMemberStats({ enabled: behaviorEnabled, days, spaceId });
  const trace = useCallDetail({
    enabled: behaviorEnabled,
    days,
    spaceId,
    userId: null,
    bridgeSource: undefined,
    endpointFilter,
  });
  const usage = useUsageStats({ enabled: costEnabled, days, spaceId });

  // Collect the user_ids appearing in the current view for one batch name resolution (member table + trace + archive table).
  // Exclude UNASSIGNED_USER: it is the aggregate bucket label for empty user_id, not a real user; sending it to the query would
  // waste a user_ids quota slot and is guaranteed not to be found.
  const visibleUserIds = useMemo(
    () =>
      [
        ...memberStats.members.map((m) => m.user_id),
        ...trace.rows.map((r) => r.user_id),
        ...usage.rawRows.map((r) => r.user_id),
        ...(drill?.type === 'member' ? [drill.userId] : []),
      ].filter((id) => id && id !== UNASSIGNED_USER),
    [memberStats.members, trace.rows, usage.rawRows, drill],
  );
  const resolveUserName = useUserNames(visibleUserIds);

  // When the panel env switch is off (or the fetch fails) the whole page is unavailable: the menu is hidden, and this guards against direct deep-link access.
  // Note hooks order: this check must come after all hooks calls.
  const analyticsEnabled = usePanelAnalyticsEnabled();
  if (analyticsEnabled === false) {
    return (
      <ResourcePage>
        <Card bordered>
          <Card.Body>
            <Status
              icon="no-permission"
              size="m"
              title={t('analytics.featureDisabled.title')}
              description={t('analytics.featureDisabled.desc')}
            />
          </Card.Body>
        </Card>
      </ResourcePage>
    );
  }

  if (!isAdmin) {
    return (
      <ResourcePage>
        <Card bordered>
          <Card.Body>
            <Status
              icon="no-permission"
              size="m"
              title={t('analytics.noPermission.title')}
              description={t('analytics.noPermission.desc')}
            />
          </Card.Body>
        </Card>
      </ResourcePage>
    );
  }

  const chAlert =
    metrics.chState === 'not-configured'
      ? t('analytics.chNotConfigured')
      : metrics.chState === 'unreachable'
        ? t('analytics.chUnreachable')
        : metrics.chState === 'probe-failed'
          ? t('analytics.chProbeFailed')
          : '';

  const activeUpdatedAt = tab === 'cost' ? usage.updatedAt : metrics.updatedAt;
  const activeLoading = tab === 'cost' ? usage.loading : metrics.loading;

  const refreshAll = () => {
    if (tab === 'cost') {
      usage.reload();
      return;
    }
    void metrics.reload();
    void memberStats.reload();
    void trace.reload();
  };

  const tabs = [
    { id: 'behavior', label: t('analytics.tab.behavior') },
    { id: 'cost', label: t('analytics.tab.cost') },
  ];

  return (
    <ResourcePage>
      <Card bordered>
        <Card.Body title={t('analytics.title')} subtitle={t('analytics.subtitle')}>
          <div className="_an-toolbar">
            <Select
              className="_an-toolbar-select"
              appearance="button"
              value={String(days)}
              onChange={(v) => setDays(Number(v) as AnalyticsRangeDays)}
              options={DAYS.map((d) => ({ value: String(d), text: t('analytics.range', { days: d }) }))}
              listWidth={140}
            />
            <Select
              className="_an-toolbar-select"
              appearance="button"
              value={spaceId}
              onChange={setSpaceId}
              // Only the currently logged-in instance: the spaces list endpoint returns all space_ids of the shared CH
              // (including other instances), which are no longer offered as options in the UI.
              options={[{ value: spaceId, text: spaceId || t('analytics.allSpaces') }]}
              listWidth={260}
            />
            <Button type="weak" onClick={refreshAll} loading={activeLoading} disabled={!chReady}>
              {t('analytics.refresh')}
            </Button>
            <Text theme="label" className="_an-stamp">
              {activeUpdatedAt
                ? t('analytics.updatedAt', { time: activeUpdatedAt.toLocaleTimeString() })
                : t('analytics.notLoaded')}
            </Text>
          </div>

          {metrics.error && <Alert type="error">{metrics.error}</Alert>}
          {chAlert && <Alert type="warning">{chAlert}</Alert>}
        </Card.Body>
      </Card>

      {chReady && (
        <Tabs
          tabs={tabs}
          activeId={tab}
          onActive={(nextTab) => setTab(nextTab.id as ViewTab)}
          className="_an-tabs"
        >
          <TabPanel id="behavior">
            <div className="_an-tab-body">
              <BehaviorPanel
                metrics={metrics}
                memberStats={memberStats}
                trace={trace}
                endpointFilter={endpointFilter}
                resolveUserName={resolveUserName}
                onEndpointFilterChange={setEndpointFilter}
                onDrillCategory={(category: AssetCategory) => setDrill({ type: 'category', category })}
                onDrillMember={(userId) => setDrill({ type: 'member', userId })}
              />
            </div>
          </TabPanel>
          <TabPanel id="cost">
            <div className="_an-tab-body">
              <UsagePanel
                usage={usage}
                expandedRawKeys={expandedRawKeys}
                resolveUserName={resolveUserName}
                onExpandedRawKeysChange={setExpandedRawKeys}
                onDrillModel={(modelId, modelName) => setDrill({ type: 'model', modelId, modelName })}
                onDrillMember={(userId) => setDrill({ type: 'member', userId })}
              />
            </div>
          </TabPanel>
        </Tabs>
      )}

      <DrillDownDrawer
        target={drill}
        days={days}
        spaceId={spaceId}
        resolveUserName={resolveUserName}
        onClose={() => setDrill(null)}
      />
    </ResourcePage>
  );
}
