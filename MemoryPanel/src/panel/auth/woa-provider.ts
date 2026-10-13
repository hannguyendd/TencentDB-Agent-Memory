import { createHash, timingSafeEqual } from 'node:crypto';
import { compactDecrypt } from 'jose';
import type { HeaderInjectedProvider, ExternalIdentity } from './types.js';

interface TaiIdentity {
  loginname?: string;
  LoginName?: string;
  staffid?: number | string;
  StaffId?: number | string;
  staffname?: string;
  StaffName?: string;
  chinesename?: string;
  chineseName?: string;
  deptid?: number | string;
  DeptId?: number | string;
  deptname?: string;
  DeptName?: string;
  expiration?: string;
  Expiration?: string;
  [key: string]: unknown;
}

export interface WoaProviderConfig {
  enabled: boolean;
  appToken: string;
  safeMode: boolean;
  requireSignature: boolean;
  appUrl: string;
  loginUrl: string;
  logoutUrl: string;
  paasId: string;
  /**
   * Domain identifier written to Core `meta_users.auth_provider` (aligned with `PanelAuthConfig.woa.authProvider`).
   * The same value is used for account creation and lookup; the Service layer injects it from config when constructing the Provider.
   * Compatibility: if an old caller does not pass it, it is treated as 'local' (aligned with the Core default); behavior is equivalent.
   */
  authProvider?: string;
}

function validAppToken(token: string): boolean {
  return Buffer.byteLength(token, 'utf8') === 32;
}

export class WoaProvider implements HeaderInjectedProvider {
  readonly id = 'woa';
  readonly type = 'woa' as const;
  readonly kind = 'header-injected' as const;
  readonly displayName = 'WOA / iOA';
  readonly authProviderDomain: string;
  /**
   * Name of the request header through which the upstream gateway injects identity.
   *
   * Hard-coded literal (no default fallback): this is the fixed protocol header of the WOA/iOA gateway;
   * a different protocol means a different Provider class, not turning it into configuration.
   */
  readonly ingressHeaderName = 'x-tai-identity';

  constructor(private readonly config: WoaProviderConfig) {
    if (config.enabled && !validAppToken(config.appToken)) {
      throw new Error('PANEL_AUTH_WOA_APP_TOKEN must be exactly 32 UTF-8 bytes when WOA auth is enabled');
    }
    if (config.enabled && !config.appUrl) {
      throw new Error('PANEL_AUTH_WOA_APP_URL is required when WOA auth is enabled');
    }
    if (config.enabled) {
      // APP_URL is the external address of **our** panel (WOA redirects back here after auth), not the WOA site,
      // so the "WOA only registers https" constraint does not apply: http is legitimate for intranet/local deployments.
      // We only validate that it must be an absolute URL -- WOA needs to redirect the browser back, and a relative path cannot be redirected to.
      try {
        new URL(config.appUrl);
      } catch {
        throw new Error('PANEL_AUTH_WOA_APP_URL must be a valid absolute URL');
      }
    }
    this.authProviderDomain = config.authProvider?.trim() || 'local';
  }

  /**
   * Entry point of the `HeaderInjectedProvider` contract.
   *
   * Keeps `authenticate` as an equivalent alias (for old tests/compat); both share the same implementation internally.
   */
  async authenticateFromHeaders(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null> {
    return this.doAuthenticate(headers);
  }

  /** @deprecated Use `authenticateFromHeaders`. Kept for compatibility with existing tests and call sites. */
  async authenticate(headers: Record<string, string | undefined>): Promise<ExternalIdentity | null> {
    return this.doAuthenticate(headers);
  }

  private async doAuthenticate(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null> {
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const identityHeader = normalized[this.ingressHeaderName];
    let identity: TaiIdentity | null = null;
    if (identityHeader) {
      const signature = normalized.signature;
      if ((!signature && this.config.requireSignature) || (signature && !this.verifySignature(normalized))) {
        return null;
      }
      identity = await this.decryptIdentity(identityHeader);
    }
    if (!identity && !this.config.safeMode) identity = this.readPlainIdentity(normalized);
    if (!identity) return null;

    const loginName = this.stringValue(identity.loginname ?? identity.LoginName);
    const staffId = this.stringValue(identity.staffid ?? identity.StaffId);
    const subject = staffId || loginName;
    if (!subject) return null;
    return {
      providerId: this.id,
      subject,
      loginName: loginName || subject,
      displayName: this.stringValue(identity.chinesename ?? identity.chineseName ?? identity.staffname ?? identity.StaffName),
      staffId,
      departmentId: this.stringValue(identity.deptid ?? identity.DeptId),
      departmentName: this.stringValue(identity.deptname ?? identity.DeptName),
      claims: identity,
    };
  }

  /**
   * Get a URL that must be supplied by configuration.
   *
   * No built-in default: WOA login/logout URLs are intranet infrastructure information; hard-coding them into source is an information exposure,
   * and also turns "forgot to configure" into a silent error (redirecting to a wrong address with no error at all, very hard to debug).
   * Throw explicitly so a missing configuration surfaces immediately at startup / when building the link.
   */
  private requiredUrl(value: string, envKey: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
      throw new Error(`${envKey} is required when WOA auth is enabled (no built-in default)`);
    }
    try {
      new URL(trimmed);
    } catch {
      throw new Error(`${envKey} must be a valid absolute URL`);
    }
    return trimmed;
  }

  buildLoginUrl(callbackUrl: string): string {
    const base = this.requiredUrl(this.config.loginUrl, 'PANEL_AUTH_WOA_LOGIN_URL');
    const query = [`oauth=true`, `url=${encodeURIComponent(callbackUrl)}`];
    if (this.config.paasId) query.push(`appkey=${encodeURIComponent(this.config.paasId)}`);
    return `${base}${base.includes('?') ? '&' : '?'}${query.join('&')}`;
  }

  buildLogoutUrl(returnTo: string): string {
    const base = this.requiredUrl(this.config.logoutUrl, 'PANEL_AUTH_WOA_LOGOUT_URL');
    const query = ['oauth=true'];
    if (this.config.paasId) query.push(`appkey=${encodeURIComponent(this.config.paasId)}`);
    query.push(`url=${encodeURIComponent(returnTo)}`);
    return `${base}${base.includes('?') ? '&' : '?'}${query.join('&')}`;
  }

  private async decryptIdentity(header: string): Promise<TaiIdentity | null> {
    try {
      const { plaintext } = await compactDecrypt(header, Buffer.from(this.config.appToken, 'utf8'));
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const identity = parsed as TaiIdentity;
      const expiration = identity.expiration ?? identity.Expiration;
      if (expiration) {
        const expiry = Date.parse(expiration);
        if (!Number.isFinite(expiry) || expiry < Date.now() - 5 * 60 * 1000) return null;
      }
      return identity;
    } catch {
      return null;
    }
  }

  private verifySignature(headers: Record<string, string | undefined>): boolean {
    const timestamp = headers.timestamp;
    const signature = headers.signature;
    if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
    const timestampNumber = Number(timestamp);
    if (!Number.isSafeInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 180) {
      return false;
    }
    const extHeaders = this.config.safeMode
      ? [headers['x-rio-seq'] ?? '', '', '', '']
      : [headers['x-rio-seq'] ?? '', headers.staffid ?? '', headers.staffname ?? '', headers['x-ext-data'] ?? ''];
    const source = `${timestamp}${this.config.appToken}${extHeaders.join(',')}${timestamp}`;
    const expected = createHash('sha256').update(source).digest('hex').toUpperCase();
    const actual = signature.toUpperCase();
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  }

  private readPlainIdentity(headers: Record<string, string | undefined>): TaiIdentity | null {
    const staffId = headers.staffid;
    const staffName = headers.staffname;
    if (!staffId && !staffName) return null;
    return { staffid: staffId, staffname: staffName, loginname: staffName || staffId };
  }

  private stringValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text || undefined;
  }
}

