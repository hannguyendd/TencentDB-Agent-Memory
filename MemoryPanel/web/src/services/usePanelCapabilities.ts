/**
 * usePanelCapabilities / useAnalyticsChConfigured -- visibility decision for the "Observability" entry.
 *
 * Two layers of conditions (both required):
 *   1. Panel env switch: PANEL_FEATURE_ANALYTICS_ENABLED (delivered with the capabilities of
 *      GET /meta/instances). Off by default -> the menu/route is not shown, and no CH probe request is sent.
 *   2. Runtime CH probe: once the switch is on, call GET /api/v1/analytics/config (panel transparent proxy
 *      -> kernel /v3/analytics/config). When ClickHouse is not configured the entry is hidden automatically.
 *
 * Both probe results are cached at module level: the env switch doesn't change within a session; the CH probe uses the same endpoint as the probe of
 * useAnalyticsMetrics inside AnalyticsPage (analyticsApi dedupes internally via dedupeInFlight),
 * so no duplicate network requests are produced.
 */
import { useEffect, useState } from 'react';
import { metaInstancesApi } from '@/lib/api/meta-instances';
import { analyticsApi } from '@/lib/api/analytics';

/** env switch state cache (session-level, null = not yet obtained). */
let analyticsEnabledCache: boolean | null = null;

/**
 * Panel "Observability" env switch.
 * Returns null for not yet obtained (the renderer can first treat it as invisible or keep the status quo);
 * false = the switch is off or the fetch failed (conservatively hidden); true = the switch is on (still needs the CH probe).
 */
export function usePanelAnalyticsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(analyticsEnabledCache);

  useEffect(() => {
    if (analyticsEnabledCache !== null) return;
    let alive = true;
    void metaInstancesApi
      .capabilities()
      .then((caps) => {
        analyticsEnabledCache = caps.analyticsEnabled;
        if (alive) setEnabled(caps.analyticsEnabled);
      })
      .catch(() => {
        // On fetch failure fall back to off (conservatively hidden, without blocking other panel features)
        analyticsEnabledCache = false;
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return enabled;
}

/**
 * Whether the kernel-side analytics ClickHouse is configured (runtime probe).
 * Only initiated when enabled=true; null = probing (the caller may first treat it as "visible", converging after the probe completes).
 */
export function useAnalyticsChConfigured(enabled: boolean): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    void analyticsApi
      .config()
      .then((cfg) => {
        if (alive) setConfigured(cfg.configured && cfg.reachable !== false);
      })
      .catch(() => {
        // On probe failure (network/permission) treat as not configured: the entry is hidden, and the in-page notice is handled by AnalyticsPage
        if (alive) setConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return configured;
}
