import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import type { SkillKernelPort } from '../ports/skill-kernel-port.js';
import { toKernelCredentials, type MetaCallContext } from '../types.js';

/**
 * fetch-based adapter for the skill data plane: POST /v3/skill/{action}.
 *
 * The skill body uses nested pagination (not top-level limit/offset), so meta's sanitizeBody
 * trimming is not applied and it is passed through as-is. Credentials are shared with meta (instance + api_key +
 * user_key), and user_key is always passed through (skill has no auth-exempt action like auth/verify).
 */
export class FetchSkillKernelAdapter implements SkillKernelPort {
  constructor(
    private readonly http: KernelHttpPort,
    private readonly timeoutMs: number,
  ) {}

  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext) {
    const cred = toKernelCredentials(ctx, { timeoutMs: this.timeoutMs });
    return this.http.postEnvelope(`/v3/skill/${action}`, body, cred);
  }
}
