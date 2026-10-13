/**
 * WikiSourcePageTree -- external-source document tree (checkable).
 *
 * The backend `pages` is a **flat array** (including directory nodes), expressing hierarchy via parentId.
 * Rendering it directly with map would flatten parents and children into one column with no visible hierarchy, and users would think there are "no child documents".
 *
 * Measured scale (real space CSIGCDB): 5748 nodes / 6 levels / 4183 documents.
 * Fully expanding would render thousands of DOM nodes and lag, therefore:
 *   - **Only root-level directories are expanded by default** (a depth-0 directory shows its direct children); deeper levels are collapsed and expanded on demand
 *   - Indentation reflects hierarchy
 *   - Checking a parent directory = checking all descendant documents under it (a directory itself cannot be imported; it is only a quick-select shortcut)
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox } from 'tea-component';
import { ChevronDownIcon, ChevronRightIcon } from 'tea-icons-react';
import type { WikiRemotePageRef } from '@/lib/api/knowledge-api';

interface TreeNode extends WikiRemotePageRef {
  children: TreeNode[];
}

/** Flat -> tree. An empty/null parentId means root level; orphan nodes (parent not in the list) are also attached to the root to avoid loss. */
function buildTree(pages: WikiRemotePageRef[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const p of pages) nodes.set(p.externalId, { ...p, children: [] });

  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** Collect the ids of all non-directory descendants under a directory (a directory itself cannot be imported). */
function collectLeafIds(node: TreeNode, out: string[] = []): string[] {
  for (const c of node.children) {
    if (c.isDir) collectLeafIds(c, out);
    else out.push(c.externalId);
  }
  return out;
}

/**
 * Collapsed by default: directories with depth >= DEFAULT_EXPAND_DEPTH.
 * Only expanding root-level directories -> the first screen is about "number of root directories + their direct children" rows, so even large spaces don't lag.
 */
const DEFAULT_EXPAND_DEPTH = 1;

function collectDeepDirIds(nodes: TreeNode[], depth = 0, out: string[] = []): string[] {
  for (const n of nodes) {
    if (!n.isDir) continue;
    if (depth >= DEFAULT_EXPAND_DEPTH) out.push(n.externalId);
    collectDeepDirIds(n.children, depth + 1, out);
  }
  return out;
}

function countLeaves(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.isDir ? countLeaves(n.children) : 1), 0);
}

function allLeafIds(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.isDir) allLeafIds(n.children, out);
    else out.push(n.externalId);
  }
  return out;
}

export function WikiSourcePageTree({
  pages,
  selectedPageIds,
  onToggleLeaf,
  onToggleDir,
}: {
  pages: WikiRemotePageRef[];
  selectedPageIds: string[];
  /** Check/uncheck a single document. */
  onToggleLeaf: (id: string, checked: boolean) => void;
  /** Check/uncheck a batch of documents (directory quick select-all / select all). */
  onToggleDir: (ids: string[], checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildTree(pages), [pages]);
  const total = useMemo(() => countLeaves(tree), [tree]);
  const everyLeafId = useMemo(() => allLeafIds(tree), [tree]);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(collectDeepDirIds(tree)),
  );

  const selectedCount = selectedPageIds.length;
  const allSelected = total > 0 && selectedCount >= total;

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      if (!node.isDir) {
        return (
          <div
            key={node.externalId}
            style={{ paddingLeft: depth * 16 + 18, paddingTop: 2, paddingBottom: 2 }}
          >
            <Checkbox
              value={selectedPageIds.includes(node.externalId)}
              onChange={(checked) => onToggleLeaf(node.externalId, checked)}
            >
              {node.title}
            </Checkbox>
          </div>
        );
      }

      const leafIds = collectLeafIds(node);
      const isCollapsed = collapsed.has(node.externalId);
      const dirAllChecked = leafIds.length > 0 && leafIds.every((id) => selectedPageIds.includes(id));

      return (
        <div key={node.externalId}>
          <div style={{ paddingLeft: depth * 16, paddingTop: 2, paddingBottom: 2 }}>
            <span style={{ cursor: 'pointer', marginRight: 4 }} onClick={() => toggleCollapse(node.externalId)}>
              {isCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
            </span>
            <Checkbox value={dirAllChecked} onChange={(checked) => onToggleDir(leafIds, checked)}>
              📁 {node.title}
              <span style={{ opacity: 0.5, marginLeft: 6, fontSize: 12 }}>
                {t('wiki.register.dirCount', { count: leafIds.length })}
              </span>
            </Checkbox>
          </div>
          {!isCollapsed && node.children.length > 0 && renderNodes(node.children, depth + 1)}
        </div>
      );
    });

  return (
    <div>
      <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{t('wiki.register.selectPages')}</span>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          {t('wiki.register.selectedCount', { count: selectedCount, total })}
        </span>
        <Button type="link" onClick={() => onToggleDir(everyLeafId, !allSelected)}>
          {allSelected ? t('common.deselectAll') : t('common.selectAll')}
        </Button>
      </div>
      <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid #eee', padding: 8 }}>
        {tree.length === 0 ? (
          <span style={{ opacity: 0.6 }}>{t('wiki.register.emptyTree')}</span>
        ) : (
          renderNodes(tree, 0)
        )}
      </div>
    </div>
  );
}
