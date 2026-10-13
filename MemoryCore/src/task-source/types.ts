/**
 * Abstract types for Task external sources (third-party requirement / task management systems).
 *
 * Corresponds to the design doc MemoryPanel/docs/design/2026-09-15-external-task-import.md section 3.1.
 *
 * Design points:
 *   - The provider does not read the database or care about authentication: the token is injected by the caller (Panel) via TaskSourceContext,
 *     so the provider stays purely functional, easy to unit test and reuse.
 *   - Only three methods are exposed, matching three real interactions: pick a project, browse and select, fetch details.
 *   - Platform differences (title field name, how URLs are obtained, search parameter names) are consolidated by each provider's internal mapper,
 *     so upper layers contain no branches such as `if (itemType === 'bug')`.
 *
 * All internal service addresses come from deployment config; this file embeds no domain names (missing -> fail-fast).
 */

/** External work item type (TAPD: story / task / bug). */
export interface TaskSourceItemType {
  id: string;
  label: string;
}

/**
 * Authentication: **all are long-lived tokens entered manually by the user** (no OAuth).
 *
 * Only used to describe to the frontend "what to fill in and which header the token goes into"; the provider itself does not handle authentication:
 *   - bearer: the token goes into `Authorization: Bearer`
 *   - custom: the token goes into the header named by headerName
 *
 * The **concrete token format is defined by the source system**; its prefix or length is not described here --
 * that is an authentication detail on the source side, and writing it here would bake the internal token shape into code.
 * Which kind of token is needed and where to apply for it is guided by the "How do I get a token?" link (see tokenUrlEnv).
 *
 * `tokenUrlEnv`: which env to read the **application/view page** address of this kind of token from.
 *
 * The several token kinds of one source are often issued by **different systems** (with different site domains),
 * so the address hangs on **each auth scheme** rather than being a single provider-level value.
 *
 * This env name is **global** (e.g. `TAI_PAT_URL`) and is not prefixed per source --
 * because the same token page is often shared by multiple sources (iWiki and TAPD both use the Taihu PAT page),
 * and a global name is what makes "change one place, take effect everywhere" work; no domain is embedded in code.
 * If not configured, that scheme shows no guidance link.
 */
export type AuthScheme =
  | { kind: "bearer"; label: string; tokenUrlEnv?: string }
  | { kind: "basic"; label: string; tokenUrlEnv?: string }
  | { kind: "custom"; headerName: string; label: string; tokenUrlEnv?: string };

/**
 * The token entered by the user.
 *
 * **Not persisted to the business database**: submitted by the frontend at import / sync time and injected into Core via Panel,
 * and no longer held once the request ends (the Panel side may briefly cache it within a session to avoid re-entering it within the same step).
 */
export interface SourceCredential {
  kind: "bearer" | "basic" | "custom";
  /** Token in plaintext. Exists only in process memory and session storage, never persisted to the business database. */
  secret: string;
  /** Only used by basic. */
  username?: string;
  /** Additional information such as a custom header name. */
  extra?: Record<string, unknown>;
}

/** Fetch context: the token and endpoints are injected through here. */
export interface TaskSourceContext {
  cred: SourceCredential;
  /**
   * Service endpoint, from deployment config; no built-in default.
   *
   * What is read is the **first** config item declared in the provider's `requiredEnv` --
   * the generic layer does not know whether it is called MCP_URL or API_URL; it just takes the "primary endpoint" in order,
   * and the provider interprets its concrete meaning itself (see registry.contextFor).
   */
  endpoint: string;
  /**
   * Site root, used to build detail page URLs; from deployment config; no built-in default.
   * Whether it is needed is declared by the provider's `requiredEnv` -- sources that use REST and whose detail link is
   * returned directly by the API do not need it and must not be forced to configure it.
   */
  siteBaseUrl: string;
  timeoutMs?: number;
}

/** Workspace (TAPD project). */
export interface TaskWorkspace {
  id: string;
  name: string;
}

/** External work item list view. */
export interface RemoteTaskRef {
  /** Platform-unique id. */
  externalId: string;
  /** Work item type, determines which branch fetchTask takes afterwards. */
  itemType: string;
  title: string;
  /** Detail page URL, stored into source_url on import. */
  url?: string;
  status?: string;
  updatedAt?: string;
  /**
   * Handler account name (TAPD's owner / current_owner).
   * Used to backfill "participating Users" on import; ignored when it cannot be mapped to a Panel user, without blocking the import.
   */
  owner?: string;
  /** Composite locator key (TAPD workspace_id). Not persisted, passed at request level only. */
  scope?: string;
}

export interface RemoteTaskDetail extends RemoteTaskRef {
  /** Body, stored into description on import. */
  body: string;
  fidelity: "lossless" | "lossy";
  warnings?: string[];
}

export interface ListCandidatesQuery {
  scope?: string;
  itemTypes?: readonly string[];
  keyword?: string;
  owner?: string;
  status?: string;
  page?: number;
  limit?: number;
  /**
   * Only show "my todos".
   *
   * Whether it is supported is declared by the provider's `capabilities.todo`; sources that do not support it **ignore** this parameter.
   * Note it is a **source-specific capability** rather than a generic filter: different systems have different semantics
   * (TAPD uses user_todo_*_get, and does not support keyword / handler / status / server-side pagination).
   */
  onlyTodo?: boolean;
}

export interface CandidatePage {
  items: RemoteTaskRef[];
  /** Total returned by the platform, used for "N in total". */
  total: number;
  hasMore: boolean;
}

export interface TaskSourceProvider {
  readonly id: string;
  /** Supported work item types, drives the frontend tabs. */
  readonly itemTypes: readonly TaskSourceItemType[];
  /** Per-batch import limit. */
  readonly maxBatchSize: number;
  /** Whether a workspace-level locator is needed. */
  readonly needsWorkspace: boolean;
  /** Auth schemes, drive whether the frontend renders an authorize button or a token input box. */
  readonly authSchemes: readonly AuthScheme[];
  /**
   * Capabilities the source **optionally supports**, driving whether the frontend shows the corresponding switch.
   * For undeclared capabilities the frontend hides the entry, and the backend ignores the parameter when it receives it.
   */
  readonly capabilities?: { todo?: boolean };
  /**
   * Deployment config items **required** for the provider to run (env name suffix, without the `TASK_SOURCE_<ID>_` prefix).
   *
   * The provider declares what it needs itself and the registry only validates against the declaration -- so the generic layer need not know
   * differences such as "MCP-type sources need MCP_URL" and "REST-type sources need API_URL".
   * A new source decides which configs it needs by itself, with zero changes to the generic layer.
   */
  readonly requiredEnv: readonly string[];

  listWorkspaces(ctx: TaskSourceContext): Promise<TaskWorkspace[]>;
  listCandidates(ctx: TaskSourceContext, q: ListCandidatesQuery): Promise<CandidatePage>;
  fetchTask(
    ctx: TaskSourceContext,
    externalId: string,
    scope: string,
    itemType: string,
  ): Promise<RemoteTaskDetail>;
}

/** Business exception thrown by a provider. */
export class TaskSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskSourceError";
  }
}
