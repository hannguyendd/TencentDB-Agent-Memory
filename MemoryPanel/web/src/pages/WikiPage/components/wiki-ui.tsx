/**
 * wiki-ui -- small display components of the Wiki asset page.
 * Split out of WikiSourcesPanel.tsx: status badge / Owner label / lazy-loaded knowledge graph container.
 */
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusTip } from 'tea-component';
import type { GraphData, GraphNode, WikiDetail, WikiPage } from '@/lib/api/knowledge-api';
import { StatusTag } from '@/components/StatusTag';
import { OwnerLabel } from '@/components/OwnerLabel';
import { WIKI_STATUS_KEY, WIKI_STATUS_THEME } from '../constants/wiki-constants';

export function WikiStatusBadge({ status }: { status: WikiDetail['status'] }) {
  const { t } = useTranslation();
  const theme = WIKI_STATUS_THEME[status] ?? ('default' as const);
  const label = WIKI_STATUS_KEY[status] ? t(WIKI_STATUS_KEY[status]) : status;
  return <StatusTag label={label} theme={theme} />;
}

/**
 * Owner display -- reuses the generic OwnerLabel (shows the username rather than user_id).
 * useUserDisplayName internally has a global cache + only calls usersApi.get on the first miss,
 * and multiple rows with the same user_id share one cache, so scalability is O(distinct users), not O(rows).
 * Extracting a sub-component is because of the Rules of Hooks -- hooks cannot be called in a loop inside .map.
 */
export function WikiOwnerLabel({ userId, currentUserId }: { userId: string; currentUserId: string }) {
  const { t } = useTranslation();
  return (
    <OwnerLabel
      userId={userId}
      currentUserId={currentUserId}
      title={t('wiki.detail.owner', { userId })}
      youText={t('wiki.detail.you')}
      youClassName="ml-1 text-xs text-primary"
    />
  );
}

// ═══════════════════════════════════════════
// Knowledge Graph Embed (lazy loaded sigma)
// ═══════════════════════════════════════════
const KnowledgeGraphLazy = lazy(() => import('./KnowledgeGraph'));

export function KnowledgeGraphEmbed({
  data,
  loading,
  onNodeClick,
  highlightNode,
}: {
  data: GraphData | null;
  loading: boolean;
  onNodeClick: (node: GraphNode) => void;
  highlightNode: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<StatusTip status="loading" loadingText={t('wiki.detail.graph.loading')} />}>
      <KnowledgeGraphLazy
        data={data}
        loading={loading}
        onNodeClick={onNodeClick}
        highlightNode={highlightNode}
        className="_wiki-detail-graph-embed"
      />
    </Suspense>
  );
}

// Export types for reuse by the outer layer, avoiding scattered import type paths
export type { WikiPage };
