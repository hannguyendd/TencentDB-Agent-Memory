/**
 * api/meta-instances.ts - choose an instance before login (GET /api/v1/meta/instances).
 */
import { request, dedupeInFlight } from './base';

/**
 * Instance metadata visible to the client.
 *   - `api_key` (the real secret) is not sent down.
 *   - `gateway_endpoint` is the forwarding address from backend → kernel, and also the "client access baseUrl".
 *     It is not a secret; each instance has its own, and the frontend must not hardcode it.
 *   - `proxy_endpoint` is optional. In local deployments core and proxy are separate, and the client must connect to
 *     the proxy, so this field must be configured explicitly. Used only by the frontend UI "Client access address" card; the backend
 *     forwarding always goes through `gateway_endpoint` and is not affected by it.
 */
export interface MetadataInstance {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  proxy_endpoint?: string;
}

/** Panel-level capability switches (delivered along with the instance list, used to control menu/route visibility). */
export interface PanelCapabilities {
  /** Whether the "Observability" entry is open (panel env PANEL_FEATURE_ANALYTICS_ENABLED, off by default). */
  analyticsEnabled: boolean;
}

/** Fallback value when an older Panel does not deliver capabilities (conservative: do not show the entry). */
const DEFAULT_CAPABILITIES: PanelCapabilities = { analyticsEnabled: false };

export const metaInstancesApi = {
  /** Choose an instance before login; GET /api/v1/meta/instances, public, no auth needed, no pagination */
  list: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ instances: MetadataInstance[] }>('GET', '/api/v1/meta/instances').then((r) => r.instances),
    ),

  /**
   * Panel capability switches. Same dedupe key as list(): when concurrent they share one network request,
   * each extracting the fields it needs from the response (list takes instances, this function takes capabilities).
   * An older Panel response has no such field → treated as off.
   */
  capabilities: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ capabilities?: PanelCapabilities }>('GET', '/api/v1/meta/instances').then(
        (r) => r.capabilities ?? DEFAULT_CAPABILITIES,
      ),
    ),
};
