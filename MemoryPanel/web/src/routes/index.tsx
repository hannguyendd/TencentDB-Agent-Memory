/**
 * Route table definition
 *
 * Uses react-router's createBrowserRouter / RouterProvider.
 * ConsoleLayout is the parent route, and each page is a child route.
 */
import { createHashRouter, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { WorkbenchPage } from '@/pages/WorkbenchPage';
import { WikiPage } from '@/pages/WikiPage';
import { CodePage } from '@/pages/CodePage';
import { SkillsPage } from '@/pages/SkillsPage';
import { ChatMemoryPage } from '@/pages/ChatMemoryPage';
import { MembersPage } from '@/pages/MembersPage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { GuidePage } from '@/pages/GuidePage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      { index: true, element: <WorkbenchPage /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'code', element: <CodePage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'memory', element: <ChatMemoryPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'team/members', element: <MembersPage /> },
      { path: 'team/agents', element: <AgentsPage /> },
      { path: 'team/api-keys', element: <ApiKeysPage /> },
      { path: 'guide', element: <GuidePage /> },
    ],
  },
];

/**
 * Uses HashRouter -- stays compatible with the old hash routing,
 * and avoids 404 on refresh (static deployment needs no server-side fallback config).
 */
export const router = createHashRouter(routes);
