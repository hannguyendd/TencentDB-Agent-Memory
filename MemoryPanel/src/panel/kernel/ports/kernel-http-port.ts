import type { MetaEnvelope } from '../envelope.js';
import type { KernelCredentials } from '../types.js';

export interface KernelHttpPort {
  /** POST a kernel path and return the full envelope (business code != 0 does not throw, for transparent proxy pass-through). */
  postEnvelope<T>(path: string, body: unknown, cred: KernelCredentials): Promise<MetaEnvelope<T>>;
  /** GET a kernel path and return the full envelope (read-only endpoints such as /v3/analytics/config, spaces). */
  getEnvelope<T>(path: string, cred: KernelCredentials): Promise<MetaEnvelope<T>>;
}
