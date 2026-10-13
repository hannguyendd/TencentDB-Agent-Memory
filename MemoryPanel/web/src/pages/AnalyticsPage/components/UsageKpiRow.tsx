/**
 * UsageKpiRow -- core cost-view metrics (requests / tokens / credit / cache hits / savings).
 *
 * Reuses MetricsBoard for "value + unit + supplementary rows", visually consistent with the usage-behavior KpiRow.
 * Token counts often reach tens of millions, so fmtCompact is used for compact display, with full values in the infos rows.
 *
 * `cache_hit_rate` being null means there are no prompt tokens and it cannot be computed (not 0%),
 * fmtPctValue shows a placeholder -- do not change this to `?? 0`.
 */
import { useTranslation } from 'react-i18next';
import { MetricsBoard } from 'tea-component';
import type { UsageSummary } from '@/lib/api/analytics';
import { fmtCompact, fmtCredit, fmtInt, fmtPctValue } from '../utils/formatters';

export function UsageKpiRow({ summary }: { summary: UsageSummary | null }) {
  const { t } = useTranslation();

  return (
    <div className="_an-kpi-row">
      <MetricsBoard
        title={t('analytics.usage.kpi.requests')}
        value={fmtCompact(summary?.total_requests)}
        infos={[
          <>
            <MetricsBoard.InfoLabel>{t('analytics.usage.kpi.sessions')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>{fmtInt(summary?.distinct_sessions)}</MetricsBoard.InfoKey>
          </>,
          <>
            <MetricsBoard.InfoLabel>{t('analytics.usage.kpi.users')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>{fmtInt(summary?.distinct_users)}</MetricsBoard.InfoKey>
          </>,
        ]}
      />
      <MetricsBoard
        title={t('analytics.usage.kpi.totalTokens')}
        value={fmtCompact(summary?.total_tokens)}
        infos={[
          <>
            <MetricsBoard.InfoLabel>{t('analytics.usage.kpi.prompt')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>{fmtCompact(summary?.total_prompt_tokens)}</MetricsBoard.InfoKey>
          </>,
          <>
            <MetricsBoard.InfoLabel>{t('analytics.usage.kpi.completion')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>{fmtCompact(summary?.total_completion_tokens)}</MetricsBoard.InfoKey>
          </>,
        ]}
      />
      <MetricsBoard
        title={t('analytics.usage.kpi.cacheHit')}
        value={fmtPctValue(summary?.cache_hit_rate)}
        unit="%"
        infos={[
          <>
            <MetricsBoard.InfoLabel>{t('analytics.usage.kpi.cacheTokens')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>{fmtCompact(summary?.total_cache_hit_tokens)}</MetricsBoard.InfoKey>
          </>,
          <>{t('analytics.usage.kpi.cacheHitHint')}</>,
        ]}
      />
      <MetricsBoard
        title={t('analytics.usage.kpi.credit')}
        value={fmtCredit(summary?.total_credit)}
        infos={[
          <>
            <MetricsBoard.InfoLabel>{t('analytics.usage.kpi.models')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>{fmtInt(summary?.distinct_models)}</MetricsBoard.InfoKey>
          </>,
        ]}
      />
      <MetricsBoard
        title={t('analytics.usage.kpi.saved')}
        value={fmtCredit(summary?.total_credit_saved)}
        infos={[
          <>
            <MetricsBoard.InfoLabel>{t('analytics.usage.kpi.compressSaved')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>
              {fmtCompact(summary?.total_compress_tokens_saved)}
            </MetricsBoard.InfoKey>
          </>,
          <>{t('analytics.usage.kpi.savedHint')}</>,
        ]}
      />
    </div>
  );
}
