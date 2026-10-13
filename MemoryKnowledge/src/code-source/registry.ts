/**
 * CodeSourceRegistry -- provider registry.
 *
 * Responsibilities:
 *   1. Pick the enabled ones from the built-in provider set according to `CODE_SOURCE_ENABLED`
 *   2. Provide `get(id)` so the business layer can obtain a provider instance
 *   3. Provide `list()` to generate the metadata driving the frontend dropdown + form (including the auth method's form field list)
 *
 * **The registry is unaware of any concrete platform or auth method** -- both live only in their own directories.
 *
 * Deployment config:
 *   CODE_SOURCE_ENABLED=<id1>,<id2>
 *   CODE_SOURCE_<UPPER_ID>_SITE_BASE_URL=...
 */

import { BUILTIN_PROVIDERS } from "./providers/index.js";
import type { CodeSourceMeta, ICodeSourceProvider } from "./types.js";
import { bearerAuthMethod } from "./auth-methods/bearer.js";

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function envKey(id: string, suffix: string): string {
  return `CODE_SOURCE_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function joinSitePath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function enabledIds(): string[] {
  const raw = env("CODE_SOURCE_ENABLED");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Generate the frontend form-driving metadata from the provider + deployment config.
 *
 * Token page URL = site root from deployment config + the provider's built-in in-site path.
 * Site root not configured -> the "How do I get a token?" entry is not shown.
 */
function toMeta(provider: ICodeSourceProvider): CodeSourceMeta {
  const siteBase = env(envKey(provider.id, "SITE_BASE_URL"));
  const tokenPath = provider.sitePaths.tokenDoc;
  const tokenDocUrl =
    siteBase && tokenPath ? joinSitePath(siteBase, tokenPath) : siteBase ?? undefined;
  return {
    id: provider.id,
    auth_method: provider.authMethod.kind,
    form_fields: provider.authMethod.formFields,
    token_doc_url: tokenDocUrl,
  };
}

export class CodeSourceRegistry {
  private readonly providers = new Map<string, ICodeSourceProvider>();

  /**
   * @param ids Explicit enabled list (for test injection); omitted -> read from `CODE_SOURCE_ENABLED`
   * @param builtins Built-in providers (for test injection); omitted -> use BUILTIN_PROVIDERS
   */
  constructor(ids?: string[], builtins: readonly ICodeSourceProvider[] = BUILTIN_PROVIDERS) {
    const enabledSet = new Set(ids ?? enabledIds());
    for (const p of builtins) {
      if (enabledSet.has(p.id)) this.providers.set(p.id, p);
    }
    // Declared enabled but not built in -> placeholder (bearer by default; register() must supply the real implementation)
    for (const id of enabledSet) {
      if (!this.providers.has(id)) {
        this.providers.set(id, {
          id,
          authMethod: bearerAuthMethod,
          sitePaths: {},
        });
      }
    }
  }

  register(provider: ICodeSourceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ICodeSourceProvider | undefined {
    return this.providers.get(id);
  }

  list(): CodeSourceMeta[] {
    return Array.from(this.providers.values()).map(toMeta);
  }
}
