/**
 * Menu metadata - extracted from App.tsx
 *
 * Contains the page ID type, page metadata, group ordering and group icons.
 * Shared by modules such as Sidebar / TabBar / routing.
 */
import { useTranslation } from 'react-i18next';
import {
  DashboardIcon,
  UserIcon,
  UsergroupIcon,
  LockOnIcon,
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';

export type PageId =
  | 'workbench_board'
  | 'wiki'
  | 'code'
  | 'skills'
  | 'chat_memory'
  | 'team_members'
  | 'team_agents'
  | 'api_keys'
  | 'analytics';

/** Page metadata */
export interface PageMeta {
  id: PageId;
  label: string;
  desc?: string;
  /** Group it belongs to, used for the sidebar menu group title */
  group: string;
  /** Order within the group; smaller is earlier */
  order: number;
  /** Pinned tab cannot be closed (workbench board) */
  affix?: boolean;
}

// Hook version using useTranslation
export function usePageMeta(): Record<PageId, PageMeta> {
  const { t } = useTranslation();
  return {
    workbench_board: { id: 'workbench_board', label: t('menu.workbench_board'), desc: t('menu.desc.workbench_board'), group: t('menu.group.workbench'), order: 0, affix: true },
    analytics:      { id: 'analytics',      label: t('menu.analytics'), desc: t('menu.desc.analytics'), group: t('menu.group.observability'), order: 0 },
    wiki:            { id: 'wiki',            label: t('menu.wiki'), desc: t('menu.desc.wiki'), group: t('menu.group.assets'), order: 2 },
    code:            { id: 'code',            label: t('menu.code'), desc: t('menu.desc.code'), group: t('menu.group.assets'), order: 3 },
    skills:          { id: 'skills',          label: t('menu.skills'), desc: t('menu.desc.skills'), group: t('menu.group.assets'), order: 4 },
    chat_memory:     { id: 'chat_memory',     label: t('menu.chat_memory'), desc: t('menu.desc.chat_memory'), group: t('menu.group.assets'), order: 5 },
    team_members:    { id: 'team_members',    label: t('menu.team_members'), desc: t('menu.desc.team_members'), group: t('menu.group.organization'), order: 0 },
    team_agents:     { id: 'team_agents',     label: t('menu.team_agents'), desc: t('menu.desc.team_agents'), group: t('menu.group.organization'), order: 1 },
    api_keys:        { id: 'api_keys',        label: t('menu.api_keys'), desc: t('menu.desc.api_keys'), group: t('menu.group.organization'), order: 2 },
  };
}

/** Group ordering */
export const GROUP_ORDER_KEYS = ['workbench', 'observability', 'organization', 'assets'] as const;

/** Icon of each page in the sidebar menu (official Tea icons, size 16) */
export const ITEM_ICON: Record<PageId, JSX.Element> = {
  workbench_board: <DashboardIcon size={16} />,
  analytics: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="10" width="3" height="6" rx="0.8" />
      <rect x="10.5" y="6" width="3" height="10" rx="0.8" />
      <rect x="15" y="13" width="3" height="3" rx="0.8" />
    </svg>
  ),
  team_members: <UserIcon size={16} />,
  team_agents: <UsergroupIcon size={16} />,
  api_keys: <LockOnIcon size={16} />,
  wiki: <BooksIcon size={16} />,
  code: <CodeIcon size={16} />,
  skills: <ToolsIcon size={16} />,
  chat_memory: <ChatIcon size={16} />,
};

/** Group icons (Workbench / Observability / Organization & Permissions / Asset Management) */
export const GROUP_ICON: Record<string, JSX.Element> = {
  workbench: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  observability: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  organization: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  assets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  ),
};
