/**
 * DrillDownDrawer -- unified drill-down drawer.
 *
 * Replaces the earlier "click card/row -> set page-level filter -> scroll down to the table for results" interaction:
 * drill-down results are shown directly in the drawer, so users no longer need to scroll, and the page body state is not changed.
 *
 * Data loading is strictly bound to visible: when the drawer is closed, enabled is false for both hooks,
 * so no background requests are made; switching tabs only loads the current view.
 *
 * wiki / codegraph both belong to knowledge-service and bridge_source cannot tell them apart -- when drilling into these two
 * categories the drawer shows a notice that the results include all knowledge calls (a kernel filter dimension limitation).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Drawer, TabPanel, Tabs, Text } from 'tea-component';
import type { AnalyticsRangeDays } from '@/lib/api/analytics';
import { categoryToBridgeSource } from './AssetCategoryCards';
import { TraceDetailList } from './TraceDetailList';
import { UsageDetailList } from './UsageDetailList';
import { useCallDetail } from '../hooks/useCallDetail';
import { useUsageList } from '../hooks/useUsageList';
import { drillViews, type DrillTarget, type DrillView } from '../utils/drill-target';

export function DrillDownDrawer({
  target,
  days,
  spaceId,
  resolveUserName,
  onClose,
}: {
  target: DrillTarget | null;
  days: AnalyticsRangeDays;
  spaceId: string;
  resolveUserName: (id: string) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const visible = target !== null;

  const views = useMemo<DrillView[]>(() => (target ? drillViews(target) : ['trace']), [target]);
  const [view, setView] = useState<DrillView>(views[0]);

  // When switching drill-down targets, reset to the target's default view (the previous target's view may not apply)
  useEffect(() => {
    setView(views[0]);
  }, [views]);

  const userId = target?.type === 'member' ? target.userId : undefined;
  const modelId = target?.type === 'model' ? target.modelId : undefined;
  const bridgeSource =
    target?.type === 'category' ? categoryToBridgeSource(target.category) : undefined;

  const trace = useCallDetail({
    enabled: visible && view === 'trace',
    days,
    spaceId,
    userId: userId ?? null,
    bridgeSource,
    endpointFilter: '',
  });

  const usage = useUsageList({
    enabled: visible && view === 'usage',
    days,
    spaceId,
    userId,
    modelId,
  });

  const title = useMemo(() => {
    if (!target) return '';
    switch (target.type) {
      case 'member':
        return resolveUserName(target.userId);
      case 'category':
        return t(`analytics.category.${target.category}`);
      case 'model':
        return target.modelName || target.modelId;
    }
  }, [target, resolveUserName, t]);

  const subtitle = useMemo(() => {
    if (!target) return null;
    const raw =
      target.type === 'member'
        ? target.userId
        : target.type === 'model'
          ? target.modelId
          : t('analytics.drill.categoryHint');
    return (
      <span className="_an-drill-subtitle">
        <span className="_an-mono">{raw}</span>
        <Text theme="label">{t('analytics.range', { days })}</Text>
      </span>
    );
  }, [target, days, t]);

  const tabs = views.map((v) => ({ id: v, label: t(`analytics.drill.view.${v}`) }));

  // wiki / codegraph share bridge_source under knowledge-service, so results cannot contain a single category only
  const knowledgeAmbiguous =
    target?.type === 'category' && (target.category === 'wiki' || target.category === 'codegraph');

  const renderView = (v: DrillView) => {
    if (!target) return null;
    return v === 'trace' ? (
      <TraceDetailList
        rows={trace.rows}
        total={trace.total}
        offset={trace.offset}
        limit={trace.limit}
        loading={trace.loading}
        error={trace.error}
        resolveUserName={resolveUserName}
        showUser={target.type !== 'member'}
        onOffsetChange={trace.setOffset}
      />
    ) : (
      <UsageDetailList
        rows={usage.rows}
        total={usage.total}
        offset={usage.offset}
        limit={usage.limit}
        loading={usage.loading}
        error={usage.error}
        resolveUserName={resolveUserName}
        showUser={target.type !== 'member'}
        showModel={target.type !== 'model'}
        onOffsetChange={usage.setOffset}
      />
    );
  };

  return (
    <Drawer
      visible={visible}
      size="l"
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      destroyOnClose
      showMask
    >
      {target && (
        <div className="_an-drill-body">
          {knowledgeAmbiguous && (
            <Alert type="info">{t('analytics.drill.knowledgeAmbiguous')}</Alert>
          )}

          {views.length > 1 ? (
            <Tabs tabs={tabs} activeId={view} onActive={(tab) => setView(tab.id as DrillView)}>
              {views.map((v) => (
                <TabPanel id={v} key={v}>
                  <div className="_an-drill-tab-body">{renderView(v)}</div>
                </TabPanel>
              ))}
            </Tabs>
          ) : (
            renderView(view)
          )}
        </div>
      )}
    </Drawer>
  );
}
