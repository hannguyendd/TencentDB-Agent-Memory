/**
 * storage-utils.ts -- shared foundation of the local demo data layer.
 *
 * Shared by agent-template-store / asset-scope-store / user-asset-store /
 * account-store / user-profile-store:
 *   - safeParse: a fault-tolerant JSON.parse that falls back to a default value on parse failure;
 *   - emitChange / CHANGE_EVENT: broadcast a global event after write operations, working with
 *     useChangeNotifier so subscribers (the various useXxx hooks) re-render automatically;
 *   - useChangeNotifier: a simple forceUpdate that listens to CHANGE_EVENT and the browser's
 *     native 'storage' event (cross-tab sync).
 *
 * These stores are all frontend demo-phase localStorage implementations; after the backend goes live they can be replaced wholesale
 * with fetch, with no UI-layer change.
 */

import { useEffect, useState } from 'react';

export const CHANGE_EVENT = 'tdai-memory.demo-store-change';

export function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function emitChange(): void {
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

/** Simple forceUpdate: +1 after localStorage / a custom event fires. */
export function useChangeNotifier(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onChange = () => setTick((v) => v + 1);
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange); // Cross-tab sync
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return tick;
}
