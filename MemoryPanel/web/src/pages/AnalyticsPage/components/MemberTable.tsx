/**
 * MemberTable -- per-member call statistics table.
 *
 * Warning: sampled scope. Data is aggregated panel-side after paging through `tool-calls/list` samples (the kernel has no
 * per-member aggregation endpoint for display, and Core is not changed in this iteration). When truncated=true the header explicitly says
 * "based on the latest N / total records" so it is not misread as full-volume.
 *
 * The member column shows two lines: the main line is the username (batch-resolved via `user/list`; when resolution fails or the internal account is filtered out,
 * an "Unrecognized user" placeholder is shown), and the sub line always shows the raw user_id for easy identification and copying.
 */
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Table, Text, Tooltip } from 'tea-component';
import type { MemberStat } from '../utils/member-stats';
import { UNASSIGNED_USER } from '../utils/member-stats';
import type { AssetCategory } from '../utils/asset-category';
import { CATEGORY_META } from './AssetCategoryCards';
import { UserName } from './UserName';
import { fmtInt } from '../utils/formatters';

const { autotip } = Table.addons;

/** Display order of per-member asset usage counts (other goes last). */
const ASSET_COLUMN_ORDER: readonly AssetCategory[] = ['memory', 'skill', 'wiki', 'codegraph', 'other'];

export function MemberTable({
  members,
  sampled,
  total,
  truncated,
  loading,
  resolveUserName,
  onDrill,
}: {
  members: MemberStat[];
  sampled: number;
  total: number;
  truncated: boolean;
  loading: boolean;
  resolveUserName: (id: string) => string;
  onDrill: (userId: string) => void;
}) {
  const { t } = useTranslation();

  const columns = [
    {
      key: 'user_id',
      header: t('analytics.member.col.user'),
      width: 200,
      render: (r: MemberStat) => {
        // The unattributed bucket is not a real user: show the placeholder text directly, no name resolution
        if (r.user_id === UNASSIGNED_USER) {
          return <Text theme="label">{t('analytics.member.unassigned')}</Text>;
        }
        // When unresolved, the main line renders "Unrecognized user" (a bare user_id is no longer treated as a readable name),
        // and the sub line always shows user_id, keeping the two-line layout consistent across the column.
        return (
          <div className="_an-user-cell">
            <UserName userId={r.user_id} displayName={resolveUserName(r.user_id)} />
            <Text theme="label" className="_an-mono _an-user-id" overflow>
              {r.user_id}
            </Text>
          </div>
        );
      },
    },
    {
      key: 'calls',
      header: t('analytics.member.col.calls'),
      width: 90,
      align: 'right' as const,
      render: (r: MemberStat) => fmtInt(r.calls),
    },
    {
      key: 'sessions',
      header: t('analytics.member.col.sessions'),
      width: 90,
      align: 'right' as const,
      render: (r: MemberStat) => fmtInt(r.sessions),
    },
    {
      key: 'topCategory',
      header: t('analytics.member.col.topCategory'),
      width: 260,
      render: (r: MemberStat) => {
        // Asset categories this member has used (first few in fixed order) -- fills in "usage count per category",
        // rather than showing only a single top-category badge.
        const used = ASSET_COLUMN_ORDER.filter((c) => r.byCategory[c] > 0);
        if (used.length === 0) return '—';
        // Tooltip uses per-line ReactNodes (a plain-text \n does not break lines in HTML)
        const tip = (
          <div>
            {used.map((c) => (
              <div key={c}>
                {t(`analytics.category.${CATEGORY_META[c].i18nKey}`)}: {fmtInt(r.byCategory[c])}
              </div>
            ))}
          </div>
        );
        return (
          <Tooltip title={tip} placement="top">
            <div className="_an-member-assets">
              {used.map((c) => (
                <span key={c} className="_an-asset-chip">
                  <i style={{ background: CATEGORY_META[c].color }} />
                  {t(`analytics.category.${CATEGORY_META[c].i18nKey}`)}
                  <em>{fmtInt(r.byCategory[c])}</em>
                </span>
              ))}
            </div>
          </Tooltip>
        );
      },
    },
    {
      key: 'avgElapsedMs',
      header: t('analytics.member.col.avgElapsed'),
      width: 110,
      align: 'right' as const,
      render: (r: MemberStat) => (r.avgElapsedMs > 0 ? `${fmtInt(r.avgElapsedMs)}ms` : '—'),
    },
    {
      key: 'errors',
      header: t('analytics.member.col.errors'),
      width: 90,
      align: 'right' as const,
      render: (r: MemberStat) =>
        r.errors > 0 ? <Text theme="danger">{fmtInt(r.errors)}</Text> : '0',
    },
    {
      key: 'lastCallAt',
      header: t('analytics.member.col.lastCall'),
      width: 170,
      render: (r: MemberStat) => (
        <Text className="_an-mono" overflow>
          {r.lastCallAt || '—'}
        </Text>
      ),
    },
    {
      key: 'op',
      header: t('analytics.member.col.op'),
      width: 90,
      render: (r: MemberStat) =>
        // The unattributed bucket cannot be used as a user_id filter, so no drill-down entry is provided
        r.user_id === UNASSIGNED_USER ? (
          '—'
        ) : (
          <Button type="link" onClick={() => onDrill(r.user_id)}>
            {t('analytics.drill.open')}
          </Button>
        ),
    },
  ];

  return (
    <Card bordered>
      <Card.Body
        title={t('analytics.section.members')}
        subtitle={t('analytics.section.membersSub')}
      >
        {truncated && (
          <Alert type="info">
            {t('analytics.member.sampled', { sampled: fmtInt(sampled), total: fmtInt(total) })}
          </Alert>
        )}
        <Table
          records={members}
          recordKey="user_id"
          columns={columns}
          verticalTop
          bordered
          addons={[
            autotip({
              isLoading: loading,
              emptyText: t('analytics.empty.member'),
            }),
          ]}
        />
      </Card.Body>
    </Card>
  );
}
