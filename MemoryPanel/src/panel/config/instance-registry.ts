import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gateway_endpoint: z.string().url(),
  // Optional: client access endpoint (e.g. the baseUrl for CodeBuddy / ClaudeCode CLI).
  // Difference from `gateway_endpoint`:
  //   - `gateway_endpoint` is always the Panel backend -> Kernel forwarding address (core / gateway),
  //     the gateway in production; local open-source deployments may point it directly at core. This field controls **panel forwarding** and must never be moved.
  //   - `proxy_endpoint` is only used by the frontend "client access endpoint" card for display.
  //     In production the gateway fronts the proxy, so both values are the same (can be omitted; falls back to gateway_endpoint to keep the old behavior);
  //     in local open-source deployments core and proxy run separately and clients must connect to the proxy, so this field has to be set explicitly.
  proxy_endpoint: z.string().url().optional(),
  api_key: z.string().min(1),
});

const fileSchema = z.object({
  instances: z.array(instanceSchema).min(1),
});

export interface InstanceEntry {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  /** See the comment above instanceSchema.proxy_endpoint; if not configured, the frontend falls back to gateway_endpoint. */
  proxy_endpoint?: string;
  api_key: string;
}

export interface PublicInstance {
  instance_id: string;
  name: string;
  /**
   * Panel backend -> Kernel forwarding address (e.g. https://memory.ap-beijing.tencenttdai.com).
   * Not a secret -- CodeBuddy / ClaudeCode CLI users have historically used it to configure baseUrl as well;
   * the frontend must not hardcode it, since each instance has a different endpoint (dev/staging/prod).
   * `api_key` is a secret and is never sent down.
   */
  gateway_endpoint: string;
  /**
   * Optional: client access baseUrl (used by the frontend "client access endpoint" card).
   * When omitted the frontend falls back to `gateway_endpoint`, same as the old behavior. **Not used by the Panel forwarding path**.
   */
  proxy_endpoint?: string;
}

export class InstanceRegistryError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'InstanceRegistryError';
  }
}

export class InstanceRegistry {
  private readonly byId: Map<string, InstanceEntry>;

  constructor(entries: InstanceEntry[]) {
    this.byId = new Map(entries.map((e) => [e.instance_id, e]));
  }

  static load(configPath: string): InstanceRegistry {
    const filePath = resolve(configPath);
    if (!existsSync(filePath)) {
      throw new InstanceRegistryError(
        500,
        `metadata instances config not found: ${filePath}\n` +
          `  hint: cp config/metadata-instances.example.json config/metadata-instances.json`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch {
      throw new InstanceRegistryError(500, `invalid metadata instances config: ${filePath}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InstanceRegistryError(500, `metadata instances config validation failed`);
    }
    const entries = parsed.data.instances.map((row) => ({
      instance_id: row.id,
      name: row.name,
      gateway_endpoint: row.gateway_endpoint,
      proxy_endpoint: row.proxy_endpoint,
      api_key: row.api_key,
    }));
    return new InstanceRegistry(entries);
  }

  resolve(instanceId: string): InstanceEntry {
    const entry = this.byId.get(instanceId);
    if (!entry) {
      throw new InstanceRegistryError(400, 'INVALID_INSTANCE');
    }
    return entry;
  }

  listPublic(): PublicInstance[] {
    return [...this.byId.values()].map(({ instance_id, name, gateway_endpoint, proxy_endpoint }) => ({
      instance_id,
      name,
      gateway_endpoint,
      // When not set, the field is omitted (rather than an explicit undefined, which keeps the frontend `??` fallback cleaner)
      ...(proxy_endpoint ? { proxy_endpoint } : {}),
    }));
  }

  /** Full entries incl. credentials — internal startup/admin use only, never client-facing. */
  listAll(): InstanceEntry[] {
    return [...this.byId.values()];
  }
}
