/**
 * ConsoleLayout - main layout shell.
 *
 * Based on tea-component's `Layout` + `Menu` components, containing business logic such as TabBar, routing and menu filtering.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';
import { usePanelAnalyticsEnabled, useAnalyticsChConfigured } from '@/services/usePanelCapabilities';
import { GlobalHeader } from '@/layouts/GlobalHeader';
import { TabBar } from '@/layouts/TabBar';
import { OnboardingGuide, shouldShowOnboarding, resetOnboarding } from '@/layouts/OnboardingGuide';
import { ITEM_ICON, usePageMeta, GROUP_ORDER_KEYS, type PageId } from '@/constants/menu';

const { Body, Sider, Content } = Layout;

/** Route path → PageId */
const PATH_TO_PAGE: Record<string, PageId> = {
  '/': 'workbench_board',
  '/wiki': 'wiki',
  '/code': 'code',
  '/skills': 'skills',
  '/memory': 'chat_memory',
  '/analytics': 'analytics',
  '/team/members': 'team_members',
  '/team/agents': 'team_agents',
  '/team/api-keys': 'api_keys',
};

/** PageId → route path */
const PAGE_TO_PATH: Record<PageId, string> = Object.fromEntries(
  Object.entries(PATH_TO_PAGE).map(([path, id]) => [id, path]),
) as Record<PageId, string>;

function legacyHashToPath(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const leaf = raw.split('/').filter(Boolean).pop();
  if (!leaf) return null;
  if (leaf === 'wiki') return '/wiki';
  if (leaf === 'code') return '/code';
  if (leaf === 'skills' || leaf === 'skill') return '/skills';
  if (leaf === 'chat_memory' || leaf === 'memory' || leaf === 'chat-memory') return '/memory';
  if (leaf === 'agents' || leaf === 'team_agents') return '/team/agents';
  if (leaf === 'team' || leaf === 'members' || leaf === 'team_members') return '/team/members';
  if (leaf === 'api_keys' || leaf === 'apikey' || leaf === 'api-keys') return '/team/api-keys';
  return null;
}

export function ConsoleLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { auth, logout } = useAuthStore();
  const userRole: TeamRole | null = useCurrentRole();
  const PAGE_META = usePageMeta();

  const activePage: PageId = useMemo(() => {
    const match = Object.entries(PATH_TO_PAGE).find(
      ([path]) => path !== '/' && location.pathname.startsWith(path),
    );
    return match ? match[1] : 'workbench_board';
  }, [location.pathname]);

  useEffect(() => {
    const legacyPath = legacyHashToPath();
    if (legacyPath && legacyPath !== location.pathname) {
      navigate(legacyPath, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The guide page is a standalone page (with its own back button and page header) and does not occupy the multi-tab bar
  const isGuide = location.pathname === '/guide';

  const [openPages, setOpenPages] = useState<PageId[]>(() => (isGuide ? [] : [activePage]));

  useEffect(() => {
    // The standalone /guide page does not append pages such as workbench_board to the tab bar, to avoid an extra tab on return
    if (isGuide) return;
    setOpenPages((prev) => (prev.includes(activePage) ? prev : [...prev, activePage]));
  }, [activePage, isGuide]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // First-use onboarding: after login, auto-open is decided "once per user, first time only"
  const currentUserId = auth?.user_id;
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  useEffect(() => {
    if (currentUserId && shouldShowOnboarding(currentUserId)) {
      setOnboardingVisible(true);
    }
  }, [currentUserId]);

  /**
   * Replay onboarding: clear the onboarded flag + set the Guide visible again.
   * The flag must be cleared before setVisible, otherwise the close→markOnboarded chain inside Guide
   * would immediately mark it as seen again (no conflict this time, but the next auto-check would still treat it as "seen").
   *
   * The entry is kept only at the bottom of the "Guide" page (GuidePage triggers the tdai-replay-onboarding event);
   * replay-onboarding entries such as the top bar "My Profile" have been removed as required.
   */
  const handleReplayOnboarding = useCallback(() => {
    if (!currentUserId) return;
    resetOnboarding(currentUserId);
    setOnboardingVisible(true);
  }, [currentUserId]);

  // The "replay guide" at the bottom of GuidePage is triggered via a custom event
  useEffect(() => {
    const onReplay = () => handleReplayOnboarding();
    window.addEventListener('tdai-replay-onboarding', onReplay);
    return () => window.removeEventListener('tdai-replay-onboarding', onReplay);
  }, [handleReplayOnboarding]);

  const navigateTo = useCallback(
    (id: PageId) => {
      const path = PAGE_TO_PATH[id];
      if (path) navigate(path);
    },
    [navigate],
  );

  const closePage = useCallback(
    (id: PageId) => {
      setOpenPages((prev) => {
        const next = prev.filter((p) => p !== id);
        if (id === activePage && next.length > 0) {
          navigateTo(next[next.length - 1]);
        }
        return next;
      });
    },
    [activePage, navigateTo],
  );

  // ===== Menu filtering based on team role =====
  // admin can access all pages (including resource management)
  // "Member management" item: not visible to reviewer
  //
  // "Observability" (analytics) entry is narrowed in three layers (hidden if any one is missing):
  //   1. Visible only to system_admin (useCurrentRole() === 'admin')
  //   2. Panel env switch PANEL_FEATURE_ANALYTICS_ENABLED (off by default, delivered via
  //      capabilities of /meta/instances; no CH probe is made when the switch is off)
  //   3. Runtime CH probe: automatically hidden when the kernel has no analytics ClickHouse configured
  //      (kept displayed while probing, narrowed to hidden once confirmed unconfigured, to avoid flicker)
  const analyticsSwitchOn = usePanelAnalyticsEnabled();
  const analyticsChConfigured = useAnalyticsChConfigured(analyticsSwitchOn === true);
  const analyticsVisible =
    analyticsSwitchOn === true && analyticsChConfigured !== false;

  const menuGroups = useMemo(() => {
    const byGroup = new Map<string, (typeof PAGE_META)[PageId][]>();

    for (const meta of Object.values(PAGE_META)) {
      if (userRole === 'reviewer' && meta.id === 'team_members') continue;
      // "Observability" is visible only to system_admin, and requires the panel switch on + the kernel having CH configured
      if (meta.id === 'analytics') {
        if (userRole !== 'admin' || !analyticsVisible) continue;
      }
      const list = byGroup.get(meta.group) ?? [];
      list.push(meta);
      byGroup.set(meta.group, list);
    }

    return GROUP_ORDER_KEYS.map((key) => t(`menu.group.${key}`))
      .filter((g) => byGroup.has(g))
      .map((g) => ({
        title: g,
        items: byGroup.get(g)!.sort((a, b) => a.order - b.order),
      }));
  }, [userRole, PAGE_META, t, analyticsVisible]);

  const workbenchGroupTitle = t('menu.group.workbench');
  const pinnedGroup = menuGroups.find((g) => g.title === workbenchGroupTitle);
  const restGroups = menuGroups.filter((g) => g.title !== workbenchGroupTitle);

  const renderMenuItem = (item: (typeof PAGE_META)[PageId]) => {
    const isActive = activePage === item.id;
    return (
      <Menu.Item
        key={item.id}
        title={item.label}
        icon={ITEM_ICON[item.id]}
        selected={isActive}
        onClick={() => navigateTo(item.id)}
      />
    );
  };

  return (
    <div className="_memory-app-shell">
      <OnboardingGuide
        visible={onboardingVisible}
        userId={currentUserId}
        userRole={userRole}
        onClose={() => setOnboardingVisible(false)}
      />
      <GlobalHeader
        userRole={userRole}
        currentUser={auth?.user ?? ''}
        currentUserId={auth?.user_id}
        instanceName={auth?.instance_name}
        onLogout={logout}
      />
      <Layout>
        <Body>
          <Sider>
            {/* The brand is already shown in the global Header; the sidebar only carries navigation (consistent with the shared shell of the Memory project). */}
            <Menu collapsable collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed}>
              {pinnedGroup?.items.map((item) => renderMenuItem(item))}
              {restGroups.map((group) => (
                <Menu.Group key={group.title} title={group.title}>
                  {group.items.map((item) => renderMenuItem(item))}
                </Menu.Group>
              ))}
            </Menu>
          </Sider>
          <Content>
            {!isGuide && (
              <TabBar
                pages={openPages}
                activePage={activePage}
                onNavigate={navigateTo}
                onClose={closePage}
              />
            )}
            <Content.Body className="_memory-content-body">
              {/* key bound to pathname: remount the page frame on route change to trigger the _page-enter transition, keeping cross-page continuity */}
              <main key={location.pathname} className="_memory-page-frame">
                <Outlet />
              </main>
            </Content.Body>
          </Content>
        </Body>
      </Layout>
    </div>
  );
}
 