/**
 * BehaviorPanel -- usage behavior panel (content of the Usage tab).
 *
 * Mixed-scope notice (do not merge when displaying):
 *   - KPI / trend / endpoint share / bypass reason / asset category -> kernel SQL full aggregation, exact
 *   - Member dimension                                              -> panel-side sampled aggregation, not full-volume
 *   - Trace details                                                 -> kernel full pagination, exact
 *
 * Drill-down always goes through the drawer (onDrill*); this panel no longer holds category / member filter state.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from 'tea-component';
import { KpiRow } from './KpiRow';
import { ShareBar } from './ShareBar';
import { TrendLines } from './TrendLines';
import { AssetCategorySection } from './AssetCategoryCards';
import { MemberTable } from './MemberTable';
import { CallDetailTable } from './CallDetailTable';
import { aggregateByCategory, type AssetCategory } from '../utils/asset-category';
import type { useAnalyticsMetrics } from '../hooks/useAnalyticsMetrics';
import type { useMemberStats } from '../hooks/useMemberStats';
import type { useCallDetail } from '../hooks/useCallDetail';

const EMPTY_DIMENSION = '(empty)';

export function BehaviorPanel({
  metrics,
  memberStats,
  trace,
  endpointFilter,
  resolveUserName,
  onEndpointFilterChange,
  onDrillCategory,
  onDrillMember,
}: {
  metrics: ReturnType<typeof useAnalyticsMetrics>;
  memberStats: ReturnType<typeof useMemberStats>;
  trace: ReturnType<typeof useCallDetail>;
  endpointFilter: string;
  resolveUserName: (id: string) => string;
  onEndpointFilterChange: (v: string) => void;
  onDrillCategory: (c: AssetCategory) => void;
  onDrillMember: (userId: string) => void;
}) {
  const { t } = useTranslation();

  const categoryStats = useMemo(() => aggregateByCategory(metrics.endpoints), [metrics.endpoints]);

  const trendLines = useMemo(
    () => [
      {
        key: 'init_sessions' as const,
        label: t('analytics.trend.init'),
        color: 'var(--tea-color-text-brand-default)',
      },
      {
        key: 'called_sessions' as const,
        label: t('analytics.trend.called'),
        color: 'var(--tea-color-text-success-default)',
      },
      {
        key: 'bypass_sessions' as const,
        label: t('analytics.trend.bypass'),
        color: 'var(--tea-color-text-error-default)',
      },
    ],
    [t],
  );

  return (
    <>
      <Card bordered>
        <Card.Body>
          <KpiRow summary={metrics.summary} />
        </Card.Body>
      </Card>

      <AssetCategorySection stats={categoryStats} onDrill={onDrillCategory} />

      <Card bordered>
        <Card.Body title={t('analytics.section.timeseries')}>
          <TrendLines
            rows={metrics.series}
            lines={trendLines}
            emptyText={t('analytics.empty.trend')}
            maxLabel={(max) => t('analytics.trend.max', { value: max })}
            singlePointHint={t('analytics.trend.singlePoint')}
          />
        </Card.Body>
      </Card>

      <MemberTable
        members={memberStats.members}
        sampled={memberStats.sampled}
        total={memberStats.total}
        truncated={memberStats.truncated}
        loading={memberStats.loading}
        resolveUserName={resolveUserName}
        onDrill={onDrillMember}
      />

      <CallDetailTable
        rows={trace.rows}
        total={trace.total}
        offset={trace.offset}
        limit={trace.limit}
        loading={trace.loading}
        endpointFilter={endpointFilter}
        resolveUserName={resolveUserName}
        onEndpointFilterChange={onEndpointFilterChange}
        onOffsetChange={trace.setOffset}
        onDrillMember={onDrillMember}
      />

      <Card bordered>
        <Card.Body title={t('analytics.section.endpointShare')}>
          <ShareBar
            rows={metrics.endpoints}
            labelOf={(r) => r.executed_endpoint || EMPTY_DIMENSION}
            valueOf={(r) => r.calls}
            emptyText={t('analytics.empty.bridge')}
          />
        </Card.Body>
      </Card>

      <Card bordered>
        <Card.Body title={t('analytics.section.bypassReasons')}>
          <ShareBar
            rows={metrics.reasons}
            labelOf={(r) => r.bypass_reason || EMPTY_DIMENSION}
            valueOf={(r) => r.sessions}
            emptyText={t('analytics.empty.bypass')}
          />
        </Card.Body>
      </Card>
    </>
  );
}
