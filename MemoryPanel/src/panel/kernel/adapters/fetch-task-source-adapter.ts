/**
 * Kernel adapter for Task external sources.
 *
 * Why not reuse FetchMetaKernelAdapter:
 *   It hardcodes the `/v3/meta/${action}` prefix, while task-source is a separate `/v3/task-source/${action}`
 *   route family (the business is not in the meta domain). So this is a separate but isomorphic forwarding path:
 *   same envelope protocol, same instance headers and user_key authentication, differing only in the path prefix.
 *
 * Token injection: the caller passes it via ctx.extraHeaders; the adapter is unaware of its semantics
 * and does no persistence either -- the token is passed only once over this internal-network link.
 */

import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import { toKernelCredentials, type MetaCallContext } from '../types.js';
import type { MetaEnvelope } from '../envelope.js';
import type { TaskSourceKernelPort } from '../ports/task-source-kernel-port.js';

export class FetchTaskSourceAdapter implements TaskSourceKernelPort {
  constructor(
    private readonly http: KernelHttpPort,
    private readonly timeoutMs: number,
  ) {}

  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext): Promise<MetaEnvelope> {
    const cred = toKernelCredentials(ctx, { timeoutMs: this.timeoutMs });
    return this.http.postEnvelope(`/v3/task-source/${action}`, body, cred);
  }
}
