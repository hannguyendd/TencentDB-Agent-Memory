import type { MetaEnvelope } from './envelope.js';

export interface KernelCredentials {
  endpoint: string;
  apiKey: string;
  instanceId: string;
  userKey?: string;
  timeoutMs: number;
  requestId?: string;
  /** Extra request headers (task-source token injection, etc.). Not logged. */
  extraHeaders?: Record<string, string>;
}

/** Runtime credentials for a single kernel metadata call (assembled by middleware from Header + registry). */
export interface MetaCallContext {
  instanceId: string;
  gatewayEndpoint: string;
  gatewayApiKey: string;
  userKey?: string;
  reqId?: string;
  /** Extra request headers (task-source token injection, etc.). Not logged. */
  extraHeaders?: Record<string, string>;
}

export type { MetaEnvelope };

export function toKernelCredentials(
  ctx: MetaCallContext,
  config: { timeoutMs: number },
  opts?: { omitUserKey?: boolean },
): KernelCredentials {
  const omitUserKey = opts?.omitUserKey;
  const userKey = omitUserKey ? undefined : ctx.userKey;
  return {
    endpoint: ctx.gatewayEndpoint,
    apiKey: ctx.gatewayApiKey,
    instanceId: ctx.instanceId,
    userKey,
    timeoutMs: config.timeoutMs,
    requestId: ctx.reqId,
    extraHeaders: ctx.extraHeaders,
  };
}
