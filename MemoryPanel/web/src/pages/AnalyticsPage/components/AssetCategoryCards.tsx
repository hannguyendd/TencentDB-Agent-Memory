/**
 * AssetCategoryCards -- call distribution across four asset categories (Memory / Skill / Wiki / Code Graph).
 *
 * Data comes from the kernel `tool-calls/endpoint-share` (full SQL aggregation); the panel only maps endpoint -> category
 * so calls / pct are **exact full-volume values**, not samples.
 *
 * Clicking a card opens the drill-down drawer directly to view call details for that category (no longer changes the page body state,
 * avoiding "clicked but have to scroll down to find the result").
 */
import { useTranslation } from 'react-i18next';
import { Card, StatusTip, Text, Tooltip } from 'tea-component';
import type { AssetCategory, CategoryStat } from '../utils/asset-category';
import { fmtInt, fmtPct } from '../utils/formatters';

/** Category -> i18n key suffix and theme color (reuses Tea semantic color tokens). */
const CATEGORY_META: Record<AssetCategory, { i18nKey: string; color: string }> = {
  memory: { i18nKey: 'memory', color: 'var(--tea-color-text-brand-default)' },
  skill: { i18nKey: 'skill', color: 'var(--tea-color-text-success-default)' },
  wiki: { i18nKey: 'wiki', color: 'var(--tea-color-text-warning-default)' },
  codegraph: { i18nKey: 'codegraph', color: 'var(--tea-color-text-secondary)' },
  other: { i18nKey: 'other', color: 'var(--tea-color-text-tertiary)' },
};

export function AssetCategoryCards({
  stats,
  onDrill,
}: {
  stats: CategoryStat[];
  onDrill: (category: AssetCategory) => void;
}) {
  const { t } = useTranslation();

  if (stats.length === 0) {
    return <StatusTip status="empty" emptyText={t('analytics.empty.bridge')} />;
  }

  const max = Math.max(...stats.map((s) => s.pct), 1);

  return (
    <div className="_an-cat-grid">
      {stats.map((stat) => {
        const meta = CATEGORY_META[stat.category];
        // Basis for categorization: show the raw endpoints that fall into this category so the mapping can be verified
        const tip =
          stat.endpoints.length > 0
            ? stat.endpoints.map((e) => `${e.endpoint} (${e.calls})`).join('\n')
            : t('analytics.category.noEndpoint');

        return (
          <Tooltip key={stat.category} title={tip} placement="top">
            <button
              type="button"
              className="_an-cat-card"
              onClick={() => onDrill(stat.category)}
            >
              <span className="_an-cat-badge" style={{ background: meta.color }}>
                {t(`analytics.category.${meta.i18nKey}`)}
              </span>
              <span className="_an-cat-value">{fmtInt(stat.calls)}</span>
              <span className="_an-cat-track">
                <span
                  className="_an-cat-fill"
                  style={{ width: `${(stat.pct / max) * 100}%`, background: meta.color }}
                />
              </span>
              <span className="_an-cat-meta">
                <Text theme="label">{t('analytics.category.calls')}</Text>
                <Text theme="label">{fmtPct(stat.pct)}</Text>
              </span>
              <Text theme="label" className="_an-cat-desc">
                {t(`analytics.category.${meta.i18nKey}.desc`)}
              </Text>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Category -> kernel bridge_source filter value (used for drill-down trace details). */
export function categoryToBridgeSource(category: AssetCategory): string | undefined {
  if (category === 'memory') return 'memory-bridge';
  if (category === 'skill') return 'skill-bridge';
  // wiki / codegraph both belong to knowledge-service, so they cannot be distinguished by bridge_source alone;
  // the caller filters by endpoint keyword instead.
  if (category === 'wiki' || category === 'codegraph') return 'knowledge-service';
  return undefined;
}

export { CATEGORY_META };

/** Card container wrapper (for direct page use, keeps Card.Body semantics consistent). */
export function AssetCategorySection({
  stats,
  onDrill,
}: {
  stats: CategoryStat[];
  onDrill: (category: AssetCategory) => void;
}) {
  const { t } = useTranslation();
  return (
    <Card bordered>
      <Card.Body
        title={t('analytics.section.assetCategory')}
        subtitle={t('analytics.section.assetCategorySub')}
      >
        <AssetCategoryCards stats={stats} onDrill={onDrill} />
      </Card.Body>
    </Card>
  );
}
