import { isAnalyticsGetAction } from '../../api/analytics-actions.js';
import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import type { AnalyticsKernelPort } from '../ports/analytics-kernel-port.js';
import { toKernelCredentials, type MetaCallContext } from '../types.js';

/**
 * fetch-based adapter for the analytics query plane: /v3/analytics/{action}.
 *
 * The method is split by action: config / spaces use GET (the kernel only accepts GET; POST would return 405),
 * the rest use POST and pass the body through as-is (time window days|from/to, space_id, pagination limit/offset,
 * etc. are validated by the kernel zod schema; Panel does no trimming).
 *
 * Credentials are shared with meta / skill (instance + api_key + user_key). user_key is always
 * passed through: apart from config the kernel requires system_admin for everything, so authorization is left entirely to the kernel and Panel does not
 * intercept early (avoiding drift between the two sides' permission models).
 */
export class FetchAnalyticsKernelAdapter implements AnalyticsKernelPort {
  constructor(
    private readonly http: KernelHttpPort,
    private readonly timeoutMs: number,
  ) {}

  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext) {
    const cred = toKernelCredentials(ctx, { timeoutMs: this.timeoutMs });
    const path = `/v3/analytics/${action}`;
    if (isAnalyticsGetAction(action)) {
      return this.http.getEnvelope(path, cred);
    }
    return this.http.postEnvelope(path, body, cred);
  }
}
