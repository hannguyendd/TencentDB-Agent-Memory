/**
 * Startup hook: ensure each instance has a knowledge-service LLM binding in KS.
 *
 * Design 2026-07-07-009 (Plan A'). TMC's `metadata-instances.json` is the source of truth.
 * For each TMC instance, query the current KS state and decide the action:
 *   1. Call KS `/llm-binding/list` once to get all bindings and cache them into a Map.
 *   2. For each TMC instance:
 *      - KS already has a usable key (has_api_key=true) -> do not touch the Gateway; only call `/set` to update proxy_base_url
 *        (without api_key, so KS keeps the original value). Call it even if the address is unchanged, to keep things simple.
 *      - KS has no usable key -> go through the Gateway user/list + user/create or user-key/create flow,
 *        and push `/set` with the new key.
 *
 * This avoids minting a new key at the Gateway on every Panel restart (constrained by the active key limit of 20).
 *
 * Best-effort: any per-instance failure is logged and skipped (never blocks startup).
 */

import type { Logger } from '../infra/logger.js';
import type { InstanceEntry } from '../config/instance-registry.js';
import { executeMetaFetch } from '../kernel/transport-fetch.js';
import type { MetaEnvelope } from '../kernel/envelope.js';

/** Fixed username of the per-instance hidden billing user for wiki LLM usage. */
export const KNOWLEDGE_SERVICE_USERNAME = 'knowledge-service';

export interface KnowledgeLlmBindingOptions {
  /** KS base URL (no /v3 suffix), e.g. http://127.0.0.1:8421. */
  knowledgeBaseUrl: string;
  /** KS Bearer token (may be empty when KS trusts the internal network). */
  knowledgeAuthToken: string;
  /** Context proxy root, e.g. http://127.0.0.1:8096. */
  proxyBaseUrl: string;
  /** Kernel call timeout (ms). */
  timeoutMs: number;
}

type EnsureOutcome = 'skipped' | 'bound' | 'error';

/** Snapshot of a single binding returned by KS /llm-binding/list (without the plaintext api_key). */
interface KsBindingSnapshot {
  service_id: string;
  mode: string;
  proxy_base_url: string | null;
  base_url: string | null;
  has_api_key: boolean;
  enabled: boolean;
}

interface KsEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

async function ksPost<T>(
  opts: KnowledgeLlmBindingOptions,
  path: string,
  serviceId: string,
  body: unknown,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // /list does not need the service-id header; other paths do
    if (serviceId) headers['x-tdai-service-id'] = serviceId;
    if (opts.knowledgeAuthToken) headers.Authorization = `Bearer ${opts.knowledgeAuthToken}`;
    const resp = await fetch(`${opts.knowledgeBaseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const json = (await resp.json().catch(() => null)) as KsEnvelope<T> | null;
    if (!json || (json.code !== undefined && json.code !== 0)) {
      throw new Error(`KS ${path} failed (http ${resp.status}, code ${json?.code}): ${json?.message ?? ''}`);
    }
    return (json.data ?? {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** One instance: ensure the binding exists (create/mint/push as needed). */
export async function ensureKnowledgeLlmBinding(
  instance: InstanceEntry,
  opts: KnowledgeLlmBindingOptions,
  logger: Logger,
  ksBindings: Map<string, KsBindingSnapshot>,
): Promise<EnsureOutcome> {
  const serviceId = instance.instance_id;
  const cached = ksBindings.get(serviceId);

  // Scenario A: KS already has a usable key -> do not touch the Gateway; only update proxy_base_url (KS keeps the original key)
  if (cached?.has_api_key) {
    await ksPost(opts, '/v3/internal/llm-binding/set', serviceId, {
      mode: 'proxy',
      proxy_base_url: opts.proxyBaseUrl,
      enabled: true,
      // No api_key passed -> KS keeps the original value
    });
    logger.info('knowledge llm-binding refreshed (key retained)', { instanceId: serviceId });
    return 'bound';
  }

  // Scenario B: KS has no usable key -> need the Gateway user + key flow
  const metaCfg = {
    endpoint: instance.gateway_endpoint,
    apiKey: instance.api_key,
    serviceId,
    userKey: instance.api_key,
    timeoutMs: opts.timeoutMs,
    logger,
  };

  let userKey: string;

  // Try to find existing knowledge-service user via user/list
  const listEnv = await executeMetaFetch<MetaEnvelope<{ items?: Array<{ user_id: string; username: string }> }>>(
    metaCfg, '/v3/meta/user/list', { username: KNOWLEDGE_SERVICE_USERNAME, limit: 10, offset: 0 }, 'envelope',
  );
  const existing = listEnv.code === 0
    ? (listEnv.data as { items?: Array<{ user_id: string; username: string }> })?.items?.find(
        (u) => u.username === KNOWLEDGE_SERVICE_USERNAME,
      )
    : undefined;

  if (!existing) {
    const createEnv = await executeMetaFetch<MetaEnvelope<{ user_id: string; default_user_key: string }>>(
      // Pass a deterministic user_id = username, so the proxy systemUsers allowlist can hit by a stable user_id
      // (one config covers all instances, without needing to know the random usr-xxx).
      metaCfg, '/v3/meta/user/create', { username: KNOWLEDGE_SERVICE_USERNAME, user_id: KNOWLEDGE_SERVICE_USERNAME }, 'envelope',
    );
    if (createEnv.code !== 0) throw new Error(`user/create failed: ${createEnv.message}`);
    const data = createEnv.data as { user_id: string; default_user_key: string };
    userKey = data.default_user_key;
    logger.info('created knowledge-service user', { instanceId: serviceId, userId: data.user_id });
  } else {
    const mintEnv = await executeMetaFetch<MetaEnvelope<{ key_value: string }>>(
      metaCfg, '/v3/meta/user-key/create', { user_id: existing.user_id, name: 'ks-llm-binding' }, 'envelope',
    );
    if (mintEnv.code !== 0) throw new Error(`user-key/create failed: ${mintEnv.message}`);
    userKey = (mintEnv.data as { key_value: string }).key_value;
    logger.info('minted new key for existing knowledge-service user', {
      instanceId: serviceId,
      userId: existing.user_id,
    });
  }

  // 3. Push to KS (right after mint — show-once).
  await ksPost(opts, '/v3/internal/llm-binding/set', serviceId, {
    mode: 'proxy',
    proxy_base_url: opts.proxyBaseUrl,
    api_key: userKey,
    enabled: true,
  });
  logger.info('pushed knowledge llm-binding to KS (new key)', { instanceId: serviceId });
  return 'bound';
}

/** All instances, best-effort. Never throws. */
export async function ensureKnowledgeLlmBindings(
  instances: InstanceEntry[],
  opts: KnowledgeLlmBindingOptions,
  logger: Logger,
): Promise<void> {
  // 1. Query KS /llm-binding/list once to cache the current state
  let ksBindings = new Map<string, KsBindingSnapshot>();
  try {
    const resp = await ksPost<{ items: KsBindingSnapshot[] }>(
      opts, '/v3/internal/llm-binding/list', '', {},
    );
    ksBindings = new Map((resp.items ?? []).map((b) => [b.service_id, b]));
    logger.info('fetched KS llm-binding list', { count: ksBindings.size });
  } catch (err) {
    logger.warn('failed to fetch KS llm-binding list, will mint per-instance', {
      error: err instanceof Error ? err.message : String(err),
    });
    // On KS /list failure fall back: ksBindings is an empty Map and every instance goes through the mint flow (compatible with old KS)
  }

  // 2. Process each in turn, based on the TMC instances list
  for (const instance of instances) {
    try {
      await ensureKnowledgeLlmBinding(instance, opts, logger, ksBindings);
    } catch (err) {
      logger.warn('knowledge llm-binding ensure failed (will rely on manual recovery)', {
        instanceId: instance.instance_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
