import type { MetaEnvelope } from '../envelope.js';
import type { MetaCallContext } from '../types.js';

/**
 * Transparent proxy port for the kernel /v3/analytics/* query plane.
 *
 * Same shape as MetaKernelPort, but internally selects GET / POST by action:
 * the kernel declares config and spaces as GET, and the rest as POST.
 */
export interface AnalyticsKernelPort {
  invoke(
    action: string,
    body: Record<string, unknown>,
    ctx: MetaCallContext,
  ): Promise<MetaEnvelope>;
}
