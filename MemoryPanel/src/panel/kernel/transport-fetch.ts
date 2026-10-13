/**
 * Memory kernel v3 metadata HTTP fetch (Panel-specific).
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '../infra/logger.js';
import type { MetaEnvelope } from './envelope.js';
import { mapHttpStatusFromEnvelopeCode } from './envelope.js';
import { META_HEADER_REQUEST_ID, META_HEADER_SERVICE_ID, META_HEADER_USER_KEY } from './headers.js';

export { mapHttpStatusFromEnvelopeCode };

const SENSITIVE_KEYS = new Set([
  'password',
  'initial_password',
  'default_user_key',
  'user_key',
  'key_value',
  'granted_by_key',
  'owner_user_key',
  'creator_user_key',
  'authorization',
  'api_key',
  'token',
  'secret',
  'bearer',
]);
const MAX_LOG_FIELD_CHARS = 300;
const MAX_LOG_JSON_CHARS = 1200;

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return `${value}…`;
  return `${value.slice(0, 8)}…`;
}

function truncateString(value: string): string {
  if (value.length <= MAX_LOG_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_LOG_FIELD_CHARS)}…[truncated ${value.length - MAX_LOG_FIELD_CHARS} chars]`;
}

function sanitizeMetaBody(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max_depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeMetaBody(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = typeof raw === 'string' && raw.length > 0 ? maskSecret(raw) : '[redacted]';
      continue;
    }
    out[key] = sanitizeMetaBody(raw, depth + 1);
  }
  return out;
}

function serializeForLog(value: unknown): string {
  try {
    const json = JSON.stringify(sanitizeMetaBody(value));
    if (json.length <= MAX_LOG_JSON_CHARS) return json;
    return `${json.slice(0, MAX_LOG_JSON_CHARS)}…[truncated ${json.length - MAX_LOG_JSON_CHARS} chars]`;
  } catch {
    return '[unserializable]';
  }
}

/** Kernel HTTP call failure (network / timeout / invalid envelope). */
export class KernelFetchError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'KernelFetchError';
  }

  get httpStatus(): number {
    return mapHttpStatusFromEnvelopeCode(this.code);
  }
}

export interface MetaFetchConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  userKey?: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Passed through as x-request-id; a UUID is generated if omitted. */
  requestId?: string;
  /**
   * Extra request headers (e.g. token injection for task-source).
   *
   * Note: these headers are **not part of the logs** (logRemoteMeta serializes only the body),
   * so never put sensitive values here and then manually splice them into log fields.
   */
  extraHeaders?: Record<string, string>;
}

interface RawEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

function logRemoteMeta(
  logger: Logger | undefined,
  phase: 'request' | 'response' | 'error',
  requestId: string,
  fields: Record<string, unknown>,
): void {
  if (!logger) return;
  const msg = `[${requestId}] api.remote.${phase}`;
  if (phase === 'error') {
    logger.warn(msg, fields);
    return;
  }
  logger.info(msg, fields);
}

/**
 * Request a memory kernel path and return the full envelope.
 * - mode=envelope: business code != 0 does not throw (used by the transparent proxy)
 * - mode=data: code != 0 throws KernelFetchError
 * - method: defaults to POST; GET is used for read-only endpoints such as /v3/analytics/config, spaces (carries no body)
 */
export async function executeMetaFetch<T>(
  cfg: MetaFetchConfig,
  path: string,
  body: unknown,
  mode: 'data' | 'envelope',
  method: 'POST' | 'GET' = 'POST',
): Promise<T> {
  const base = cfg.endpoint.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const log = cfg.logger;
  const startedAt = Date.now();
  const reqId = cfg.requestId ?? randomUUID();
  logRemoteMeta(log, 'request', reqId, {
    path,
    serviceId: cfg.serviceId,
    request_id: reqId,
    requestBody: serializeForLog(body ?? {}),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [META_HEADER_SERVICE_ID]: cfg.serviceId,
      [META_HEADER_REQUEST_ID]: reqId,
    };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.userKey) headers[META_HEADER_USER_KEY] = cfg.userKey;
    if (cfg.extraHeaders) Object.assign(headers, cfg.extraHeaders);
    const resp = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: ctrl.signal,
    });
    const env = (await resp.json().catch(() => null)) as RawEnvelope<unknown> | null;
    if (!env || typeof env.code !== 'number') {
      const err = new KernelFetchError(502, `invalid envelope from ${path} (http ${resp.status})`);
      logRemoteMeta(log, 'error', reqId, {
        path,
        request_id: reqId,
        durationMs: Date.now() - startedAt,
        httpStatus: resp.status,
        error: err.message,
      });
      throw err;
    }
    const envelope: MetaEnvelope<unknown> = {
      code: env.code,
      message: env.message ?? (env.code === 0 ? 'ok' : `error ${env.code}`),
      request_id: env.request_id ?? reqId,
      data: (env.data ?? {}) as unknown,
    };
    if (mode === 'envelope') {
      if (env.code !== 0) {
        logRemoteMeta(log, 'error', envelope.request_id, {
          path,
          request_id: envelope.request_id,
          durationMs: Date.now() - startedAt,
          envelopeCode: env.code,
          envelopeMessage: envelope.message,
        });
      } else {
        logRemoteMeta(log, 'response', envelope.request_id, {
          path,
          durationMs: Date.now() - startedAt,
          request_id: envelope.request_id,
          responseBody: serializeForLog(env.data ?? {}),
        });
      }
      return envelope as T;
    }
    if (env.code !== 0) {
      const err = new KernelFetchError(env.code, envelope.message);
      logRemoteMeta(log, 'error', envelope.request_id, {
        path,
        request_id: envelope.request_id,
        durationMs: Date.now() - startedAt,
        envelopeCode: env.code,
        envelopeMessage: envelope.message,
        error: err.message,
      });
      throw err;
    }
    logRemoteMeta(log, 'response', envelope.request_id, {
      path,
      durationMs: Date.now() - startedAt,
      request_id: envelope.request_id,
      responseBody: serializeForLog(env.data ?? {}),
    });
    return (env.data ?? {}) as T;
  } catch (err) {
    if (err instanceof KernelFetchError) throw err;
    const isTimeout = (err as { name?: string }).name === 'AbortError';
    const message = isTimeout
      ? `remote metadata timeout at ${path}`
      : `remote metadata call failed at ${path}: ${(err as Error).message}`;
    const code = isTimeout ? 504 : 502;
    logRemoteMeta(log, 'error', reqId, {
      path,
      durationMs: Date.now() - startedAt,
      request_id: reqId,
      envelopeCode: code,
      error: message,
    });
    throw new KernelFetchError(code, message);
  } finally {
    clearTimeout(timer);
  }
}
