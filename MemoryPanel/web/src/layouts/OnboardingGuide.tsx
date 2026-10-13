/**
 * OnboardingGuide - first-use onboarding (Tea Guide component version)
 *
 * Uses the tea-component `Guide` component to highlight page elements step by step, replacing the old full-screen two-column guide.
 *
 * Dual-role SOP (on step change it automatically navigates to the matching page, not just displays):
 *   - Admin: login identity → create/switch team → create member and issue user_key → Agent → click Agent to bind assets → four asset pages
 *   - Member: login identity → invite member → Agent → click Agent to bind assets → User_Key management → four asset pages
 *
 * Admin and Member have the same Agent / asset operation abilities (both can edit); the only difference is in member management:
 * a member cannot create user accounts and can only invite existing users by user_id; an admin can create users and issue
 * user_key, and can also create teams. The asset steps jump into the Wiki / Code / Skill / Chat Memory pages one by one to introduce them.
 *
 * Robustness: if the element selector of any step is missing on the target page (e.g. a member lacks the "Add member" permission),
 * it automatically falls back to the global Header brand area, so the Guide does not vanish entirely due to a missing element.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Guide, type GuideStep } from 'tea-component';

const STORAGE_PREFIX = 'tdai-panel.onboarded';

/** Anchor element that always exists globally (Header brand area), used as a fallback when the target element is missing */
const FALLBACK_SELECTOR = '._memory-global-header-brand';

/** Per-user "onboarding already seen" localStorage key */
function onboardedKey(userId?: string): string {
  return `${STORAGE_PREFIX}.${userId || 'anonymous'}`;
}

/** Whether the onboarding should auto-open (never marked = first time) */
export function shouldShowOnboarding(userId?: string): boolean {
  try {
    return window.localStorage.getItem(onboardedKey(userId)) !== '1';
  } catch {
    // Do not disturb the user when localStorage is unavailable
    return false;
  }
}

/**
 * Reset the "onboarding already seen" flag.
 *
 * Triggered manually by the user via "My Profile → Replay onboarding": clears the onboarded flag, and next time the main panel is entered
 * the useEffect detects shouldShowOnboarding() === true and auto-opens it again.
 *
 * Note: the caller must also set the OnboardingGuide's visible back to true, because the earlier close()
 * has already advanced the internal current to -1 and called onClose; clearing the flag alone is not enough to reopen it.
 */
export function resetOnboarding(userId?: string): void {
  try {
    window.localStorage.removeItem(onboardedKey(userId));
  } catch {
    /* Silently ignore when localStorage is unavailable */
  }
}

function markOnboarded(userId?: string): void {
  try {
    window.localStorage.setItem(onboardedKey(userId), '1');
  } catch {
    /* Silently ignore when localStorage is unavailable */
  }
}

interface OnboardingStep {
  /** Target route: auto-navigate on step change (omitted means stay on the current page) */
  path?: string;
  /**
   * Selector(s) of the element to highlight. Supports an array for sequential fallback (e.g. admin prefers highlighting the "Add member" button,
   * falling back to the member list area when the button does not exist), finally falling back to the Header brand area when all are missing.
   */
  selector: string | string[];
  placement?: GuideStep['placement'];
  titleKey: string;
  descKey: string;
}

/** Return the first matching element in order, or null if none is found */
function firstMatch(selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Resolve the step highlight element; fall back in order when the target is missing, finally to the global Header brand area, so the Guide can always render */
function resolveElement(selector: string | string[]): Element {
  const list = Array.isArray(selector) ? selector : [selector];
  return firstMatch(list) || document.querySelector(FALLBACK_SELECTOR) || document.body;
}

/**
 * Dynamically compute the bubble expansion direction from the element's actual position in the viewport:
 *   - Horizontal: element center in the left half → expand right (*-start); in the right half → expand left (*-end)
 *   - Vertical: element center in the upper half → expand down (bottom-*); in the lower half → expand up (top-*)
 * So the bubble always expands toward the viewport center, and an element at any page/position is never pushed off screen.
 */
function computePlacement(
  selector: string | string[],
  fallback: GuideStep['placement'],
): GuideStep['placement'] {
  const list = Array.isArray(selector) ? selector : [selector];
  const el = firstMatch(list);
  // When the element is missing (page not navigated/not rendered), direction cannot be inferred from position, so use the step's preset safe direction directly.
  // Never fall back to computing with body: the body rect height far exceeds the viewport, cy is always greater than innerHeight/2,
  // which would compute top-* and position the bubble off screen (the root cause of "box exceeds screen, can't click").
  if (!el) return fallback;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const horizontal = cx < window.innerWidth / 2 ? 'start' : 'end';
  const vertical = cy < window.innerHeight / 2 ? 'bottom' : 'top';
  const placement = `${vertical}-${horizontal}`;
  if (
    placement === 'bottom-start' ||
    placement === 'bottom-end' ||
    placement === 'top-start' ||
    placement === 'top-end'
  ) {
    return placement;
  }
  return fallback;
}

/**
 * Onboarding step for clicking an Agent to open the edit dialog and bind assets (shared by Admin / Member,
 * immediately follows the "New Agent" step, same-page switch without navigation).
 * Three-level anchor fallback:
 *   1. Card view: box the whole card of the first editable Agent;
 *   2. List view (no cards): fall back to the name button of an editable Agent;
 *   3. User has no Agent yet: fall back to the "New Agent" button,
 *      with the copy also hinting "create an Agent first, then come back and click it".
 */
const AGENT_BIND_STEP: OnboardingStep = {
  path: '/team/agents',
  selector: [
    '[data-guide="agent-card-editable"]',
    '[data-guide="agent-name-editable"]',
    '[data-guide="create-agent"]',
  ],
  placement: 'bottom-start',
  titleKey: 'onboarding.guide.agentBind.title',
  descKey: 'onboarding.guide.agentBind.desc',
};

/** Onboarding steps that jump into each asset page to introduce it (Wiki / Code / Skill / Chat Memory) */
const ASSET_STEPS: OnboardingStep[] = [
  {
    path: '/wiki',
    // Prefer boxing the "New Wiki" button; when the button is missing (pinned asset tab / no team) fall back to the top Wiki tab,
    // rather than the logo, to avoid boxing the wrong area.
    selector: ['[data-guide="create-wiki"]', '[data-guide="tab-wiki"]'],
    // "New Wiki" button on the left of ActionPanel: expand right
    placement: 'bottom-start',
    titleKey: 'onboarding.guide.asset.wiki.title',
    descKey: 'onboarding.guide.asset.wiki.desc',
  },
  {
    path: '/code',
    // Prefer boxing the "Register repository" button; fall back to the top Code tab when the button is missing.
    selector: ['[data-guide="create-code"]', '[data-guide="tab-code"]'],
    // "Register repository" button on the left of ActionPanel: expand right
    placement: 'bottom-start',
    titleKey: 'onboarding.guide.asset.code.title',
    descKey: 'onboarding.guide.asset.code.desc',
  },
  {
    path: '/skills',
    selector: '[data-guide="import-skill"]',
    // "Import Skill" button in the page header's right-side actions (same as Memory): expand left
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.asset.skill.title',
    descKey: 'onboarding.guide.asset.skill.desc',
  },
  {
    path: '/memory',
    selector: '[data-guide="import-memory"]',
    // "Import memory" button on the right: expand left
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.asset.memory.title',
    descKey: 'onboarding.guide.asset.memory.desc',
  },
];

function buildSteps(role: 'admin' | 'member'): OnboardingStep[] {
  const loginStep: OnboardingStep = {
    selector: '._memory-global-header-user-btn',
    // User button at the top right of the header: use bottom-end so the bubble's right edge aligns with the element's right edge and expands left,
    // avoiding the bubble clipping the "Next" button on narrow viewports
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.login.title',
    descKey: 'onboarding.guide.login.desc',
  };

  // Admin and Member have the same Agent / asset operation abilities (both can edit); only member management differs:
  //   - admin: can create teams, create users and issue user_key (member lacks this permission)
  //   - member: can only invite existing users into the team by user_id; but can manage their own User_Key (admin has no such entry)
  // placement choice: right-side elements use bottom-end (expand left), left-side elements use bottom-start (expand right)
  if (role === 'admin') {
    return [
      loginStep,
      {
        selector: '._memory-team-switcher-trigger',
        // Top-left of the header: expand left to avoid overflow when shifting right
        placement: 'bottom-start',
        titleKey: 'onboarding.guide.team.title',
        descKey: 'onboarding.guide.team.desc',
      },
      {
        path: '/team/members',
        // Prefer highlighting the "Add member" button; when there is no team the button does not exist, fall back to the member list area
        selector: ['[data-guide="add-member"]', '[data-guide="members-list"]'],
        placement: 'bottom-end',
        titleKey: 'onboarding.guide.memberAdmin.title',
        descKey: 'onboarding.guide.memberAdmin.desc',
      },
      {
        path: '/team/agents',
        selector: '[data-guide="create-agent"]',
        // "New Agent" button on the left of ActionPanel: expand right
        placement: 'bottom-start',
        titleKey: 'onboarding.guide.agent.title',
        descKey: 'onboarding.guide.agent.desc',
      },
      AGENT_BIND_STEP,
      ...ASSET_STEPS,
    ];
  }

  return [
    loginStep,
    {
      path: '/team/members',
      // A regular member has no "Add member" button (only visible to admin/teamAdmin),
      // so highlight the always-present member list area, avoiding fallback to the header causing "no navigation / wrong positioning"
      selector: '[data-guide="members-list"]',
      placement: 'bottom-start',
      titleKey: 'onboarding.guide.member.title',
      descKey: 'onboarding.guide.member.desc',
    },
    {
      path: '/team/agents',
      selector: '[data-guide="create-agent"]',
      // "New Agent" button on the left of ActionPanel: expand right
      placement: 'bottom-start',
      titleKey: 'onboarding.guide.agent.title',
      descKey: 'onboarding.guide.agent.desc',
    },
    AGENT_BIND_STEP,
    {
      path: '/team/api-keys',
      selector: '[data-guide="create-key"]',
      // "New Key" button on the right of Justify: expand left
      placement: 'bottom-end',
      titleKey: 'onboarding.guide.apikey.title',
      descKey: 'onboarding.guide.apikey.desc',
    },
    ...ASSET_STEPS,
  ];
}

export function OnboardingGuide({
  visible,
  userId,
  userRole,
  onClose,
}: {
  visible: boolean;
  userId?: string;
  userRole: 'admin' | 'member' | 'reviewer' | null;
  /** Close the onboarding (both "Skip" and "Finish" mark it as seen) */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const isAdmin = userRole === 'admin';
  const steps = useMemo(() => buildSteps(isAdmin ? 'admin' : 'member'), [isAdmin]);

  const [current, setCurrent] = useState(-1);
  const pendingRef = useRef<number | null>(null);

  /**
   * Animation alignment strategy (replaces the old "hide→show" gating, eliminating the unmasked gap):
   *   - Same-page switch: the bubble (popper transform) and highlight box (top/left/width/height) carry a
   *     CSS transition, sliding smoothly to the new position along with the scrollIntoView smooth scroll, visible throughout;
   *   - Cross-page switch: the old anchor unmounts with the page (popper positions detached elements at 0,0),
   *     so fadeOut first → navigate → once the new anchor is ready no-anim snaps into place → fadeIn.
   */
  const fadeOut = useCallback(() => {
    document.body.classList.add('_guide-fading');
  }, []);

  /** Fade in after the new step's first-frame positioning completes (double rAF: wait for React commit + popper positioning) */
  const fadeIn = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.remove('_guide-fading');
        document.body.classList.remove('_guide-no-anim');
      });
    });
  }, []);

  // Clean up the global class on unmount
  useEffect(() => {
    return () => {
      document.body.classList.remove('_guide-fading');
      document.body.classList.remove('_guide-no-anim');
    };
  }, []);

  const close = useCallback(() => {
    markOnboarded(userId);
    pendingRef.current = null;
    document.body.classList.remove('_guide-fading');
    document.body.classList.remove('_guide-no-anim');
    setCurrent(-1);
    onClose();
  }, [userId, onClose]);

  // Step switching: finish/cancel close directly; next/back/start first navigate to the target page,
  // and advance current only after the target path matches and the element appears (avoids the Guide flashing away due to a missing element).
  const handleCurrentChange = useCallback(
    (next: number, context: { from: 'start' | 'back' | 'next' | 'finish' | 'cancel' }) => {
      const { from } = context;
      if (from === 'finish' || from === 'cancel') {
        close();
        return;
      }
      if (next < 0 || next >= steps.length) return;
      const target = steps[next];
      if (!target) return;
      if (target.path && target.path !== location.pathname) {
        // Cross-page navigation: fade out first (covering the "anchor unmount → new page load" window), fade in after pending completes
        fadeOut();
        pendingRef.current = next;
        navigate(target.path);
      } else {
        // Same-page switch: advance directly, position transition aligns with the scroll animation, sliding over smoothly
        setCurrent(next);
      }
    },
    [steps, location.pathname, navigate, close, fadeOut],
  );

  // Wait for navigation to complete: after the path matches, poll until the target element appears, then advance current (wait at most 60 frames, about 1s)
  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    const target = steps[pending];
    if (!target || !target.path) return;
    if (location.pathname !== target.path) return;

    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      // selector may be a fallback array: any element appearing means the target page is ready
      const list = Array.isArray(target.selector) ? target.selector : [target.selector];
      if (firstMatch(list) || tries >= 60) {
        pendingRef.current = null;
        // New anchor snaps into place (no-anim disables transitions, avoiding sliding in from the old position), then fades in
        document.body.classList.add('_guide-no-anim');
        setCurrent(pending);
        fadeIn();
        return;
      }
      tries += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [location.pathname, steps, fadeIn]);

  // Initial display: disable transitions before popper's first-frame positioning (avoiding the bubble sliding in from (0,0)), enable after positioning completes
  useEffect(() => {
    if (!visible) return;
    document.body.classList.add('_guide-no-anim');
    const timer = window.setTimeout(() => {
      document.body.classList.remove('_guide-no-anim');
    }, 50);
    return () => {
      window.clearTimeout(timer);
      document.body.classList.remove('_guide-no-anim');
    };
  }, [visible]);
  const guideSteps: GuideStep[] = useMemo(
    () =>
      steps.map((s) => ({
        element: () => resolveElement(s.selector),
        placement: computePlacement(s.selector, s.placement),
        title: t(s.titleKey),
        description: t(s.descKey),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps, t, current, visible],
  );

  const startContent: GuideStep = useMemo(
    () => ({
      element: () => resolveElement(FALLBACK_SELECTOR),
      // Welcome page highlights the header brand area: compute direction dynamically from the actual position
      placement: computePlacement(FALLBACK_SELECTOR, 'bottom-start'),
      title: t(
        isAdmin ? 'onboarding.guide.start.admin.title' : 'onboarding.guide.start.member.title',
      ),
      description: t(
        isAdmin ? 'onboarding.guide.start.admin.desc' : 'onboarding.guide.start.member.desc',
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin, t, visible],
  );

  // ===== Custom precise highlight layer =====
  // The built-in tea Guide mask is positioned with react-popper: under an inner scroll container (tea-layout__content)
  // it has a fixed offset (about 3~5px) and does not update on scroll (the offset grows after scrolling), causing the highlight box to
  // "leak at the edges". Here we compute in real time with getBoundingClientRect (capture-listening to inner container scroll +
  // resize), and hide the Guide's own mask with global CSS (see index.css `.tea-overlay[style*="z-index: 9999"]`).
  const anchorSelector =
    current >= 0 && steps[current] ? steps[current].selector : FALLBACK_SELECTOR;
  const [anchorBox, setAnchorBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!visible) {
      setAnchorBox(null);
      return;
    }
    const update = () => {
      const el = resolveElement(anchorSelector);
      if (!el || el === document.body) return;
      const r = el.getBoundingClientRect();
      setAnchorBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    update();
    // At the moment of step change the Guide's scrollIntoView(smooth) animation may not have finished,
    // so the immediate measurement is a mid-animation position; use rAF + a delayed fallback to correct it once the layout is stable.
    const raf = requestAnimationFrame(update);
    const late = window.setTimeout(update, 400);
    // Listen in the capture phase to catch scroll events of the inner scroll container (not window)
    const onScrollOrResize = () => requestAnimationFrame(update);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    // Layout changes caused by data loading etc. can also move the anchor (ResizeObserver covers more than the resize event)
    const ro = new ResizeObserver(() => requestAnimationFrame(update));
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(late);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      ro.disconnect();
    };
  }, [visible, anchorSelector]);

  return (
    <>
      <Guide
        visible={visible}
        steps={guideSteps}
        startContent={startContent}
        current={current}
        onCurrentChange={handleCurrentChange}
        showBackButton
        showDot
        nextButtonTheme="primary"
        cancelText={t('onboarding.skip')}
        backText={t('onboarding.prev')}
        nextText={t('onboarding.next')}
        finishText={t('onboarding.finish')}
        startFinishText={t('onboarding.start')}
        autoScrollIntoView
      />
      {anchorBox && (
        <div className="_guide-mask" aria-hidden="true">
          {/* Four semi-transparent mask blocks (top/bottom/left/right) form the highlight hole */}
          <div
            className="_guide-mask-block"
            style={{ top: 0, left: 0, right: 0, height: anchorBox.top }}
          />
          <div
            className="_guide-mask-block"
            style={{ top: anchorBox.top + anchorBox.height, left: 0, right: 0, bottom: 0 }}
          />
          <div
            className="_guide-mask-block"
            style={{ top: anchorBox.top, left: 0, width: anchorBox.left, height: anchorBox.height }}
          />
          <div
            className="_guide-mask-block"
            style={{
              top: anchorBox.top,
              left: anchorBox.left + anchorBox.width,
              right: 0,
              height: anchorBox.height,
            }}
          />
          {/* Highlight outline */}
          <div
            className="_guide-mask-ring"
            style={{
              top: anchorBox.top,
              left: anchorBox.left,
              width: anchorBox.width,
              height: anchorBox.height,
            }}
          />
        </div>
      )}
    </>
  );
}
