/**
 * WikiSourceRegistry — wiki provider registry.
 *
 * Symmetric with CodeSourceRegistry: the registry is unaware of any concrete platform;
 * platform differences live only in `providers/<id>/`.
 *
 * Deployment config (same-name pattern):
 *   WIKI_SOURCE_ENABLED=iwiki
 *   WIKI_SOURCE_<UPPER_ID>_<ENDPOINT_SUFFIX>=https://...  # service endpoint (suffix declared by the provider, default MCP_URL)
 *   WIKI_SOURCE_<UPPER_ID>_SITE_BASE_URL=https://.../     # site root (used to build the token page)
 *
 * The display name is not made configurable: the frontend uses i18n via `wiki.source.<id>`.
 *
 * The registry is **unaware of any concrete platform**: the built-in list comes from providers/index.ts,
 * and the endpoint config name is declared by the provider itself → onboarding a REST-style platform needs no change to this file.
 */

import type { SourceContext, WikiSourceMeta, WikiSourceProvider } from "./types.js";
import { BUILTIN_PROVIDERS } from "./providers/index.js";

/** Default value of the endpoint config name suffix: MCP protocol type. */
const DEFAULT_ENDPOINT_SUFFIX = "MCP_URL";

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function envKey(id: string, suffix: string): string {
  return `WIKI_SOURCE_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function joinSitePath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function enabledIds(): string[] {
  const raw = env("WIKI_SOURCE_ENABLED");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the token application page address.
 *
 * - Provider declares `tokenUrlEnv` → **use that env's full URL directly**, without concatenation.
 *   That env name is **global** (e.g. `TAI_PAT_URL`) and is not prefixed per source —
 *   so multiple sources can point to the same token page, and changing the address means changing only one place.
 * - Provider declares `path` → append it to the deployment-configured `WIKI_SOURCE_<ID>_SITE_BASE_URL`.
 *
 * Addresses always come from deployment config: **no intranet domain is hard-coded in code**.
 */
function resolveTokenDocUrl(provider: WikiSourceProvider): string | undefined {
  const tokenDoc = provider.sitePaths.tokenDoc;

  // Full URL (no concatenation): used when multiple sources share the same token page.
  if (tokenDoc && "tokenUrlEnv" in tokenDoc) return env(tokenDoc.tokenUrlEnv);

  if (tokenDoc && "path" in tokenDoc) {
    const siteBase = env(envKey(provider.id, "SITE_BASE_URL"));
    return siteBase ? joinSitePath(siteBase, tokenDoc.path) : undefined;
  }
  return undefined;
}

function toMeta(provider: WikiSourceProvider): WikiSourceMeta {
  return {
    id: provider.id,
    auth_method: provider.authMethod.kind,
    form_fields: provider.authMethod.formFields,
    token_doc_url: resolveTokenDocUrl(provider),
  };
}

export class WikiSourceRegistry {
  private readonly providers = new Map<string, WikiSourceProvider>();

  constructor(
    ids?: string[],
    builtins: readonly WikiSourceProvider[] = BUILTIN_PROVIDERS,
  ) {
    const enabledSet = new Set(ids ?? enabledIds());
    const known = new Set(builtins.map((p) => p.id));
    // Enabling an id that is not built in is a config error: throw immediately, do not silently stuff in a placeholder
    const unknown = [...enabledSet].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `WIKI_SOURCE_ENABLED contains unknown source(s): ${unknown.join(", ")}. ` +
          `Available: ${[...known].join(", ") || "(none)"}.`,
      );
    }
    for (const p of builtins) {
      if (enabledSet.has(p.id)) this.providers.set(p.id, p);
    }
  }

  register(provider: WikiSourceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): WikiSourceProvider | undefined {
    return this.providers.get(id);
  }

  list(): WikiSourceMeta[] {
    return Array.from(this.providers.values()).map(toMeta);
  }

  /**
   * Build the fetch context: combine the deployment-configured service endpoint + the passed-in credential into a SourceContext.
   *
   * The endpoint config name is declared by the provider (`endpointEnvSuffix`, default `MCP_URL`),
   * so it applies to both MCP-style and REST-style platforms; the registry assumes no specific protocol.
   *
   * No endpoint configured → throw (intranet infrastructure must be configured explicitly, no built-in default).
   */
  contextFor(
    id: string,
    secret: string,
    username?: string,
  ): { provider: WikiSourceProvider; ctx: SourceContext } {
    const provider = this.get(id);
    if (!provider) throw new Error(`wiki source provider '${id}' is not registered`);
    const suffix = provider.endpointEnvSuffix ?? DEFAULT_ENDPOINT_SUFFIX;
    const key = envKey(id, suffix);
    const endpoint = env(key);
    if (!endpoint) {
      throw new Error(
        `missing ${key}: endpoint must be configured explicitly (declared by provider '${id}')`,
      );
    }
    return {
      provider,
      ctx: { secret, username, endpoint },
    };
  }
}
