import type { Context } from 'hono';

export type AuthMethod = 'user_key' | 'idp';
export type ProviderType = 'woa' | 'oidc' | 'oauth2';

/**
 * How a Provider interacts with the Panel.
 *
 * - `header-injected`: the upstream gateway performs SSO on our behalf and writes the identity into request headers on redirect back.
 *   Typical: WOA / iOA / TOF. The Provider only needs to implement `authenticateFromHeaders`.
 * - `redirect-oauth2`: we generate the authorize URL, the user's browser calls back with a code,
 *   we exchange the code for a token and then fetch userinfo. Typical: GitHub / self-hosted OIDC.
 *   The Provider must implement `prepareAuthorize` + `authenticateFromCallback` (not landed in this PR).
 *
 * A single field narrows the capability kind; the Service decides which path to take by narrowing on `kind`,
 * avoiding hard branching on provider id inside the Service.
 */
export type ProviderKind = 'header-injected' | 'redirect-oauth2';

export interface ExternalIdentity {
  providerId: string;
  subject: string;
  loginName: string;
  displayName?: string;
  email?: string;
  staffId?: string;
  departmentId?: string;
  departmentName?: string;
  claims: Record<string, unknown>;
}

export interface PanelAuthContext {
  method: AuthMethod;
  instanceId: string;
  userId?: string;
  userKey?: string;
  providerId?: string;
  externalSubject?: string;
}

/**
 * Minimal contract shared by all IdP Providers.
 *
 * A Provider is **only** responsible for converting "external protocol -> internal unified `ExternalIdentity`"
 * and is unaware of:
 *   - Core meta API (`user/create`, `user/find-by-external`, etc. are orchestrated by the Service)
 *   - Panel Session / Cookie / Pending flows (Service side)
 *   - Instance Registry (Service side)
 *
 * The concrete entry point producing the identity is given by the sub-interfaces (header-injected / redirect-oauth2).
 */
export interface AuthProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly kind: ProviderKind;
  /**
   * Display name in the frontend login menu. May be read at runtime, replacing the hard-coded `'WOA / iOA'`.
   * Separate from `id`: id is a stable key for routing/storage, while displayName can be localized per deployment.
   */
  readonly displayName: string;
  /**
   * External domain identifier written to Core `meta_users.auth_provider`.
   * Together with `external_id` it forms the account lookup key; each Provider has exactly one domain.
   */
  readonly authProviderDomain: string;
  buildLoginUrl(callbackUrl: string): string;
  buildLogoutUrl(returnTo: string): string;
}

/**
 * Provider for the gateway-injected-header mode (WOA / iOA / TOF).
 *
 * Characteristic: the ingress middleware identifies ownership by `ingressHeaderName`; on a match it calls
 * `authenticateFromHeaders` to normalize into `ExternalIdentity`.
 */
export interface HeaderInjectedProvider extends AuthProvider {
  readonly kind: 'header-injected';
  /** The ingress middleware identifies request ownership by this header name, e.g. 'x-tai-identity'. **No built-in default**. */
  readonly ingressHeaderName: string;
  authenticateFromHeaders(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null>;
}

/**
 * Provider for the OAuth2 / OIDC mode (implementation not landed in this PR; the interface is reserved first).
 *
 * Characteristic: we generate the authorize URL via `prepareAuthorize`; when the user's browser returns to the callback
 * with code + state, the Service calls `authenticateFromCallback` to exchange for token + userinfo.
 *
 * See `MemoryPanel/docs/design/2026-09-07-auth-provider-abstraction.md` section 6.
 */
export interface RedirectOAuth2Provider extends AuthProvider {
  readonly kind: 'redirect-oauth2';
  prepareAuthorize(input: {
    state: string;
    redirectUri: string;
    nonce?: string;
  }): Promise<{ url: string; codeVerifier?: string }>;
  authenticateFromCallback(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    expectedNonce?: string;
  }): Promise<ExternalIdentity | null>;
}

export interface AuthRouteContext {
  request: Context;
  instanceId: string;
  returnTo: string;
}

