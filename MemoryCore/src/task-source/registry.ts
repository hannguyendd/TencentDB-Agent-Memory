/**
 * Task external source registry.
 *
 * Corresponds to design doc sections 3.1 / 6. Isomorphic to the Knowledge-side WikiSourceRegistry:
 *   - The enabled list comes from TASK_SOURCE_ENABLED (comma-separated provider ids)
 *   - Intranet addresses such as endpoints always come from deployment config, with **no built-in defaults**
 *   - Missing config -> explicit throw when building the context (fail-fast), no silent degradation
 *
 * No intranet domain appears in the code; it only shows up in config comments/examples.
 */

import { tapdProvider } from "./providers/tapd/index.js";
import {
  TaskSourceError,
  type AuthScheme,
  type SourceCredential,
  type TaskSourceContext,
  type TaskSourceItemType,
  type TaskSourceProvider,
} from "./types.js";

/**
 * Auth scheme + the address of its token application page (external, snake_case).
 *
 * Same convention as the `token_doc_url` of Knowledge-side wiki/code sources:
 * the address comes from deployment config, and is null when not configured (the frontend then hides the guidance link).
 */
export interface AuthSchemeMeta extends Omit<AuthScheme, "tokenUrlEnv"> {
  token_doc_url: string | null;
}

/** Source metadata exposed externally (without any credentials or internal endpoints). */
export interface TaskSourceMeta {
  id: string;
  item_types: readonly TaskSourceItemType[];
  max_batch_size: number;
  needs_workspace: boolean;
  auth_schemes: readonly AuthSchemeMeta[];
  /** Supported capabilities; the frontend decides whether to show the corresponding switch accordingly (undeclared = unsupported). */
  capabilities: { todo: boolean };
}

const PROVIDERS: Record<string, TaskSourceProvider> = {
  tapd: tapdProvider,
};

/** Read an environment variable (trimmed; an empty string is treated as unset). */
function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function enabledIds(): string[] {
  return env("TASK_SOURCE_ENABLED")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Auth scheme -> external shape.
 *
 * `tokenUrlEnv` is an internal field name and is not exposed; it is replaced by `token_doc_url` carrying the actual address.
 * Not configured (or configured empty) -> null, and the frontend hides the "apply/view" link for that scheme accordingly.
 */
function toAuthSchemeMeta(scheme: AuthScheme): AuthSchemeMeta {
  const { tokenUrlEnv, ...rest } = scheme as AuthScheme & { tokenUrlEnv?: string };
  // tokenUrlEnv is a **global** env name (e.g. TAI_PAT_URL), not prefixed per source --
  // the same token page can be shared by multiple sources.
  const url = tokenUrlEnv ? env(tokenUrlEnv) : "";
  return { ...rest, token_doc_url: url || null };
}

/** List of enabled sources (for the frontend to render the "Import Task" dropdown). Returns an empty array when no source is enabled. */
export function list(): TaskSourceMeta[] {
  return enabledIds()
    .map((id) => PROVIDERS[id])
    .filter((p): p is TaskSourceProvider => Boolean(p))
    .map((p) => ({
      id: p.id,
      item_types: p.itemTypes,
      max_batch_size: p.maxBatchSize,
      needs_workspace: p.needsWorkspace,
      auth_schemes: p.authSchemes.map(toAuthSchemeMeta),
      capabilities: { todo: p.capabilities?.todo === true },
    }));
}

/** Get a provider; throws when not enabled or nonexistent (existence is not distinguished, to prevent probing). */
export function get(id: string): TaskSourceProvider {
  const provider = PROVIDERS[id];
  if (!provider || !enabledIds().includes(id)) {
    throw new TaskSourceError("task_source_not_found", `task source not available: ${id}`);
  }
  return provider;
}

/**
 * Assemble the provider call context.
 *
 * **Validated against the provider's own declared requiredEnv**; the generic layer presumes no specific config items --
 * otherwise the difference of "MCP-type sources need MCP_URL, REST-type sources need API_URL" would pin the generic layer down,
 * and adding a source would require coming back to change it here. Missing config throws: hardcoding intranet addresses is both information exposure
 * and would let a missed config degrade into a silent error of "jumping to a wrong address with no error".
 */
export function contextFor(id: string, cred: SourceCredential): TaskSourceContext {
  const upper = id.toUpperCase();
  const provider = PROVIDERS[id];
  for (const suffix of provider?.requiredEnv ?? []) {
    if (!env(`TASK_SOURCE_${upper}_${suffix}`)) {
      throw new TaskSourceError(
        "task_source_config_missing",
        `TASK_SOURCE_${upper}_${suffix} is not configured`,
      );
    }
  }
  /**
   * Primary endpoint = the **first** config item declared in requiredEnv.
   *
   * The generic layer does not presume what it is called (MCP_URL or API_URL is decided by the provider),
   * and just takes the first one in declaration order as the "primary endpoint" -- otherwise REST-type sources would get an empty string
   * because the generic layer hardcodes reading MCP_URL, while validation still passes (silent failure).
   */
  const primary = provider?.requiredEnv?.[0];
  return {
    cred,
    endpoint: primary ? (env(`TASK_SOURCE_${upper}_${primary}`) ?? "") : "",
    siteBaseUrl: env(`TASK_SOURCE_${upper}_SITE_BASE_URL`) ?? "",
  };
}

export const TaskSourceRegistry = { list, get, contextFor };
