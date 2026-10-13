import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LogLevel } from '../infra/logger.js';

loadDotenv();

function env(key: string, fallback: string): string {
  // An empty string is treated as unset: .env often has `PANEL_AUTH_WOA_LOGIN_URL=` (placeholder / left blank),
  // and with ?? semantics the empty string would count as a valid value, emptying the URL and silently breaking the WOA redirect.
  // Uniformly treat "blank means use the default" so empty placeholders in .env.example can be safely kept.
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Optional ClickHouse API call audit config. Fully skipped silently when enabled=false or url is empty. */
export interface PanelClickHouseConfig {
  enabled: boolean;
  url: string;
  database: string;
  table: string;
  user: string;
  password: string;
  flushIntervalMs: number;
  flushThreshold: number;
  ttlDays: number;
  requestTimeoutMs: number;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function envFirst(keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') return value;
  }
  return fallback;
}

function envBoolFirst(keys: string[], fallback: boolean): boolean {
  const raw = envFirst(keys, '');
  return raw === '' ? fallback : raw === 'true' || raw === '1';
}

/**
 * Resolve the Panel session / encryption key (**generated internally, external configuration not accepted**):
 * 1. Prefer reading from the persisted file (same directory as the identity binding, same lifecycle);
 * 2. If the file does not exist, generate a random strong key and write it (mode 0600); reuse it on later restarts.
 *
 * No env var entry such as PANEL_AUTH_SESSION_SECRET is provided: once the key can be specified externally,
 * it might be written into .env and committed to the repo. Internal generation guarantees it only exists as a 0600 file.
 * Stable across restarts / repeated starts (changing the key would make stored identity bindings undecryptable).
 */
function resolveSessionSecret(identityStorePath: string): string {
  const secretPath = env('PANEL_AUTH_SESSION_SECRET_FILE', join(dirname(identityStorePath), 'panel-session-secret'));
  try {
    if (existsSync(secretPath)) {
      const existing = readFileSync(secretPath, 'utf8').trim();
      if (existing) return existing;
    }
  } catch (err) {
    throw new Error(`failed to read session secret file at ${secretPath}: ${(err as Error).message}`);
  }

  const generated = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw new Error(`failed to persist auto-generated session secret at ${secretPath}: ${(err as Error).message}`);
  }
  return generated;
}

export interface PanelConfig {
  server: { host: string; port: number };
  metadataInstancesConfig: string;
  metadataRemoteTimeoutMs: number;
  ui: { distDir: string };
  log: { level: LogLevel; format: 'json' | 'pretty' };
  /** Knowledge Service (KS :8421) connection config. serviceId is injected per request instanceId. */
  knowledge: { baseUrl: string; authToken: string; timeoutMs: number };
  /**
   * At startup, ensure a knowledge-service LLM binding for each instance (billed via the proxy).
   * Fully skipped when sync=false (existing deployment behavior unchanged).
   */
  knowledgeLlmBinding: {
    sync: boolean;
    proxyBaseUrl: string;
  };
  /** Root directory for local storage of default Agent template files (stored locally in Panel, as {dir}/{instanceId}/{team_id}/template.json). */
  agentTemplateDir: string;
  /**
   * "Observability" feature switch (env PANEL_FEATURE_ANALYTICS_ENABLED).
   *
   * The observability page (online call stats) depends on kernel-side ClickHouse instrumentation. A deployment without CH configured would only
   * get "not configured / unreachable" on that page, so the entry is hidden by default; the deployer
   * enables it explicitly only when analytics ClickHouse is actually connected. This value is sent to the frontend via the capabilities of GET /meta/instances
   * to control menu/route visibility.
   */
  featureAnalyticsEnabled: boolean;
  /** Optional ClickHouse API call audit. When not configured, nothing is reported (fully silent). */
  clickhouse: PanelClickHouseConfig;
  auth: PanelAuthConfig;
}

export interface PanelAuthConfig {
  userKeyEnabled: boolean;
  idpEnabled: boolean;
  sessionTtlSeconds: number;
  sessionCookieName: string;
  sessionSecure: boolean;
  sessionSecret: string;
  identityStorePath: string;
  woa: {
    enabled: boolean;
    appToken: string;
    safeMode: boolean;
    requireSignature: boolean;
    appUrl: string;
    loginUrl: string;
    logoutUrl: string;
    paasId: string;
    defaultTeamId: string;
    defaultRole: string;
    /**
     * External realm identifier written to core `meta_users.auth_provider`.
     *
     * Writes (create account / bind) and reads (find-by-external) use the same value so they land in the same realm;
     * if the two sides disagree, it silently fails as "written to realm A, looked up in realm B".
     * Default 'local' aligns with Core's DEFAULT_AUTH_PROVIDER (consistent with zero configuration).
     */
    authProvider: string;
  };
  /**
   * Third-party source for the task board "Import Task".
   *
   * All addresses and client identifiers **come entirely from configuration, with no built-in defaults**: they are internal infrastructure details,
   * and hardcoding them in source both exposes information and turns a missing config into a silent error of "jumping to the wrong address with no error".
   * When missing, the point of use throws explicitly (fail-fast).
   */
  taskSource: {
    /** Enabled source ids (comma-separated). Empty -> the panel hides the "Import Task" entry. */
    enabled: string[];
    tapd: {
      /** MCP resource address (Core-side endpoint). */
      mcpUrl: string;
      /** Site root: used to build detail page URLs (the task API does not return detail_link). */
      siteBaseUrl: string;
    };
  };
}

function buildAuthConfig(): PanelAuthConfig {
  const modeRaw = env('PANEL_AUTH_MODE', '').trim();
  const legacyUserKey = envBoolFirst(['PANEL_AUTH_USER_KEY_ENABLED'], true);
  const legacyIdp = envBoolFirst(['PANEL_AUTH_IDP_ENABLED'], false);
  const legacyWoa = envBoolFirst(['PANEL_AUTH_IDP_WOA_ENABLED'], false);
  const modes = new Set(
    (modeRaw || (legacyIdp || legacyWoa ? 'user_key,woa' : legacyUserKey ? 'user_key' : ''))
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  let userKeyEnabled = modes.has('user_key');
  const woaEnabled = modes.has('woa');
  const idpEnabled = woaEnabled || modes.has('idp');
  // Config robustness: user_key is the zero-config default login method.
  // If after parsing there is neither user_key nor any IdP (e.g. PANEL_AUTH_MODE set to an unrecognized value,
  // or a missing config after a future removal of legacy variables), fall back to "enable user_key"
  // rather than failing service startup. This makes "works as before WOA development when WOA is off" a strong invariant.
  if (!userKeyEnabled && !idpEnabled) {
    userKeyEnabled = true;
  }
  const appUrl = envFirst(['PANEL_AUTH_WOA_APP_URL', 'PANEL_AUTH_IDP_WOA_APP_URL'], '');
  const identityStorePath = env('PANEL_AUTH_IDENTITY_STORE_PATH', './data/panel-auth-identities.json');

  return {
    userKeyEnabled,
    idpEnabled,
    sessionTtlSeconds: envInt('PANEL_AUTH_SESSION_TTL_SECONDS', 28_800),
    sessionCookieName: env('PANEL_AUTH_SESSION_COOKIE_NAME', 'tdai_idp_session'),
    sessionSecure: envBoolFirst(['PANEL_AUTH_SESSION_SECURE'], appUrl.startsWith('https://')),
    // The secret is only needed when an IdP is enabled; left blank otherwise, to avoid non-WOA deployments generating a key file.
    sessionSecret: idpEnabled ? resolveSessionSecret(identityStorePath) : '',
    identityStorePath,
    woa: {
      enabled: woaEnabled,
      appToken: envFirst(['PANEL_AUTH_WOA_APP_TOKEN', 'PANEL_AUTH_IDP_WOA_APP_TOKEN'], ''),
      safeMode: envBoolFirst(['PANEL_AUTH_WOA_SAFE_MODE', 'PANEL_AUTH_IDP_WOA_SAFE_MODE'], true),
      requireSignature: envBoolFirst(['PANEL_AUTH_WOA_REQUIRE_SIGNATURE', 'PANEL_AUTH_IDP_WOA_REQUIRE_SIGNATURE'], true),
      appUrl,
      // No built-in defaults; must be configured explicitly: these two addresses are internal infrastructure details, and hardcoding them in source both
      // exposes information and turns a missing config into a silent error (jumping to the wrong address with no error).
      // When missing, WoaProvider.requiredUrl throws explicitly at the point of use.
      loginUrl: env('PANEL_AUTH_WOA_LOGIN_URL', ''),
      logoutUrl: env('PANEL_AUTH_WOA_LOGOUT_URL', ''),
      paasId: envFirst(['PANEL_AUTH_WOA_PAAS_ID', 'PANEL_AUTH_IDP_WOA_PAAS_ID'], ''),
      defaultTeamId: envFirst(['PANEL_AUTH_WOA_DEFAULT_TEAM_ID', 'PANEL_AUTH_IDP_WOA_DEFAULT_TEAM_ID'], ''),
      defaultRole: env('PANEL_AUTH_WOA_DEFAULT_ROLE', 'member'),
      // Same name and meaning as Core's METADATA_EXTERNAL_AUTH_PROVIDER: at deploy time, setting both sides to the same
      // value is enough (when unset on the Core side it falls back to 'local', matching this default; aligned with zero configuration).
      authProvider: envFirst(
        ['METADATA_EXTERNAL_AUTH_PROVIDER', 'PANEL_AUTH_WOA_AUTH_PROVIDER'],
        'local',
      ),
    },
    taskSource: {
      enabled: env('TASK_SOURCE_ENABLED', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      tapd: {
        mcpUrl: env('TASK_SOURCE_TAPD_MCP_URL', ''),
        siteBaseUrl: env('TASK_SOURCE_TAPD_SITE_BASE_URL', ''),
      },
    },
  };
}

export function loadPanelConfig(): PanelConfig {
  const level = env('LOG_LEVEL', 'info') as LogLevel;
  const format = env('LOG_FORMAT', 'json') as 'json' | 'pretty';
  return {
    server: {
      host: env('HOST', '0.0.0.0'),
      port: envInt('PORT', 8123),
    },
    metadataInstancesConfig: env('METADATA_INSTANCES_CONFIG', './config/metadata-instances.json'),
    metadataRemoteTimeoutMs: envInt('METADATA_REMOTE_TIMEOUT_MS', 15_000),
    ui: { distDir: env('UI_DIST_DIR', './web/dist') },
    log: {
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      format: format === 'pretty' ? 'pretty' : 'json',
    },
    knowledge: {
      baseUrl: env('KNOWLEDGE_SERVICE_URL', 'http://127.0.0.1:8421'),
      authToken: env('KNOWLEDGE_AUTH_TOKEN', ''),
      timeoutMs: envInt('KNOWLEDGE_TIMEOUT_MS', 15_000),
    },
    knowledgeLlmBinding: {
      sync: envBool('KNOWLEDGE_LLM_BINDING_SYNC', true),
      proxyBaseUrl: env('KNOWLEDGE_LLM_PROXY_BASE_URL', 'http://127.0.0.1:8096'),
    },
    agentTemplateDir: env('TDAI_AGENT_TEMPLATE_DIR', './data/agent-templates'),
    // Off by default (conservative): the observability page depends on kernel ClickHouse instrumentation; deployments without it do not show the entry.
    featureAnalyticsEnabled: envBool('PANEL_FEATURE_ANALYTICS_ENABLED', false),
    clickhouse: {
      enabled: envBool('PANEL_CLICKHOUSE_ENABLED', false),
      url: env('PANEL_CLICKHOUSE_URL', ''),
      database: env('PANEL_CLICKHOUSE_DATABASE', 'default'),
      table: env('PANEL_CLICKHOUSE_TABLE', 'panel_api_call_logs'),
      user: env('PANEL_CLICKHOUSE_USER', 'default'),
      password: env('PANEL_CLICKHOUSE_PASSWORD', ''),
      flushIntervalMs: envInt('PANEL_CLICKHOUSE_FLUSH_INTERVAL_MS', 5000),
      flushThreshold: envInt('PANEL_CLICKHOUSE_FLUSH_THRESHOLD', 50),
      ttlDays: envInt('PANEL_CLICKHOUSE_TTL_DAYS', 90),
      requestTimeoutMs: envInt('PANEL_CLICKHOUSE_REQUEST_TIMEOUT_MS', 5000),
    },
    auth: buildAuthConfig(),
  };
}
