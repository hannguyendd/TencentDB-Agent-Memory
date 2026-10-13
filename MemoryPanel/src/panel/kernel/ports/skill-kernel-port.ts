import type { MetaEnvelope } from '../envelope.js';
import type { MetaCallContext } from '../types.js';

/**
 * Transparent proxy port for the kernel /v3/skill/* data plane.
 * Same shape as MetaKernelPort, but forwards to /v3/skill/{action} instead of /v3/meta/{action}.
 */
export interface SkillKernelPort {
  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext): Promise<MetaEnvelope>;
}
